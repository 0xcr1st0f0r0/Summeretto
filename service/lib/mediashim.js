// service/lib/mediashim.js — 「音频 → 占位视频」转封装（media shim）
//
// 背景（2026-10-16/17 实证，见 docs/stage2-robin-protocol.md §5.16 / §5.17）：
//   · 携带【独立音频附件】时，上游 Argon 路径读不到音频（模型答"没有收到录音文件"），
//     必须把档位退让到 `Lfzqy.#13`（降级 Flash-Lite）才"听得见"——这是上游硬限，已穷举无解。
//   · 而【视频】音轨不受此限：Argon 满血档位下能准确转录视频音轨（7 段实测全过，含图混搭）。
//   ⇒ 把音频包进一个 16×16 的极简视频（音频流 `-c:a copy` 零转码），即可绕过
//     "音频 × Argon 互斥"，让满血档位与听觉兼得。
//
// 成本（生产机实测）：每条 ~100ms（7 条合计 0.99s）、体积 +~0.4KB（音频零转码）；
//   mp4/AAC 等无法 copy 的容器自动回退 libopus 重编码（~0.45s/条）。
//
// 缓存：同一段音频（sha256 内容哈希）直接复用转换结果 —— 多轮对话里历史音频会被
//   反复回传（Eidolon 每轮回放最近 6 条），命中率极高（首轮转换后几乎全命中）。
//
// 失败语义：ffmpeg 缺失 / 转换失败 / 超时 ⇒ 单条【静默回退】（保持原音频附件，
//   行为与旧版一致：档位退让换听觉）。绝不因转封装失败而让请求失败。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

/** 缓存键版本：转换配方变化时递增（旧条目自然失效）。
 *  v2 = 占位视频帧率 1 → 0.25 fps（省约76% 视频 token，见 PLACEHOLDER_FPS）。
 *        必须升版，否则重启后会命中 v1 时期 1fps 的旧产物，降帧不生效。
 */
const SHIM_VERSION = "v2";
/** 转换产物 mime（Lgbkr.#4 由 fileSourceOf 按 mime 推为 VIDEO=6） */
export const OUT_MIME = "video/webm";

/** ffmpeg 探测缓存：null=未探测 / true / false；false 时 5 分钟后允许重探（可能在装机后被安装） */
const REPROBE_MS = 5 * 60_000;

const state = {
  cache: new Map(), // key → { buffer, mime, bytes }（Map 保序 = LRU：命中后 delete+set）
  bytes: 0,
  inflight: new Map(), // key → Promise（同内容并发只转一次）
  queue: [],
  running: 0,
  ffmpeg: null,
  ffmpegBin: null,
  ffmpegProbedAt: 0,
  tmpSeq: 0,
  stats: { converted: 0, failed: 0, cacheHits: 0, deduped: 0, evictedItems: 0, evictedBytes: 0, lastMs: null, totalMs: 0 },
};

/* ── 测试注入（生产路径永不使用）── */
let converterOverride = null;
let enabledOverride = null;
let cacheBytesOverride = null;
let cacheItemsOverride = null;

export function shimEnabled() {
  return enabledOverride ?? config.robinMediaShim;
}

export function __setConverterForTest(fn) {
  converterOverride = fn;
}
export function __setShimEnabledForTest(v) {
  enabledOverride = v;
}
export function __setShimCacheLimitForTest(bytes, items) {
  cacheBytesOverride = bytes;
  cacheItemsOverride = items;
}
export function __resetShimForTest() {
  state.cache.clear();
  state.bytes = 0;
  state.inflight.clear();
  state.queue.length = 0;
  state.running = 0;
  state.ffmpeg = null;
  state.ffmpegBin = null;
  state.stats = { converted: 0, failed: 0, cacheHits: 0, deduped: 0, evictedItems: 0, evictedBytes: 0, lastMs: null, totalMs: 0 };
  converterOverride = null;
  enabledOverride = null;
  cacheBytesOverride = null;
  cacheItemsOverride = null;
}

/* ── 缓存 ── */

function cacheKey(bytes, mime) {
  const h = createHash("sha256");
  h.update(String(mime ?? "").toLowerCase().trim());
  h.update("\0");
  h.update(bytes);
  return `${SHIM_VERSION}:${h.digest("hex")}`;
}

function cacheMaxBytes() {
  return cacheBytesOverride ?? config.robinShimCacheBytes;
}
function cacheMaxItems() {
  return cacheItemsOverride ?? 512;
}

function putCache(key, entry) {
  if (entry.bytes > cacheMaxBytes()) return; // 单项超上限：不缓存（仍正常返回给调用方）
  state.cache.set(key, entry);
  state.bytes += entry.bytes;
  while ((state.bytes > cacheMaxBytes() || state.cache.size > cacheMaxItems()) && state.cache.size > 1) {
    const k = state.cache.keys().next().value; // 最旧
    const v = state.cache.get(k);
    state.cache.delete(k);
    state.bytes -= v.bytes;
    state.stats.evictedItems++;
    state.stats.evictedBytes += v.bytes;
  }
}

/* ── 并发闸（ffmpeg 进程有内存开销：Azure 1GiB 机上默认并行 2）── */

function acquire() {
  const cap = Math.max(1, Number(config.robinShimConcurrency) || 1);
  if (state.running < cap) {
    state.running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => state.queue.push(() => {
    state.running++;
    resolve();
  }));
}
function release() {
  state.running = Math.max(0, state.running - 1);
  const next = state.queue.shift();
  if (next) next();
}

/* ── ffmpeg ── */

function runFfmpeg(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, err: `spawn: ${err?.message ?? err}` });
      return;
    }
    let errBuf = "";
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, err });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      finish(false, `ffmpeg 超时（${timeoutMs}ms）`);
    }, timeoutMs);
    child.stderr?.on("data", (d) => {
      if (errBuf.length < 4096) errBuf += d.toString();
    });
    child.on("error", (err) => finish(false, `spawn: ${err?.message ?? err}`));
    child.on("close", (code) => finish(code === 0, code === 0 ? "" : errBuf.trim().split("\n").slice(-3).join(" | ") || `exit=${code}`));
  });
}

/** 探测 ffmpeg 可用性（含 Windows 下 `ffmpeg`/`ffmpeg.exe` 两种调用名；结果带 TTL 重探） */
export async function ffmpegAvailable() {
  if (state.ffmpeg === true) return true;
  if (state.ffmpeg === false && Date.now() - state.ffmpegProbedAt < REPROBE_MS) return false;
  state.ffmpegProbedAt = Date.now();
  const base = String(config.robinFfmpegBin || "ffmpeg");
  const candidates = process.platform === "win32" && !/\.exe$/i.test(base) ? [base, `${base}.exe`] : [base];
  for (const bin of candidates) {
    const r = await runFfmpeg(bin, ["-version"], 10_000);
    if (r.ok) {
      state.ffmpeg = true;
      state.ffmpegBin = bin;
      return true;
    }
  }
  state.ffmpeg = false;
  return false;
}

/** 占位视频帧率（每秒帧数）。
 *
 * ★ 为什么是 0.25 而不是 1：视频按**帧**计费（258 token/帧 @ 1fps），
 * 而音频只要 32 token/s。同一条语音，包成 1fps 视频 = 258+32 ≈ 290 token/s，
 * 走原音只要 32 token/s ⇒ **shim 越"忠实"越贵**。但帧只是给上游一个"这里有视频"
 * 的信号（模型听的是音频轨），画面本身是 16×16 黑帧，毫无信息量。
 * 2026-10-17 真实语音探针（33.45s 骑行语音，3.5 Flash-Lite 转写对照）：
 *   r=1→33 帧（8514 tok）转写准确；
 *   r=0.25→8 帧（2064 tok，**省 76%**）转写质量与基线等价，关键信息全中；
 *   r=0.125→4 帧转写明显劣化（"真省了"→"真爽了"、"骑出来"→"到处外面有"）。
 * ⇒ 0.25 是实测甜点：视觉 token 砍到 1/4，音频轨 MD5 与源完全一致（零转码）。
 */
const PLACEHOLDER_FPS = 0.25;
/** 供运行状态/测试观测：当前占位视频帧率（fps），以及由此推出的视频 token 开销 */
export function placeholderVideoInfo() {
  return {
    fps: PLACEHOLDER_FPS,
    // 视觉 token 只与帧数有关；音频 token 只与时长有关，两者在 shim 下均不变。
    tokensPerFrame: 258,
    tokensPerSecondVideo: Math.round(PLACEHOLDER_FPS * 258),
    tokensPerSecondAudio: 32,
    ratioVsRawAudio: Number(((PLACEHOLDER_FPS * 258 + 32) / 32).toFixed(2)),
  };
}
/** lavfi 生成源用较高帧率，再由 fps 滤镜降采样。
 *  直接给 lavfi 低帧率在 webm 上不可控（实测 -shortest 下帧数反增：33→24→26→18），
 *  必须走 fps 滤镜才能得到确定的帧数与 pts 分布。
 */
const LAVFI_SRC_FPS = 25;

/** ffmpeg 参数：16×16 黑帧视频 + 原音频轨；copy 不可行（容器不兼容）时回退 libopus
 *
 *  帧率通过 `[1:v]fps=PLACEHOLDER_FPS` 滤镜施加，而不是 lavfi 的 `r=`：
 *  lavfi 是无界输入，`-shortest` 只能按视频轨收敛，低帧率会让视频轨比音频更长
 *  （8s 音频在 r=0.25 下产出 16s 容器），反而可能让上游按更长时长采样。
 *  fps 滤镜 + `-shortest` 则给出确定的帧数，且所有帧的 pts 严格落在音频时长内
 *  （实测 33.45s 音频：r=0.25 → pts 0,4,8,…,28）。
 */
function buildArgs(inPath, outPath, audioMode) {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", inPath,
    "-f", "lavfi", "-i", `color=c=black:s=16x16:r=${LAVFI_SRC_FPS}`,
    "-filter_complex", `[1:v]fps=${PLACEHOLDER_FPS}[v]`,
    "-map", "[v]", "-map", "0:a",
    "-c:v", "libvpx", "-b:v", "10k",
  ];
  if (audioMode === "copy") args.push("-c:a", "copy");
  else args.push("-c:a", "libopus", "-b:a", "64k");
  args.push("-shortest", outPath);
  return args;
}

/**
 * 默认转换器（真实 ffmpeg）：临时文件进出（避免 pipe 对 mp4 等需 seek 的容器不友好）。
 * @returns {Promise<Buffer|null>} 转换产物；失败返回 null（调用方回退）
 */
async function defaultConvert(bytes, mime) {
  if (!(await ffmpegAvailable())) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "robin-shim-"));
  const inPath = path.join(dir, `in-${++state.tmpSeq}.bin`);
  const outPath = path.join(dir, "out.webm");
  try {
    await fs.writeFile(inPath, bytes);
    // webm/ogg 容器大概率已是 opus/vorbis（客户端录音常态）⇒ 优先零转码 copy；
    // 其余（wav/mp3/mp4 等）直接走 libopus 重编码。任一失败自动尝试另一模式。
    const low = String(mime ?? "").toLowerCase();
    const attempts = /webm|ogg|opus|matroska/.test(low) ? ["copy", "opus"] : ["opus", "copy"];
    let lastErr = "";
    for (const mode of attempts) {
      const r = await runFfmpeg(state.ffmpegBin, buildArgs(inPath, outPath, mode), config.robinShimTimeoutMs);
      if (r.ok) {
        const out = await fs.readFile(outPath);
        if (out.length) return out;
        lastErr = "空产物";
        continue;
      }
      lastErr = r.err;
      await fs.rm(outPath, { force: true }).catch(() => {});
    }
    console.warn(`[shim] 转换失败（保持原音频）: ${lastErr || "未知错误"}`);
    return null;
  } catch (err) {
    console.warn(`[shim] 转换异常（保持原音频）: ${err?.message ?? err}`);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ── 主流程 ── */

/**
 * 音频 → 占位视频（带缓存与并发去重）。
 * @param {Buffer|Uint8Array} bytes 音频字节
 * @param {string} mime 原始 mime（含参数亦可）
 * @returns {Promise<{buffer:Buffer, mime:string, cached:boolean, deduped?:boolean, ms?:number}|null>}
 *          null = 未转换（未启用 / 失败），调用方保持原附件
 */
export async function toPlaceholderVideo(bytes, mime) {
  if (!shimEnabled() || !bytes?.length) return null;
  const key = cacheKey(bytes, mime);

  const hit = state.cache.get(key);
  if (hit) {
    state.cache.delete(key); // LRU 触碰
    state.cache.set(key, hit);
    state.stats.cacheHits++;
    return { buffer: hit.buffer, mime: hit.mime, cached: true };
  }

  const pending = state.inflight.get(key);
  if (pending) {
    const r = await pending;
    if (!r) return null;
    state.stats.deduped++;
    return { buffer: r.entry.buffer, mime: r.entry.mime, cached: true, deduped: true, ms: r.ms };
  }

  const task = (async () => {
    await acquire();
    try {
      const t0 = Date.now();
      const out = await (converterOverride ?? defaultConvert)(bytes, mime);
      const ms = Date.now() - t0;
      if (!out?.length) {
        state.stats.failed++;
        return null;
      }
      state.stats.converted++;
      state.stats.lastMs = ms;
      state.stats.totalMs += ms;
      const entry = { buffer: Buffer.isBuffer(out) ? out : Buffer.from(out), mime: OUT_MIME, bytes: out.length };
      putCache(key, entry);
      return { entry, ms };
    } catch (err) {
      state.stats.failed++;
      console.warn(`[shim] 转换异常（保持原音频）: ${err?.message ?? err}`);
      return null;
    } finally {
      release();
    }
  })();
  state.inflight.set(key, task);
  try {
    const r = await task;
    return r ? { buffer: r.entry.buffer, mime: r.entry.mime, cached: false, ms: r.ms } : null;
  } finally {
    if (state.inflight.get(key) === task) state.inflight.delete(key);
  }
}

/**
 * 就地把附件列表里的音频附件替换为占位视频（其余类型不动、顺序不动）。
 * 永不抛错；失败的单条保持原样（音频退让路径，行为同旧版）。
 * @param {Array<{mime?:string, bytes?:Buffer, blobId?:string, name?:string}>} attachments
 * @returns {Promise<{tried:number, converted:number, cached:number, failed:number, skippedRefs:number}>}
 */
export async function applyMediaShim(attachments) {
  const stats = { tried: 0, converted: 0, cached: 0, failed: 0, skippedRefs: 0 };
  const list = attachments ?? [];
  if (!shimEnabled() || !list.length) return stats;

  await Promise.all(list.map(async (a) => {
    const mime = String(a.mime ?? "").toLowerCase().trim();
    if (!mime.startsWith("audio/")) return;
    if (!a.bytes?.length) {
      // fileData 引用（仅有 blobId、无内联字节）：无法转封装 ⇒ 保持音频路径（退让换听觉）
      stats.skippedRefs++;
      console.log("[shim] 音频附件为 blobId 引用（无内联字节）——无法转封装，保持音频路径");
      return;
    }
    stats.tried++;
    const inBytes = a.bytes.length;
    const out = await toPlaceholderVideo(a.bytes, a.mime);
    if (!out) {
      stats.failed++;
      return;
    }
    a.__shimFrom = mime; // 仅进程内标记（不参与序列化；供日志/调试）
    a.bytes = out.buffer;
    a.mime = out.mime;
    stats.converted++;
    if (out.cached) stats.cached++;
    else console.log(`[shim] ${mime} ${inBytes}B → ${OUT_MIME} ${out.buffer.length}B（转换 ${out.ms ?? "-"}ms）`);
  }));

  if (stats.converted) {
    console.log(`[shim] 音频 ×${stats.converted} 已包成占位视频（缓存命中 ×${stats.cached}）→ 走视频通道，档位不退让`);
  }
  return stats;
}

/** 运行状态（healthz 用） */
export function shimStatus() {
  return {
    enabled: shimEnabled(),
    ffmpeg: state.ffmpeg, // null=未探测 / true / false
    ffmpegBin: state.ffmpeg ? state.ffmpegBin : null,
    cache: { items: state.cache.size, bytes: state.bytes, maxBytes: cacheMaxBytes() },
    stats: { ...state.stats, inflight: state.inflight.size, queued: state.queue.length },
    placeholder: placeholderVideoInfo(),
  };
}
