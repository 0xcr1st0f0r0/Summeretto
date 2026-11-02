// service/lib/admin-api.js —— /admin 后台：鉴权（Cookie）、状态聚合、心跳、额度
//
// ★ 设计要点：
//   ① 鉴权用**签名 Cookie**（HMAC-SHA256，密钥 = ADMIN_KEY），而不是把 key 塞进页面 JS。
//      页面登录后拿到的只是签名串，服务端据此判定身份；ADMIN_KEY 本身不落前端。
//      老的 `x-admin-key` 请求头仍然可用（脚本 / curl 场景不受影响）。
//   ② 状态聚合**只读**：不碰凭证、不发推理请求，纯粹把各模块的状态函数拼起来。
//   ③ 额度查询**走独立子进程**（optional/usage-info/query.mjs）—— 那个 CLI 明确
//      「never imported by the gateway」，保持隔离；顺带避免第二个 HTTP/2 会话
//      去和主会话抢同一份凭证状态。
//   ④ 心跳分两层：PING（传输层存活）+ GetUserStatus（端到端：令牌 + 上游）。

import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { tokenStatus, credentialHealth } from "./auth.js";
import { modesSummary, thinkingSummary } from "./modes.js";
import { guardStatus } from "./degrade-guard.js";
import { shimStatus } from "./mediashim.js";
import { emptyRetryStatus } from "./empty-retry.js";
import { dedupStatus } from "./dedup.js";
import { inflightStatus } from "./inflight.js";
import { sessionStatus, pingRobinSession, getUserStatus } from "./robin.js";
import { logSnapshot, logBufferStatus } from "./log-buffer.js";

const COOKIE_NAME = "summeretto_admin";
const COOKIE_MAX_AGE_S = 12 * 3600;

/* ─────────────────────────── 鉴权 ─────────────────────────── */

/** admin 端点是否启用（未配置 ADMIN_KEY 则整体关闭） */
export function adminEnabled() {
  return Boolean(config.adminKey);
}

function hmac(payload) {
  return createHmac("sha256", config.adminKey).update(payload).digest("base64url");
}

/**
 * 已作废 Cookie 的签发时点：退出登录时置为「此刻」，
 * 早于该时点签发的 Cookie 一律作废。
 *
 * 为什么需要：只让浏览器删 Cookie 的话，**手工重放旧 Cookie 仍可用**
 * （签名在有效期内一直成立）—— 那样的「退出登录」是假的。
 * 单管理员场景下「退出即作废全部会话」语义简单且符合直觉。
 * （进程内状态：重启即清空，所有旧 Cookie 随之作废。）
 */
let revokedBefore = 0;

/** 签发登录 Cookie 的值 */
export function issueAdminCookie() {
  const issued = String(Date.now());
  return `${issued}.${hmac(issued)}`;
}

/** 退出登录：作废当前所有已签发的 Cookie */
export function revokeAdminCookies() {
  revokedBefore = Date.now();
}

/** 校验 Cookie 签名、时效与作废状态（定时安全比较） */
export function verifyAdminCookie(raw) {
  if (!raw || !config.adminKey) return false;
  const text = String(raw);
  const dot = text.indexOf(".");
  if (dot <= 0) return false;
  const issued = text.slice(0, dot);
  const sig = text.slice(dot + 1);
  const expect = hmac(issued);
  if (sig.length !== expect.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  const issuedMs = Number(issued);
  if (!Number.isFinite(issuedMs)) return false;
  if (issuedMs <= revokedBefore) return false; // 已被退出登录作废
  const ageMs = Date.now() - issuedMs;
  if (ageMs < 0 || ageMs > COOKIE_MAX_AGE_S * 1000) return false;
  return true;
}

/** 从请求头解析 Cookie 字典 */
export function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie;
  if (!raw) return out;
  for (const part of String(raw).split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Cookie 或请求头任一通过即放行 */
export function adminAuthed(req) {
  if (!config.adminKey) return false;
  if (req.headers?.["x-admin-key"] === config.adminKey) return true;
  return verifyAdminCookie(parseCookies(req)[COOKIE_NAME]);
}

export const ADMIN_COOKIE_NAME = COOKIE_NAME;
export const ADMIN_COOKIE_MAX_AGE_S = COOKIE_MAX_AGE_S;

/* ─────────────────────────── 状态聚合 ─────────────────────────── */

/**
 * 后台首页要的全量状态。全部来自各模块自己的状态函数，**不产生任何副作用**。
 */
export function adminState() {
  const ts = tokenStatus();
  const cred = credentialHealth();
  const mem = process.memoryUsage();
  return {
    ok: true,
    service: "summeretto",
    upstream: config.robinUrl,
    ts: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    memory: {
      rssMb: Math.round((mem.rss / 1048576) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      heapTotalMb: Math.round((mem.heapTotal / 1048576) * 10) / 10,
    },
    auth: ts.source !== "none" ? ts.source : "missing",
    credential: { ...cred, ...ts.gpsoauth },
    inflight: inflightStatus(),
    dedup: dedupStatus(),
    emptyRetry: emptyRetryStatus(),
    degradeGuard: guardStatus(),
    mediaShim: shimStatus(),
    modes: modesSummary(),
    thinking: thinkingSummary(),
    session: sessionStatus(),
    logBuffer: logBufferStatus(),
    limits: {
      maxBodyBytes: config.maxBodyBytes,
      maxAttachments: config.maxAttachments,
      isolateConversations: config.isolateConversations,
      rateLimitMax: config.rateLimitMax,
      robinTimeoutMs: config.robinTimeoutMs,
      robinIdleMs: config.robinIdleMs,
      credentialPersist: Boolean(config.envFilePath),
    },
  };
}

/** 最近日志 */
export function adminLogs(limit) {
  return { ok: true, entries: logSnapshot(limit), buffer: logBufferStatus() };
}

/* ─────────────────────────── 心跳测试 ─────────────────────────── */

/**
 * 心跳：两层
 *   ① ping —— HTTP/2 传输层存活（半死连接只有它能暴露）
 *   ② upstream —— GetUserStatus 端到端（令牌有效 + 上游可达 + 档位表可取）
 */
export async function runHeartbeat({ pingTimeoutMs = 5000, upstreamTimeoutMs = 15000 } = {}) {
  const started = Date.now();
  const ping = await pingRobinSession({ timeoutMs: pingTimeoutMs });

  let upstream;
  const t0 = Date.now();
  try {
    const r = await getUserStatus({ timeoutMs: upstreamTimeoutMs });
    upstream = {
      ok: Boolean(r?.ok),
      ms: Date.now() - t0,
      grpcStatus: r?.grpcStatus ?? null,
      grpcMessage: r?.grpcMessage ?? null,
      error: r?.error ?? null,
      modeCount: Array.isArray(r?.modes) ? r.modes.length : null,
    };
  } catch (err) {
    upstream = { ok: false, ms: Date.now() - t0, error: err?.message ?? String(err) };
  }

  return {
    ok: Boolean(ping.ok && upstream.ok),
    ts: new Date().toISOString(),
    totalMs: Date.now() - started,
    ping,
    upstream,
    session: sessionStatus(),
  };
}

/* ─────────────────────────── 额度查询 ─────────────────────────── */

/**
 * 额度：调独立 CLI（optional/usage-info/query.mjs --enable）拿 JSON。
 * 刻意不把它的模块 import 进网关 —— 那个 CLI 的隔离是有意为之的。
 */
export function runUsageQuery({ timeoutMs = 60_000 } = {}) {
  const script = fileURLToPath(new URL("../optional/usage-info/query.mjs", import.meta.url));
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => {
      done({ ok: false, error: "query_timeout" });
    }, timeoutMs);

    execFile(
      process.execPath,
      [script, "--enable"],
      { env: process.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        const line = String(stdout ?? "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1);
        if (!line) {
          done({ ok: false, error: err ? `spawn_failed: ${err.message}` : "no_output" });
          return;
        }
        try {
          const j = JSON.parse(line);
          done({ ...j, checkedAt: j.checkedAt ?? new Date().toISOString() });
        } catch {
          done({ ok: false, error: "bad_json", raw: line.slice(0, 400), stderr: String(stderr ?? "").slice(0, 400) });
        }
      },
    );
  });
}
