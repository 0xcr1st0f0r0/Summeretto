// lib/app.js — HTTP 路由层（与 server.mjs 解耦，便于测试）
//
// 对外暴露 Gemini 原生格式（与 Google Generative Language API 对齐），
// 内部翻译为 Robin gRPC（ProcessQuery 双向流）：见 lib/pq.js / lib/robin.js。
import { config } from "./config.js";
import { buildTextQueryScript } from "./pq.js";
import { processQuery, deleteConversation } from "./robin.js";
import { tokenStatus, setInjectedToken, bindGpsoauth, mintAccessToken, credentialHealth } from "./auth.js";
import { renderLoginPage } from "./login-page.js";
import { geminiToRobin, makeGeminiResponse, makeGeminiChunk, makeGeminiFunctionCallChunk, sseData, geminiError, encodeFileUri, decodeFileUri } from "./gemini.js";
import { estimatePromptTokens, withEstimatedUsage } from "./usage-estimate.js";
import { hasToolDeclarations, extractToolDefs, parseFunctionCalls } from "./toolcall.js";
import { uploadResumable, pushStart, pushFinalize } from "./upload.js";
import { explainUpstreamError } from "./tos.js";
import { applyMediaShim, shimStatus } from "./mediashim.js";
import {
  resolveMode, modelListPayload, modesSummary, refreshModes, currentModes,
  parseThinkingLevel, splitThinkingSuffix, thinkingSummary, THINKING_LEVELS,
} from "./modes.js";
import {
  noteResponse,
  guardStatus,
} from "./degrade-guard.js";
import { withEmptyRetry, emptyRetryStatus } from "./empty-retry.js";
import { inflightStatus } from "./inflight.js";
import {
  dedupEnabled,
  dedupKey,
  beginDedup,
  lookupDedup,
  isInflight,
  waitDedup,
  completeDedup,
  failDedup,
  dedupStatus,
} from "./dedup.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": [
    "content-type",
    "authorization",
    "x-goog-api-key",
    "x-goog-upload-protocol",
    "x-goog-upload-command",
    "x-goog-upload-offset",
    "x-goog-upload-url",
    "x-goog-upload-header-content-length",
    "x-goog-upload-header-content-type",
  ].join(","),
  "access-control-expose-headers": "x-goog-upload-url,x-goog-upload-status,x-goog-upload-size-received",
  "access-control-max-age": "86400",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...CORS,
  });
  res.end(body);
}

/** Gemini 原生错误格式 */
function sendError(res, code, message, status = "INTERNAL") {
  sendJson(res, code, geminiError(code, message, status));
}

/**
 * 上游错误 → 面向调用方的诊断文本。
 * 把「Before proceeding, please accept our terms of service.」这类原始报错
 * 翻译成「是谁的问题 + 怎么修」，避免调用方把账号门禁误当成协议 bug。
 */
function upstreamDiagnosis(rawError) {
  const base = `Robin 上游错误：${rawError}`;
  const diag = explainUpstreamError(rawError);
  if (!diag) return { message: base, diag: null };
  const doc = diag.docUrl ? `\n条款文档：${diag.docUrl}` : "";
  return { message: `${base}\n[${diag.code}] ${diag.hint}${doc}`, diag };
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

/** admin 端点统一鉴权；返回 true 表示已放行 */
function adminAllowed(req, res) {
  if (!config.adminKey) {
    sendError(res, 404, "admin 端点未启用（未配置 ADMIN_KEY）", "NOT_FOUND");
    return false;
  }
  if (req.headers["x-admin-key"] !== config.adminKey) {
    sendError(res, 401, "admin key 无效", "UNAUTHENTICATED");
    return false;
  }
  return true;
}

function authed(req) {
  if (!config.proxyApiKey) return true; // 未配置 = 本地开发模式
  const h = req.headers;
  const key =
    h["x-goog-api-key"] ||
    String(h.authorization ?? "").replace(/^Bearer\s+/i, "") ||
    // query 兜底：google-genai SDK 部分版本把 key 放 ?key=
    new URL(req.url ?? "/", "http://x").searchParams.get("key") ||
    "";
  return key === config.proxyApiKey;
}

/* ── 轻量限流（内存滑动窗口，按 IP；防扫薅） ── */
const RATE_WINDOW_MS = 60_000;
// 自托管语义：单进程内存计数（robin-proxy 每实例一份），按 IP 滑动窗口，
// 属 best-effort 防御。默认 30/min：足以迟滞扫描，又不影响正常使用（Eidolon 走 key 调用）。
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX ?? 30);
const _rateBuckets = new Map(); // ip -> number[]（时间戳）

function rateLimited(req) {
  if (!RATE_MAX || RATE_MAX <= 0) return false;
  const ip =
    String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  const now = Date.now();
  let bucket = _rateBuckets.get(ip);
  if (!bucket) {
    bucket = [];
    _rateBuckets.set(ip, bucket);
  }
  // 淘汰窗口外的旧戳（顺带防内存膨胀：窗口内无请求即删键）
  while (bucket.length && now - bucket[0] > RATE_WINDOW_MS) bucket.shift();
  if (bucket.length === 0 && _rateBuckets.size > 10_000) {
    for (const [k, v] of _rateBuckets) if (v.length === 0) _rateBuckets.delete(k);
  }
  bucket.push(now);
  return bucket.length > RATE_MAX;
}

export async function readJsonBody(req, limit = config.maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const e = new Error(
        `请求体超限（>${limit} 字节）。大媒体请走分片上传（/upload/v1beta/files），或在服务端调大 MAX_BODY_BYTES`
      );
      e.statusCode = 413;
      throw e;
    }
    chunks.push(c);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 模型清单：★ 2026-10-16 起为**真实档位**（不再是占位）。
 *
 * 真实模型选择位已定位并实测贯通：Lgauy.#16 = mode id（服务端下发，见 lib/modes.js）。
 * 实测（service/scripts/mode-probe.mjs）：
 *   不带 #16 → 上游回报 "Used 3.5 Flash-Lite model"
 *   带   #16=95a4c0abcba24364（4 Argon）→ "Used 4 Argon model"
 */

function isLocalUpstream() {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(config.robinUrl);
}

/** 工具模式（请求带 tools）下的最终文本：取累积全文，解析出 functionCall 块 */
function resolveToolResult(body, result) {
  const toolDefs = extractToolDefs(body);
  if (!toolDefs.length) return null;
  const raw = result.cumulative || result.texts[result.texts.length - 1] || "";
  // ⚠️ 别名兼容：SDK 版本间嵌套字段大小写不一致（见 gemini.js 的 alias()）
  const tc = body?.toolConfig ?? body?.tool_config ?? {};
  const fcc = tc?.functionCallingConfig ?? tc?.function_calling_config ?? {};
  const allowed = fcc?.allowedFunctionNames ?? fcc?.allowed_function_names;
  const { cleanText, calls } = parseFunctionCalls(raw, Array.isArray(allowed) ? allowed : null);
  return { cleanText, calls, toolDefs };
}

/** 翻译 → 装配 → 发往 Robin */
/**
 * ★ 会话隔离（2026-10-16）：处理完就删掉本次请求在服务端产生的会话。
 *
 * 为什么：Robin 服务端按【账号】维持 active 会话，请求不带会话 ID 时会落入同一个
 *   持续累积的会话（实测：不带历史直接问上轮暗号，模型仍能答出）→ 多路复用同一账号
 *   时不同调用方的上下文互相串扰，且参考答案易经服务端记忆污染。
 * 删除失败只记日志、不影响本次应答（务求：隔离是尽力而为，但不能拖垮请求）。
 *
 * @param {string|null} conversationId ProcessQuery 响应里带回的会话 ID
 */
async function isolateConversation(conversationId) {
  if (!config.isolateConversations || !conversationId) return;
  if (isLocalUpstream()) return; // mock 模式没有真实会话可删
  try {
    const r = await deleteConversation(conversationId, { timeoutMs: 10_000 });
    if (!r.ok) {
      console.warn(
        `[robin] 会话隔离失败 cid=${conversationId} status=${r.grpcStatus ?? "?"} ${r.grpcMessage ?? r.error ?? ""}`
      );
    }
  } catch (err) {
    console.warn(`[robin] 会话隔离异常 cid=${conversationId} ${err?.message ?? err}`);
  }
}

/**
 * 单次尝试（不做空响应重试；重试编排见下方 callRobin 包装）。
 * @param {object} body Gemini 原生请求体
 * @param {(delta: string) => void} [onDelta] 流式增量回调
 * @param {string|null} [modeId] Lgauy.#16 的档位 id（null = 不发该字段，用账号默认档位）
 * @param {number|null} [thinkingLevel] ★ Lfzqy.#48 思考档位值（1=Low / 4=Medium / 2=High；
 *        null = 不发该字段，服务端按 Low 处理。取证与实证见 lib/modes.js 思考强度章节）
 */
async function attemptRobin(body, onDelta, modeId = null, thinkingLevel = null) {
  const { text, attachments } = geminiToRobin(body);
  // ★ 媒体占位视频（media shim，2026-10-17，见 lib/mediashim.js）：音频附件包成 16×16
  //   视频 ⇒ 走视频通道绕过「音频 × Argon 互斥」上游硬限（Argon 满血档位 + 听觉兼得；
  //   视频音轨实测可被 Argon 准确转录）。转换失败/未启用时单条静默回退（保持音频 ⇒
  //   档位退让换听觉，行为同旧版）。必须在 hasAudioAttachment / 上传之前完成：
  //   后续全链路（承载位判定、上传、信封）一律按「视频附件」对待。
  const shim = await applyMediaShim(attachments);
  // ★ 诊断：记录附件构成（mime 已在解析层归一，不涉内容）。
  //   用途：语音/图片"听不清、看不见"类问题的现场取证 —— 确认请求里到底有没有
  //   带媒体、带的是什么 mime、多大。仅记元数据，不落内容。
  if (attachments?.length) {
    const summary = attachments
      .map((a) => `${String(a.mime ?? "?").split(";")[0]}(${a.bytes ? `${a.bytes.length}B` : "ref"})`)
      .join(" + ");
    console.log(`[req] 附件 ×${attachments.length}: ${summary}`);
  }
  // ★ 档位承载位（2026-10-17 实证）：档位只在 `Lgcvm.#1 Lgauy` 生效；音频附件会把
  //   它挤到 `Lfzqy.#13`（Argon 路径读不到音频，必须退让）⇒ 本轮必然降级。
  //   这一行是"这轮为什么变笨"的直接答案，省去事后从响应反推。
  const hasAudioAttachment = (attachments ?? []).some((a) =>
    String(a.mime ?? "").toLowerCase().trim().startsWith("audio/")
  );
  if (modeId) {
    console.log(
      `[carrier] 档位承载位=${hasAudioAttachment
        ? "Lfzqy.#13（音频退让 ⇒ 本轮自动降级换取听觉）"
        : `Lgcvm.#1（档位生效${shim.converted ? `，音频 ×${shim.converted} 已占位视频化` : ""}）`}`
    );
  }
  // ★ 2026-10-15 实证链路：inlineData 原始字节先上传 push.clients6 换 blobId，
  //   再走 Lgcvm[ext1001] 附件信封（服务端按 blobId 读内容；probe38/39/40 实证）。
  //   本地 mock 模式（e2e）不打真实上传端点，用占位 blobId 保持信封结构可断言。
  const resolved = [];
  for (const a of attachments ?? []) {
    if (a.blobId) {
      resolved.push(a);
    } else if (a.bytes) {
      let blobId;
      if (isLocalUpstream()) {
        blobId = `/contrib_service/ttl_1d/mock_${resolved.length}_${a.bytes.length}b`;
      } else {
        const up = await uploadResumable({ bytes: a.bytes, mime: a.mime });
        blobId = up.blobId;
        if (!blobId) throw new Error("上传未返回 blobId");
        console.log(
          `[upload] ${String(a.mime ?? "?").split(";")[0]} ${a.bytes.length}B → ${String(blobId).slice(0, 40)}`
        );
      }
      resolved.push({ blobId, mime: a.mime, name: a.name });
    }
  }
  // ★ 一次完整文本查询 = initial → prefetch → 单帧 commit（Lgcvl{#2}，见 pq.js 头部协议说明）
  // ★ 模型档位：modeId → Lgauy.#16（实证 2026-10-16，见 lib/modes.js 头部取证链）
  // ★ 思考强度：thinkingLevel → Lgcvb.#1 Lfzqy.#48（实证 2026-10-16，见 lib/modes.js 思考强度章节）
  const frames = buildTextQueryScript(text, {
    attachments: resolved,
    ...(modeId ? { lgauy: { s16: modeId } } : {}),
    ...(thinkingLevel !== null && thinkingLevel !== undefined ? { thinkingLevel } : {}),
  });
  // 服务端每帧的 texts 是【累积文本】（Lgapu.#2.Lgace.#1 每帧递增）→ 差量输出
  let prev = "";
  const result = await processQuery({
    frames,
    // ★ 结束条件（2026-10-20 二改，见 lib/robin.js）：
    //   · 总时限 300s；首正文前**不再有独立宽限**（默认等到总时限）
    //   · 结束只由：上游终止会话 / EOS 标记 / 正文完成标记（Lgapu.#19=2）
    //     / 上游真空 / 总时限 到 —— 我方静默定时器**不再把「上游慢」掐成空回复**。
    idleMs: config.robinIdleMs,
    firstIdleMs: config.robinIdleFirstMs,
    idleAfterTextMs: config.robinIdleAfterTextMs,
    onFrame: (evt) => {
      if (evt.kind !== "response" || !evt.texts?.length) return;
      const cum = evt.texts[evt.texts.length - 1]; // 一帧内取最长者
      if (cum && cum !== prev) {
        onDelta?.(cum.startsWith(prev) ? cum.slice(prev.length) : cum);
        prev = cum;
      }
    },
  });
  // ★ 会话隔离：应答到手后再删会话（失败不影响本次应答，见 isolateConversation 注释）
  if (result.conversationId) await isolateConversation(result.conversationId);
  // ★ 响应侧观测（2026-10-17）：把「请求的档位/思考」与「服务端实际给的」并排打出来。
  //   两个只能靠响应面判定的问题从此不必再跑离线探测脚本：
  //     · 静默降级 ⇒ #25（实际生效档位 id）≠ 请求的 #16，且 #41 rank 回落到 6
  //     · 思考参数被吞 ⇒ #42（回显）≠ 请求的 #48
  //   仅记元数据，不落内容。判据出处见 lib/modes.js 与 docs §5.14。
  const modeDowngraded = Boolean(modeId && result.effectiveMode && result.effectiveMode !== modeId);
  const thinkingDropped = Boolean(
    thinkingLevel !== null && thinkingLevel !== undefined && result.thinking !== thinkingLevel
  );
  console.log(
    `[resp] ${result.model ?? "(无 #30)"} rank=${result.rank ?? "-"} thinkEcho=${result.thinking ?? "-"}` +
    ` effMode=${result.effectiveMode ?? "-"}` +
    // ★ 结束方式（2026-10-20）：complete = 正文完成标记（Lgapu.#19=2），
    //   eos = 上游 EOS 标记，idle = 静默兜底，timeout = 总时限到。
    //   「complete/eos」= 上游明确说答完了（确定性）；后两者才是超时类。
    ` endedBy=${result.endedBy ?? "-"}${result.complete ? " (完成标记)" : ""}${result.eos ? " (EOS)" : ""}` +
    (modeDowngraded
      ? (hasAudioAttachment
        ? " ⓘ 降级属预期（音频退让：Argon 读不到音频）"
        : " ⚠️档位降级（服务端未采用请求的档位 id，且本轮无音频 —— 需要排查）")
      : "") +
    (thinkingDropped ? " ⚠️思考强度未回显（#42 ≠ 请求 #48）" : "")
  );
  // ★ 降级观测（2026-10-17，见 lib/degrade-guard.js）：判定本次是否被静默降级 /
  //   空响应。本模块只观测+上报 —— 不换将、不跨档重试、不置窗（robin 与调用方
  //   解耦：降级回显原样透出，由 Eidolon 决定跨通道回退；同模型重试只在
  //   empty-retry 里按「空响应」触发）。裁决挂在 result 上，不是 Gemini 响应
  //   字段，makeGeminiResponse 只挑白名单字段，不会外泄。
  result.__modeVerdict = noteResponse({ requestedModeId: modeId, result, hasAudioAttachment });
  return result;
}

/**
 * 请求入口（含「空响应自动重试」编排，2026-10-16，见 lib/empty-retry.js）：
 *   上游空响应（200/STOP、无正文、无 #30）在官方 App 上同样偶发、常「重试即好」；
 *   与账号级降级（Flash-Lite 换将，重试无意义）是两类失败 —— 本层只重试前者：
 *     · 空响应 ⇒ 【同模型同档位】自动重试（默认最多 1 次重试 / 总 2 次尝试，带 100s 总预算）；
 *     · 降级   ⇒ 不在此重试、不换将（2026-10-17 起）：降级回显原样透出，
 *                 由上层（Eidolon）跨通道回退到 ag/gemini-3.8-flash。
 *   安全性：空响应 = 零内容 = 未向客户端透出任何字节 ⇒ 所有路径（含真流式）重试无重复输出风险。
 *   连续空响应 ⇒ 判定「资源型」可能性高，返回最后结果交上层处置。
 *
 * ★ 幂等去重（2026-10-17，见 lib/dedup.js）：
 *   「客户端没收到」≠「上游没算」—— 连接被掐断只切断回程，不回滚上游推理。
 *   调用方（SDK 自动重发 / Eidolon 超时重试）会在短窗口内发出**逐字节相同**的 payload，
 *   此时直接重放上次结果 ⇒ 零上游调用、零配额消耗。
 *   去重只影响「是否打上游」，不改变任何上游语义；空响应与错误不进缓存。
 *
 * @param {string} verb "generateContent" | "streamGenerateContent"（去重键的一部分：
 *        两种 verb 的响应形态不同，不可互相当做重放源）
 */
async function callRobin(body, onDelta, modeId = null, thinkingLevel = null, verb = "generateContent") {
  if (!dedupEnabled()) {
    return withEmptyRetry(() => attemptRobin(body, onDelta, modeId, thinkingLevel));
  }

  const key = dedupKey(body, verb, modeId, thinkingLevel);

  // ① 已完成且可重放 → 直接回放（零上游调用）
  const cached = lookupDedup(key);
  if (cached) {
    console.log(`[dedup] 命中缓存，重放上次结果（零上游调用）key=${key.slice(0, 12)} at=${new Date(cached.at).toISOString()}`);
    for (const d of cached.deltas) onDelta?.(d);
    return cached.result;
  }

  // ② 同键在途 → 等它完成再重放（避免两份相同 payload 同时打上游）
  if (isInflight(key)) {
    console.log(`[dedup] 同键在途，等待其完成后重放 key=${key.slice(0, 12)}`);
    const waited = await waitDedup(key);
    if (waited) {
      for (const d of waited.deltas) onDelta?.(d);
      return waited.result;
    }
    // 等待超时或在途项失败 ⇒ 自己打一份。此时 owns=false，不写回、不覆盖在途项。
    console.log(`[dedup] 等待未果，本次自行打上游 key=${key.slice(0, 12)}`);
  }

  // ③ 正常路径：登记在途 → 打上游（含空响应重试）→ 写回
  const deltas = [];
  const { owns } = beginDedup(key);
  try {
    const result = await withEmptyRetry(() =>
      attemptRobin(
        body,
        (t) => {
          deltas.push(t);
          onDelta?.(t);
        },
        modeId,
        thinkingLevel
      )
    );
    if (owns) completeDedup(key, result, deltas);
    return result;
  } catch (err) {
    if (owns) failDedup(key, err);
    throw err;
  }
}

export async function handle(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (path === "/" || path === "/healthz") {
      const ts = tokenStatus();
      const cred = credentialHealth();
      sendJson(res, 200, {
        ok: true,
        service: "summeretto",
        stage: "connected",
        upstream: config.robinUrl,
        auth:
          ts.source !== "none"
            ? `configured (${ts.source}${ts.expiresInSec != null ? `, ${ts.expiresInSec}s left` : ""})`
            : isLocalUpstream()
              ? "mock"
              : "missing",
        // ★ 凭证真实可用性（纯被动判定，不发网络请求）。
        //   为什么要它：`auth` 字段只看"配没配"，2026-10-17 实测出现过
        //   "configured (gpsoauth)" 但 master token 早已被 Google 撤销的假信号。
        //   verdict: unbound | unverified | valid | expired | stale
        credential: { ...cred, ...ts.gpsoauth },
        ts: new Date().toISOString(),
        // 运行时开关（用于确认配置是否生效；媒体上限 / 会话隔离）
        maxAttachments: config.maxAttachments,
        isolateConversations: config.isolateConversations,
        // 模型档位表来源（"static" = 仅兜底表；"dynamic" = 已从 GetUserStatus 拉到真实档位）
        modes: modesSummary(),
        // ★ 思考强度能力（Lfzqy.#48；实证 2026-10-16）
        thinking: thinkingSummary(),
        // ★ 档位降级守卫状态（argon 静默降级窗口；见 lib/degrade-guard.js）
        degradeGuard: guardStatus(),
        // ★ 媒体占位视频转封装状态（音频→16×16 视频；见 lib/mediashim.js）
        mediaShim: shimStatus(),
        // ★ 空响应自动重试状态（偶发故障甄别；见 lib/empty-retry.js）
        emptyRetry: emptyRetryStatus(),
        // ★ 幂等去重状态（防重复计费；见 lib/dedup.js）
        dedup: dedupStatus(),
        // ★ 在途请求数（部署前检查用：>0 时重启会掐断已计费请求，见 lib/inflight.js）
        inflight: inflightStatus(),
      });
      return;
    }

    // ── 凭证管理端点（ADMIN_KEY 保护；与下游 PROXY_API_KEY 相互独立）──
    // 用途：设备侧提取器（tools/frida/extract-robin-token.js）上报 token；
    //       GET 查询当前凭证状态。见 docs/credential-acquisition.md。
    if (path === "/admin/token") {
      if (!adminAllowed(req, res)) return;
      if (req.method === "GET") {
        sendJson(res, 200, tokenStatus());
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req, 64 * 1024);
        const tok = body?.token;
        if (typeof tok !== "string" || !tok.startsWith("ya29.")) {
          sendError(res, 400, "缺少合法 token（需 ya29. 开头的 OAuth access token）", "INVALID_ARGUMENT");
          return;
        }
        sendJson(res, 200, setInjectedToken(tok, body.expiresIn, body.account));
        return;
      }
      sendError(res, 405, "仅支持 GET / POST", "FAILED_PRECONDITION");
      return;
    }

    // ── ★ 网页登录方案：绑定页 + 绑定端点 ────────────────────────────────
    // GET  /login           → 自包含绑定页（引导用户完成网页登录并粘贴 oauth_token）
    // POST /admin/gpsoauth  → {email, oauthToken, androidId?} → exchange_token 换 master token
    // GET  /admin/gpsoauth  → 查询绑定状态
    // POST /admin/gpsoauth?action=mint → 强制用 master token 重取一个访问令牌
    if (path === "/login" && req.method === "GET") {
      sendHtml(res, 200, renderLoginPage({ adminEnabled: Boolean(config.adminKey) }));
      return;
    }

    if (path === "/admin/gpsoauth") {
      if (!adminAllowed(req, res)) return;

      if (req.method === "GET") {
        sendJson(res, 200, {
          ...tokenStatus(),
          credential: credentialHealth(), // ★ 判定结果单独一层，便于脚本读 `.credential.verdict`
        });
        return;
      }

      if (req.method === "POST") {
        if (url.searchParams.get("action") === "mint") {
          const tok = await mintAccessToken(true);
          sendJson(res, 200, {
            ...tokenStatus(), // 注意：必须在展开之后再覆盖字段，否则会被 tokenStatus 顶掉
            // ★ mint 后重算判定：这是唯一能主动验证凭证的时刻（force=true）
            credential: credentialHealth(),
            ok: Boolean(tok),
            minted: Boolean(tok),
            tokenTail: tok ? `…${tok.slice(-8)}` : null,
          });
          return;
        }

        const body = await readJsonBody(req, 64 * 1024);
        const r = await bindGpsoauth({
          email: body?.email,
          oauthToken: body?.oauthToken ?? body?.token,
          androidId: body?.androidId,
        });
        if (!r.ok) {
          sendError(res, 400, r.error ?? "绑定失败", "INVALID_ARGUMENT");
          return;
        }
        const st = tokenStatus();
        sendJson(res, 200, {
          ok: true,
          email: r.email,
          androidId: r.androidId,
          masterToken: r.masterToken,
          service: config.gsaService,
          tokenTail: st.tokenTail,
          tokenStatus: st,
        });
        return;
      }

      sendError(res, 405, "仅支持 GET / POST", "FAILED_PRECONDITION");
      return;
    }

    if (!authed(req)) {
      sendError(res, 401, "API key missing or invalid", "UNAUTHENTICATED");
      return;
    }

    // 限流在鉴权之后：合法 key 不限流之外的恶意扫描才计（按 IP 滑动窗口）
    if (rateLimited(req)) {
      sendJson(res, 429, {
        error: {
          code: 429,
          message: `Rate limit exceeded: max ${RATE_MAX} requests per ${RATE_WINDOW_MS / 1000}s per IP`,
          status: "RESOURCE_EXHAUSTED",
        },
      });
      return;
    }

    if (req.method === "GET" && path === "/v1beta/models") {
      // 首次（或缓存过期）拉一次真实档位表；失败不影响返回（静态兜底表始终可用）
      const refresh = await refreshModes(false);
      sendJson(res, 200, {
        models: modelListPayload(),
        modesMeta: { ...modesSummary(), refreshOk: refresh.ok },
        // ★ 思考强度：可用档位 + 三种传参写法（见 lib/modes.js 思考强度章节）
        thinkingMeta: thinkingSummary(),
      });
      return;
    }
    if (req.method === "GET" && path === "/v1beta/modes") {
      // 运维/排查用：强制刷新并列出档位全貌（含动态发现到的 id）
      await refreshModes(true);
      sendJson(res, 200, currentModes());
      return;
    }

    const m = path.match(/^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/);
    if (m && req.method === "POST") {
      const body = await readJsonBody(req); // 413 在此拦截
      const model = m[1];
      const verb = m[2];

      // ★ 模型名 → 档位 mode id（Lgauy.#16）。未知名字才付出一次刷新代价，见 lib/modes.js。
      // ★ 同一字符串还可带思考档位后缀（4-argon-high）；后缀剥离后 base 解析失败则回退完整名。
      let modeId = null;
      let modeInfo = null;
      let thinkingLevel = null;   // Lfzqy.#48（1/4/2）
      let thinkingName = null;    // "low"/"medium"/"high"（日志与回显用）
      if (verb !== "countTokens") {
        const split = splitThinkingSuffix(model);
        if (split.level) {
          // ⚠️ resolveMode 是 async —— 漏 await 会拿到 Promise（truthy），
          //   使 modeInfo.modeId 变 undefined ⇒ 模型档位静默丢失、回落账号默认档。
          //   真机验证 out/_think-svc-verify.mjs ④ 曾精确复现此坑（模型名后缀路径）。
          const bySuffix = await resolveMode(split.base);
          if (bySuffix.source !== "miss") {
            modeInfo = bySuffix;
            thinkingLevel = THINKING_LEVELS[split.level];
            thinkingName = split.level;
          }
        }
        if (!modeInfo) modeInfo = await resolveMode(model);
        modeId = modeInfo.modeId ?? (config.robinDefaultMode || null);
        if (modeInfo.source === "miss" && !modeId) {
          console.warn(`[modes] 未识别的模型名 "${model}"，按账号默认档位处理`);
        }

        // ★ 显式参数优先于模型名后缀（Gemini 原生写法 thinkingConfig.thinkingLevel）
        //   generationConfig / thinkingConfig / thinkingLevel 三层都做 camel+snake 双认
        //   （google-genai 各版本序列化不一致，见 §5.12 别名兼容铁律）
        const gc = body?.generationConfig ?? body?.generation_config ?? {};
        const tc = gc.thinkingConfig ?? gc.thinking_config ?? {};
        const raw = tc.thinkingLevel ?? tc.thinking_level ?? gc.thinkingLevel ?? gc.thinking_level;
        if (raw !== undefined && raw !== null) {
          const explicit = parseThinkingLevel(raw);
          if (explicit) {
            thinkingLevel = explicit.value;
            thinkingName = explicit.name;
          } else {
            console.warn(`[thinking] 无法识别的思考档位 ${JSON.stringify(raw)}（可用 low/medium/high 或 1/4/2），已忽略`);
          }
        }
        console.log(
          `[req] model=${model} → mode=${modeId ?? "(账号默认)"}(${modeInfo?.source ?? "-"})` +
          ` thinking=${thinkingName ?? "(未指定→服务端 Low)"}${thinkingLevel !== null ? `(#48=${thinkingLevel})` : ""}`
        );
      }

      // ★ 2026-10-17：档位一律按请求发出 —— robin 不做降级换将/置窗（与调用方
      //   解耦）。账号级降级由 Eidolon 侧收到回显后跨通道处理（ag/gemini-3.8-flash）。

      if (verb === "countTokens") {
        const { text } = geminiToRobin(body);
        sendJson(res, 200, { totalTokens: Math.max(1, Math.ceil(text.length / 4)) });
        return;
      }

      // ── function calling 兼容层（2026-10-15）──
      // 上游私有协议无工具声明位；tools 经 prompt 仿真（toolcall.js）：
      //   请求侧序列化为提示词块 + 历史标记，响应侧解析 function_call 围栏回填。
      //   工具模式下流式走「缓冲→解析→输出」：围栏块不能边到边透出。

      if (verb === "generateContent") {
        const toolMode = hasToolDeclarations(body);
        const deltas = [];
        // 工具模式下不流式透出文本：function_call 围栏块必须整体解析后回填
        //   （边到边输出会把围栏原文泄给调用方，见 toolcall.js）
        let result = await callRobin(body, toolMode ? null : (t) => deltas.push(t), modeId, thinkingLevel, "generateContent");
        // ★ 2026-10-17：降级不重试、不换将 —— 回显原样透出（Eidolon 侧跨通道处理）。
        //   本路径唯一的重试是 callRobin 内的「同模型空响应重试」（empty-retry）。
        const tr = toolMode ? resolveToolResult(body, result) : null;
        const text = tr
          ? tr.cleanText
          : deltas.join("") || result.cumulative || result.texts[result.texts.length - 1] || "";
        if (result.error && !text && !tr?.calls.length) {
          const d = upstreamDiagnosis(result.error);
          sendError(res, 502, d.message, "UNAVAILABLE");
          return;
        }
        // ★ 2026-10-17：usageMetadata 本地估算（上游不回传，见 usage-estimate.js
        //   头部逆向结论）。用途= 相对比较与护栏，**不得用于计费**。
        const est = estimatePromptTokens(body);
        if (est.promptTokens > 0) {
          console.log(
            `[usage] 估算输入 ~${est.promptTokens} tok ` +
            `(text=${est.breakdown.text} img=${est.breakdown.images} audio=${est.breakdown.audio} ` +
            `vidFrame=${est.breakdown.videoFrames} vidAudio=${est.breakdown.videoAudio}) ` +
            `音频${est.inputs.audioSeconds}s 视频${est.inputs.videoSeconds}s` +
            (est.notes.length ? ` | 注: ${est.notes.join("; ")}` : "")
          );
        }
        sendJson(res, 200, withEstimatedUsage(
          makeGeminiResponse(model, text, {
            conversationId: result.conversationId,
            model: result.model,
          }, tr?.calls ?? null),
          est
        ));
        return;
      }

      // streamGenerateContent → SSE
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...CORS,
      });
      const hb = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* 已断开 */
        }
      }, 15_000);

      // 工具模式：缓冲到完整响应后统一解析输出（围栏块不可流式透出）
      if (hasToolDeclarations(body)) {
        // ★ 2026-10-17：降级不重试、不换将（回显透出，Eidolon 侧处理）；
        //   唯一重试 = callRobin 内的同模型空响应重试。
        let result = await callRobin(body, null, modeId, thinkingLevel, "streamGenerateContent");
        clearInterval(hb);
        const tr = resolveToolResult(body, result);
        try {
          if (result.error && !tr?.cleanText && !tr?.calls.length) {
            res.write(sseData(geminiError(502, upstreamDiagnosis(result.error).message, "UNAVAILABLE")));
          } else {
            if (tr?.cleanText) res.write(sseData(makeGeminiChunk(model, tr.cleanText)));
            for (const c of tr?.calls ?? []) res.write(sseData(makeGeminiFunctionCallChunk(model, c)));
            res.write(sseData(makeGeminiChunk(model, "", "STOP")));
          }
          res.end();
        } catch {
          /* 已断开 */
        }
        return;
      }

      let got = false;
      // ⚠️ 真流式：字节已边到边透出，无法撤回重试 ⇒ 空响应重试只在「未透出任何
      //   字节」时安全（callRobin 内已保证）；档位降级按 2026-10-17 决策不重试
      //   不换将，回显随流透出，由 Eidolon 侧跨通道处理。
      const result = await callRobin(body, (t) => {
        got = true;
        try {
          res.write(sseData(makeGeminiChunk(model, t)));
        } catch {
          /* 已断开 */
        }
      }, modeId, thinkingLevel, "streamGenerateContent");
      clearInterval(hb);
      if (result.error && !got) {
        try {
          res.write(sseData(geminiError(502, upstreamDiagnosis(result.error).message, "UNAVAILABLE")));
        } catch {
          /* ignore */
        }
      }
      try {
        res.write(sseData(makeGeminiChunk(model, "", "STOP")));
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }

    /* ── Gemini File API（分片 resumable 上传）★2026-10-15 实现 ────────────
     * 背景：Vercel 入站 4.5MB 硬限 —— 大媒体必须分片，每片 < 4.4MB。
     * 设计：无状态。fileId 用 base64url 编码「push 上传 URL | mime | name」，
     *   finalize 后换成「blobId | mime | name」—— 不依赖任何服务端存储，
     *   跨 Vercel 实例/冷启动均可解析（blobId TTL 1 天，与 push 侧一致）。
     *
     *   POST /upload/v1beta/files            → start：转发 push 初始化，回 x-goog-upload-url
     *   POST|PUT /upload/v1beta/files/<id>   → chunk：按 command/offset 转发 push 侧
     *   GET  /v1beta/files/<id>              → 元数据（解码合成）
     */
    if (path === "/upload/v1beta/files" && req.method === "POST") {
      const cmd = String(req.headers["x-goog-upload-command"] ?? "");
      if (!cmd.includes("start")) {
        sendError(res, 400, "expected x-goog-upload-command: start", "INVALID_ARGUMENT");
        return;
      }
      const totalLen = Number(req.headers["x-goog-upload-header-content-length"] ?? 0);
      const mime = String(req.headers["x-goog-upload-header-content-type"] ?? "application/octet-stream");
      if (!Number.isFinite(totalLen) || totalLen <= 0) {
        sendError(res, 400, "x-goog-upload-header-content-length 缺失或非法", "INVALID_ARGUMENT");
        return;
      }
      if (totalLen > config.maxBodyBytes) {
        sendError(res, 413, `文件超限（${totalLen}B > ${config.maxBodyBytes}B）`, "FAILED_PRECONDITION");
        return;
      }
      try {
        const { uploadUrl } = await pushStart({ length: totalLen, mime });
        const name = String(url.searchParams.get("name") ?? "");
        // fileId 编码 push 侧上传 URL（无状态；chunk 时解出转发目标）
        const fileId = Buffer.from(`${uploadUrl}|${mime}|${name}`, "utf8").toString("base64url");
        const proto = req.headers["x-forwarded-proto"] ?? "https";
        const host = req.headers.host ?? "localhost";
        const selfUrl = `${proto}://${host}/upload/v1beta/files/${fileId}`;
        res.writeHead(200, {
          "x-goog-upload-url": selfUrl,
          "x-goog-upload-status": "active",
          "x-goog-upload-chunk-size": String(Math.min(config.maxBodyBytes, 4 * 1024 * 1024)),
          ...CORS,
        });
        res.end();
      } catch (e) {
        sendError(res, 502, `上传初始化失败: ${e?.message?.slice(0, 200)}`, "UNAVAILABLE");
      }
      return;
    }

    const chunkMatch = /^\/upload\/v1beta\/files\/([A-Za-z0-9_-]+)$/.exec(path);
    if (chunkMatch && (req.method === "POST" || req.method === "PUT")) {
      try {
        const [pushUrl, mime, name] = Buffer.from(chunkMatch[1], "base64url").toString("utf8").split("|");
        if (!pushUrl?.startsWith("https://")) {
          sendError(res, 400, "fileId 无法解析", "INVALID_ARGUMENT");
          return;
        }
        const command = String(req.headers["x-goog-upload-command"] ?? "upload, finalize");
        const offset = Number(req.headers["x-goog-upload-offset"] ?? 0);
        // 读原始 chunk（Vercel 入站上限即分片大小上限）
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > config.maxBodyBytes) {
            sendError(res, 413, `分片超限（>${config.maxBodyBytes}B）`, "FAILED_PRECONDITION");
            return;
          }
          chunks.push(c);
        }
        const body = Buffer.concat(chunks);
        // push.clients6 实测约束：非最终 chunk 必须是 256KB（262144）整数倍，
        // 否则 400 "not a multiple of the 262144 byte chunk granularity"。
        // 提前拦下来给可操作的错误，别把上游原文抛给调用方。
        if (!command.includes("finalize") && body.length % 262144 !== 0) {
          sendError(
            res,
            400,
            `非最终分片必须是 262144 字节（256KB）的整数倍，当前 ${body.length}B。` +
              `最终分片可为任意大小。`,
            "INVALID_ARGUMENT"
          );
          return;
        }
        const r = await pushFinalize(pushUrl, { bytes: body, command, offset, mime });
        if (command.includes("finalize")) {
          if (!r.blobId?.startsWith("/")) {
            sendError(res, 502, `finalize 未返回 blobId: ${r.raw.slice(0, 120)}`, "UNAVAILABLE");
            return;
          }
          const uri = encodeFileUri({ blobId: r.blobId, mime, name });
          sendJson(res, 200, {
            file: {
              name: uri,
              uri,
              mimeType: mime,
              sizeBytes: String(size),
              displayName: name || undefined,
              state: "ACTIVE",
            },
          });
        } else {
          // 中间 chunk（非 finalize）：ack 即可（push 侧 resumable 状态由客户端 offset 跟踪）
          res.writeHead(200, { "x-goog-upload-status": "active", ...CORS });
          res.end();
        }
      } catch (e) {
        sendError(res, 502, `分片上传失败: ${e?.message?.slice(0, 200)}`, "UNAVAILABLE");
      }
      return;
    }

    const fileMetaMatch = /^\/v1beta\/files\/([A-Za-z0-9_-]+)$/.exec(path);
    if (fileMetaMatch && req.method === "GET") {
      const ref = decodeFileUri(`files/${fileMetaMatch[1]}`);
      if (!ref) {
        sendError(res, 404, "file not found (or expired: blobId TTL = 1 day)", "NOT_FOUND");
        return;
      }
      sendJson(res, 200, {
        file: {
          name: `files/${fileMetaMatch[1]}`,
          uri: `files/${fileMetaMatch[1]}`,
          mimeType: ref.mime || "application/octet-stream",
          displayName: ref.name || undefined,
          state: "ACTIVE",
        },
      });
      return;
    }

    sendError(res, 404, `未知路由：${req.method} ${path}`, "NOT_FOUND");
  } catch (err) {
    const code = err?.statusCode ?? 500;
    if (!res.headersSent) {
      sendError(res, code, err?.message ?? "内部错误");
    } else {
      res.end();
    }
  }
}
