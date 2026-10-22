// lib/dedup.js — 请求幂等去重（防重复计费）
//
// ★ 为什么需要它（2026-10-17 生产事故）：
//   反代与调用方（Eidolon）之间是**有状态 HTTP 连接**，而配额按「上游是否受理」计费。
//   一次真实事故链：19:06 请求成功 → 我为部署改动重启反代 → 19:07 在途请求被掐断
//   （附件已上传、auth 已换到、上游已开始推理）→ 调用方 SDK 报 Server disconnected
//   自动重发同一 payload → 上游**又算了一遍**。同一段 317KB 视频 + 29.9k token 文本
//   被计费两次，其中一次应答无人接收。
//
//   教训：**「客户端没收到」不等于「上游没算」。** 掐断只切断回程，不回滚上游推理。
//
// ★ 设计边界（重要，别越界）：
//   · 本模块**只防重复**，不改变任何上游语义 —— 命中去重时**零上游调用**（零配额）。
//   · **不缓存空响应与错误**：空响应必须继续走 empty-retry（重试即好是它的修复路径），
//     错误必须继续透出让上层跨通道回退。缓存它们会把「可恢复故障」固化成「假成功」。
//   · **短窗口**（默认 90s）：正常用户不会在一分半内发出两条完全相同的请求
//     （含全部媒体字节），所以窗口内命中即视为重发。窗口外的相同请求是新意图。
//   · **只按 payload 哈希**，不含时间戳/随机 id ⇒ 同一次重发必然同键。
//   · 进程内存态：反代重启即失效（重启本身就是事故根因，故另配 graceful shutdown）。
//     跨进程/跨重启的去重需要持久化，但那会引入「陈旧结果」风险，暂不做。
//
// ★ 租约（lease）语义：
//   `beginDedup` 返回 { lease, owns }。只有 `owns === true` 的调用方才负责
//   `completeDedup` / `failDedup` 写回。等待同键在途请求而超时的调用方 `owns === false`
//   —— 它会自己打一份上游，但**不得覆盖**在途项（否则两份结果互相踩）。
//
// ★ 流式安全：命中去重时**原样重放缓存的增量序列**，不重新推理。
//   缓存的是「已发生的事实」，重放不会多出一个字节的新内容。

import crypto from "node:crypto";

const TTL_MS = Math.max(0, Number(process.env.ROBIN_DEDUP_TTL_MS ?? 90_000));
const MAX_ENTRIES = Math.max(1, Number(process.env.ROBIN_DEDUP_MAX ?? 64));
// ★ 等待同键在途请求的时长（2026-10-20）：必须 ≥ 上游请求的等待上限（300s），
//   否则调用方在长请求期间重发时会**等不到**在途结果 → 自行再打一次上游
//   ⇒ 同一份内容计费两次（2026-10-17 那次重复计费事故的同类风险）。
const WAIT_MS = Math.max(0, Number(process.env.ROBIN_DEDUP_WAIT_MS ?? 300_000));

export function dedupEnabled() {
  return String(process.env.ROBIN_DEDUP ?? "1") !== "0" &&
    String(process.env.ROBIN_DEDUP ?? "1").toLowerCase() !== "false" &&
    TTL_MS > 0;
}

/**
 * 稳定字符串化：键序无关。
 * 为什么不用 JSON.stringify(body)：JS 对象键序随构造路径变化，同一语义请求
 * （如经不同中间层重构过）会产出不同字符串 ⇒ 漏去重。递归排序后语义相同即同串。
 */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/**
 * 计算去重键。
 * @param {object} body Gemini 原生请求体（含 inlineData 原始字节）
 * @param {string} verb "generateContent" | "streamGenerateContent"
 * @param {string|null} modeId 档位 id（Lgauy.#16）—— 同 payload 不同档位是不同意图
 * @param {number|null} thinkingLevel 思考强度（Lfzqy.#48）—— 同上
 * @returns {string} 64 位十六进制摘要
 */
export function dedupKey(body, verb, modeId = null, thinkingLevel = null) {
  const h = crypto.createHash("sha256");
  h.update(`v1|${verb}|${modeId ?? "-"}|${thinkingLevel ?? "-"}|`);
  h.update(stableStringify(body));
  return h.digest("hex");
}

/** @typedef {{key:string,at:number,deltas:string[],result:object|null,err:Error|null,done:boolean,waiters:Array<()=>void>}} Entry */
/** @typedef {{key:string,at:number,deltas:string[],result:object|null,done:boolean}} Replay */

/** @type {Map<string, Entry>} */
const entries = new Map();

let stats = { hits: 0, waits: 0, waitTimeouts: 0, misses: 0, stores: 0, evictions: 0, skips: 0 };

function now() {
  return Date.now();
}

/** 淘汰过期项；顺带在条目过多时淘汰最旧（Map 保插入序 ⇒ FIFO） */
function sweep() {
  const t = now();
  for (const [k, e] of entries) {
    if (t - e.at > TTL_MS) entries.delete(k);
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    entries.delete(oldest);
    stats.evictions++;
  }
}

/**
 * 登记一次请求。同键已有**在途**项时返回 `owns:false`（共享，不负责写回）。
 * @returns {{lease:string, owns:boolean}}
 */
export function beginDedup(key) {
  sweep();
  const existing = entries.get(key);
  if (existing && !existing.done) return { lease: key, owns: false };
  if (existing && existing.done) {
    // 已完成但仍在 TTL 内：**不刷新 at**。刷新会让「已成功的结果」被无限重放，
    // 掩盖真正的重发意图 —— 保留首次完成时间，由 sweep 自然淘汰。
  }
  entries.set(key, {
    key,
    at: now(),
    deltas: [],
    result: null,
    err: null,
    done: false,
    waiters: [],
  });
  return { lease: key, owns: true };
}

/** 同键是否有在途请求 */
export function isInflight(key) {
  const e = entries.get(key);
  return Boolean(e && !e.done);
}

/**
 * 查询可重放的缓存结果。
 * @returns {Replay|null} null = 需要真的去打上游
 */
export function lookupDedup(key) {
  if (!dedupEnabled()) return null;
  const e = entries.get(key);
  if (!e || !e.done) return null;
  if (now() - e.at > TTL_MS) {
    entries.delete(key);
    return null;
  }
  if (e.err) return null; // 失败不重放：让本次真的去打，错误路径才可能恢复
  if (!isCacheable(e.result)) return null; // 空结果/错误不重放（见文件头设计边界）
  stats.hits++;
  return { key, at: e.at, deltas: e.deltas.slice(), result: e.result };
}

/**
 * 该结果是否**可以**进入可重放缓存。
 *
 * ★ 设计边界（见文件头）：**空响应与错误都不得进缓存** ——
 *   · 空响应必须继续走 empty-retry（「重试即好」是它的修复路径）；
 *   · 错误必须继续透出让上层跨通道回退。
 *   缓存它们会把「可恢复故障」固化成「假成功」。
 *
 * ⚠️ 2026-10-20 实测踩到的坑：旧实现把「有 error」判成「不算空」⇒
 *   **错误结果被写进缓存**，随后 90 秒内**同一个 payload 的所有重试都被重放成
 *   同一个错误**（实测：一次 20s 的取令牌超时 ⇒ 后续每次请求都直接回放
 *   "no credential"，完全不再尝试恢复）。
 *   ⇒ 有 error ⇒ 不可缓存（与空响应同等处理）。
 */
function isCacheable(r) {
  if (!r) return false;
  if (r.error) return false; // 错误不缓存（可恢复故障不得被固化）
  const texts = Array.isArray(r.texts) ? r.texts : [];
  const hasText = texts.some((t) => typeof t === "string" && t.trim().length > 0);
  const hasCumulative = typeof r.cumulative === "string" && r.cumulative.trim().length > 0;
  if (!hasText && !hasCumulative && !r.model) return false; // 空响应不缓存
  return true;
}

/**
 * 写回成功结果（仅 owns 方调用）。空结果不进入可重放态。
 * @param {string} lease beginDedup 返回的 lease（=== key）
 * @param {object} result
 * @param {string[]} deltas 流式增量序列（非流式传空数组）
 */
export function completeDedup(lease, result, deltas = []) {
  const e = entries.get(lease);
  if (!e) return;
  e.result = result;
  e.deltas = deltas.slice();
  e.done = true;
  if (isCacheable(result)) {
    stats.stores++;
  } else {
    // 空响应 / 错误：立刻摘掉，避免占用窗口内的键位挡住后续合法重试，
    // 也避免把可恢复故障固化成「假成功」（2026-10-20 实测踩坑）。
    entries.delete(lease);
  }
  wake(e);
}

/** 失败路径：摘掉项并唤醒等待者（它们会各自真的去打上游） */
export function failDedup(lease, err) {
  const e = entries.get(lease);
  if (!e) return;
  e.err = err ?? new Error("unknown");
  e.done = true;
  entries.delete(lease);
  wake(e);
}

function wake(e) {
  const ws = e.waiters.splice(0);
  for (const w of ws) w();
}

/**
 * 等待同键在途请求完成，然后返回其结果。
 * @param {string} key
 * @param {number} [timeoutMs] 默认 ROBIN_DEDUP_WAIT_MS；超时返回 null（调用方自行打上游）
 * @returns {Promise<Replay|null>}
 */
export function waitDedup(key, timeoutMs = WAIT_MS) {
  const e = entries.get(key);
  if (!e || e.done) return Promise.resolve(lookupDedup(key));
  if (timeoutMs <= 0) return Promise.resolve(null);
  stats.waits++;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) stats.waitTimeouts++;
      resolve(lookupDedup(key));
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    e.waiters.push(() => finish(false));
  });
}

export function dedupStatus() {
  let inflight = 0;
  for (const e of entries.values()) if (!e.done) inflight++;
  return {
    enabled: dedupEnabled(),
    ttlMs: TTL_MS,
    maxEntries: MAX_ENTRIES,
    waitMs: WAIT_MS,
    inflight,
    cached: entries.size,
    ...stats,
  };
}

/** 测试辅助：清空条目（保留 stats 累计值，便于断言） */
export function resetDedup() {
  entries.clear();
}
