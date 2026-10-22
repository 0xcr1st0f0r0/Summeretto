// service/lib/auth.js — Robin 凭证（OAuth access token）管理
//
// 背景（见 docs/credential-acquisition.md）：
//   Robin gRPC 需要 `authorization: Bearer <ya29.*>`，scope = .../auth/assistant。
//
// token 来源优先级（高 → 低）：
//   1. 注入缓存   —— POST /admin/token 写入（携带 expiresIn）
//   2. 供应商拉取 —— TOKEN_PROVIDER_URL（设备侧常驻脚本暴露的 HTTP 端点），
//                    带 30s 结果缓存，避免每个请求都打过去
//   3. ★ 网页登录方案 —— GSA_MASTER_TOKEN（oauth2rt_1/...，长期有效）：
//                    按需调 perform_oauth 现取 ya29.* 访问令牌并缓存到期。
//                    这一条**不依赖任何设备**，是 Vercel 上的主推方案。
//   4. 环境变量   —— ROBIN_AUTH_TOKEN（静态兜底 / 冷启动时的最后防线）
//
// 过期判定带 90 秒提前量：token 中途失效比"多用 90 秒"代价大得多。
//
// ★ 为什么 3 比 4 好：ROBIN_AUTH_TOKEN 是某个瞬间的快照，一小时后就死了；
//   而 master token 长期有效，能无限次换取新的访问令牌 → 服务可自主续期。

import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { config } from "./config.js";
import {
  AGSA_PKG,
  ASSISTANT_SERVICE,
  exchangeToken,
  normalizeAndroidId,
  performOauth,
  randomAndroidId,
} from "./gpsoauth.js";

const EXPIRY_SKEW_MS = 90_000;
const DEFAULT_ACCESS_TTL_MS = 3600_000;

const state = {
  // { token: string, expiresAt: number(ms), injectedAt: number, account?: string }
  injected: null,
  // { token: string, fetchedAt: number, account?: string }
  providerCache: null,
  // ── 网页登录方案状态 ──
  gsa: {
    email: config.gsaEmail || null,
    masterToken: config.gsaMasterToken || null,
    androidId: normalizeAndroidId(config.gsaAndroidId),
    // "env" = 来自环境变量（Vercel 上的正式部署方式）
    // "runtime" = 本次进程内经 /admin/gpsoauth 现场绑定（冷启动后失效）
    origin: config.gsaMasterToken ? "env" : null,
    boundAt: null,
    // ★ 铸造（master token → ya29.*）的成败统计。
    //   为什么需要：`.env` 里配了 GSA_MASTER_TOKEN 只说明"配置齐全"，
    //   不说明"还能用"。2026-10-17 实测踩中过——token 早已被 Google 撤销
    //   （perform_oauth 403 BadAuthentication），而 healthz 仍报
    //   "configured (gpsoauth)"，构成假信号：配置看着正常，请求却全部
    //   auth-failure 零额度返回。这三个计数让 healthz 一眼能分辨。
    mintOk: 0,          // 成功换出 ya29.* 的次数
    mintFail: 0,        // 换取失败的次数
    lastMintOkAt: 0,    // 最后一次成功（ms）
    lastMintFailAt: 0,  // 最后一次失败（ms）
    lastMintError: null,// 最后一次失败的原因（成功时清空）
  },
  // 由 master token 换出的访问令牌（短命，自动续期）
  minted: { token: null, expiresAt: 0, mintedAt: 0, error: null },
};

function isFresh(expiresAt) {
  return typeof expiresAt === "number" && expiresAt - EXPIRY_SKEW_MS > Date.now();
}

/** 注入 token（POST /admin/token 调用）。expiresIn 单位秒，默认 3600。 */
export function setInjectedToken(token, expiresInSec = 3600, account) {
  const ttl = Math.max(60, Number(expiresInSec) || 3600) * 1000;
  state.injected = {
    token: String(token).trim(),
    expiresAt: Date.now() + ttl,
    injectedAt: Date.now(),
    account: account ?? null,
  };
  return tokenStatus();
}

/**
 * androidId：显式配置优先；否则由 master token 派生。
 * 派生法保证**跨冷启动稳定**——Vercel 无状态，存不住随机值，
 * 而 androidId 频繁变化可能触发 Google 侧风控。
 */
function androidIdFor() {
  if (state.gsa.androidId) return state.gsa.androidId;
  if (!state.gsa.masterToken) return randomAndroidId();
  return createHash("sha256").update(state.gsa.masterToken).digest("hex").slice(0, 16);
}

/**
 * ★ 用 master token 现取一个 ya29.* 访问令牌（带缓存）。
 * @param {boolean} force 忽略缓存强制重取
 * @returns {Promise<string>} 空串 = 取不到
 */
export async function mintAccessToken(force = false) {
  const gsa = state.gsa;
  if (!gsa.masterToken) return "";
  if (!force && state.minted.token && isFresh(state.minted.expiresAt)) {
    return state.minted.token;
  }
  if (!gsa.email) {
    state.minted.error = "缺少 GSA_EMAIL（网页登录时所用账号邮箱）";
    noteMintFailure(state.minted.error);
    console.warn("[auth] gpsoauth:", state.minted.error);
    return state.minted.token || "";
  }

  // ★ 重试一次（2026-10-20 实测）：android.clients.google.com 偶发 20s 超时
  //   （同一时刻同一凭证在另一个进程里 0.6s 就铸成功 ⇒ 是**瞬时网络/端点抖动**，
  //   不是凭证失效）。旧实现一超时就直接判失败 ⇒ 该次请求零额度返回 502，
  //   且（配合当时 dedup 的缓存缺陷）后续 90s 的同 payload 请求全被重放成同一错误。
  //   ⇒ 这里对「网络类失败」重试一次（仅网络错误，不对 403 BadAuthentication 重试 ——
  //   那是凭证真的被撤销，重试无用）。
  const ATTEMPTS = 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await performOauth({
        email: gsa.email,
        masterToken: gsa.masterToken,
        androidId: androidIdFor(),
        service: config.gsaService || ASSISTANT_SERVICE,
        app: config.gsaApp || AGSA_PKG,
      });
      if (!res.token || !res.token.startsWith("ya29.")) {
        state.minted.error =
          `perform_oauth 未返回 ya29 令牌（HTTP ${res.status}）` +
          (res.fields.Error ? `：${res.fields.Error}` : "");
        noteMintFailure(state.minted.error);
        console.warn("[auth]", state.minted.error, JSON.stringify(res.fields).slice(0, 400));
        return state.minted.token || ""; // 保留旧值，聊胜于无
      }

      const ttlMs = (res.expiresInSec ?? 3600) * 1000;
      state.minted = {
        token: res.token,
        expiresAt: Date.now() + ttlMs,
        mintedAt: Date.now(),
        error: null,
      };
      noteMintSuccess();
      console.log(`[auth] 已用 master token 换取新访问令牌（TTL ${ttlMs / 1000}s）`);
      return res.token;
    } catch (err) {
      lastErr = err;
      const transient = /超时|timeout|ECONN|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(
        String(err?.message ?? err)
      );
      if (!transient || attempt === ATTEMPTS) break;
      console.warn(`[auth] 取令牌遇瞬时网络错误（${err?.message}），${800 * attempt}ms 后重试一次`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  state.minted.error = `mint 失败：${lastErr?.message}`;
  noteMintFailure(state.minted.error);
  console.warn("[auth]", state.minted.error);
  return state.minted.token || "";
}

/** 记录一次铸造失败（供 healthz 判定；不改变任何请求行为）。 */
function noteMintFailure(err) {
  state.gsa.mintFail += 1;
  state.gsa.lastMintFailAt = Date.now();
  state.gsa.lastMintError = err;
}

/** 记录一次铸造成功（成功后错误即失效——latest-wins 语义）。 */
function noteMintSuccess() {
  state.gsa.mintOk += 1;
  state.gsa.lastMintOkAt = Date.now();
  state.gsa.lastMintError = null;
}

/** 丢弃已缓存的铸造令牌（Robin 返回 UNAUTHENTICATED 时调用，触发下次重取）。 */
export function invalidateMintedToken() {
  state.minted = { token: null, expiresAt: 0, mintedAt: 0, error: null };
}

/** 当前是否具备"用 master token 重取令牌"的能力（robin.js 的失效重试用）。 */
export function canRemint() {
  return Boolean(state.gsa.masterToken);
}

/**
 * ★ 一次性绑定：用网页登录拿到的 oauth_token 换取 master token 并记入内存。
 * 对应 gpsoauth 的 exchange_token（service=ac2dm）。
 *
 * 注意：运行时绑定只存活到本进程结束。Vercel 上正式做法是把返回的
 * masterToken 写进环境变量 GSA_MASTER_TOKEN（/login 页面会引导）。
 *
 * @returns {Promise<{ok: boolean, masterToken?: string, email?: string, androidId?: string, error?: string, fields?: object}>}
 */
export async function bindGpsoauth({ email, oauthToken, androidId } = {}) {
  if (!email || !oauthToken) {
    return { ok: false, error: "需要 email 与 oauthToken" };
  }
  const aid = normalizeAndroidId(androidId) ?? normalizeAndroidId(config.gsaAndroidId) ?? randomAndroidId();

  let res;
  try {
    res = await exchangeToken({ email, oauthToken, androidId: aid });
  } catch (err) {
    return { ok: false, error: `exchange_token 请求失败：${err?.message}` };
  }

  if (!res.masterToken) {
    return {
      ok: false,
      error:
        `exchange_token 未返回 master token（HTTP ${res.status}）` +
        (res.fields.Error ? `：${res.fields.Error}` : ""),
      fields: res.fields,
    };
  }

  // 换了凭证 ⇒ 旧的铸造统计不再有意义，整体重置（否则 verdict 会拿
  // 上一份凭证的失败记录误判新凭证）。
  state.gsa = {
    email: res.fields.Email || email,
    masterToken: res.masterToken,
    androidId: aid,
    origin: "runtime",
    boundAt: Date.now(),
    mintOk: 0,
    mintFail: 0,
    lastMintOkAt: 0,
    lastMintFailAt: 0,
    lastMintError: null,
  };
  invalidateMintedToken();

  // ★ 落盘到 .env（2026-10-17）。没有这一步，每次重启服务都会退回
  //   .env 里的旧 master token —— 而那个多半已失效，于是表现为
  //   「刚绑定成功、一重启就又auth-failure」。本轮实测踩中：17:24 绑定成功
  //   （origin=runtime，尾部…fuwWlCs=），17:50 重启后回落 origin=env
  //   （尾部…2ch_PWs=，perform_oauth 403 BadAuthentication）。
  //   落盘失败**不阻断绑定**（内存里已可用），只告警。
  try {
    const persisted = persistGsaToEnvFile({
      email: state.gsa.email,
      masterToken: res.masterToken,
      androidId: aid,
    });
    if (persisted.ok) {
      console.log(`[auth] 已把新 master token 落盘到 ${persisted.path}（重启后仍可用）`);
    } else {
      console.warn(`[auth] ⚠️ master token 落盘失败：${persisted.error} —— 本次可用，但服务重启后会退回 .env 里的旧 token`);
    }
  } catch (err) {
    console.warn(`[auth] ⚠️ master token 落盘异常：${err?.message ?? err}（重启后会退回 .env 旧 token）`);
  }

  // 立刻验证一次：能换出 ya29.* 才算真的可用
  const token = await mintAccessToken(true);
  return {
    ok: Boolean(token),
    masterToken: res.masterToken,
    email: state.gsa.email,
    androidId: aid,
    error: token ? undefined : state.minted.error || "master token 有效但未能换出访问令牌",
  };
}

/**
 * 把 GSA 凭证写回磁盘 .env（原地更新 GSA_* 三行，保留其余内容与注释）。
 *
 * 为什么不新写一个文件：run.sh 以 `set -a; . ../.env` 加载，换路径就得改
 *  systemd/run.sh 两处；而原地更新 GSA_* 三行是幂等且最小影响的。
 *
 * 安全：文件按 0600 写入（凭证文件），写临时文件 + rename 保证原子性，
 * 避免写到一半被 run.sh 读到残缺内容。
 *
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
function persistGsaToEnvFile({ email, masterToken, androidId }) {
  const envPath = config.envFilePath;
  if (!envPath) return { ok: false, error: "未配置 env 文件路径（ROBIN_ENV_FILE）" };
  try {
    const original = readFileSync(envPath, "utf8");
    const lines = original.split(/\r?\n/);
    const values = {
      GSA_EMAIL: email,
      GSA_MASTER_TOKEN: masterToken,
      GSA_ANDROID_ID: androidId,
    };
    const seen = new Set();
    const next = lines.map((line) => {
      const m = /^([A-Z_]+)=/.exec(line);
      if (!m || !(m[1] in values)) return line;
      seen.add(m[1]);
      // 保留原有的键名前缀与行结构，只换值。
      return `${m[1]}=${values[m[1]]}`;
    });
    // 缺失的键追加到末尾（带注释说明来源，避免下次又看不懂）
    for (const [k, v] of Object.entries(values)) {
      if (!seen.has(k)) next.push(`${k}=${v}`);
    }
    const tmp = `${envPath}.tmp-${process.pid}`;
    writeFileSync(tmp, next.join("\n"), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, envPath);
    try {
      chmodSync(envPath, 0o600);
    } catch { /* 某些文件系统不支持 chmod，忽略 */ }
    return { ok: true, path: envPath };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** 测试钩子：设置 master token 与铸造统计（不发网络请求）。 */
export function __setGsaForTest({ masterToken, email, origin, mintOk, mintFail, lastMintOkAt, lastMintFailAt, lastMintError }) {
  state.gsa.masterToken = masterToken ?? state.gsa.masterToken;
  if (email !== undefined) state.gsa.email = email;
  if (origin !== undefined) state.gsa.origin = origin;
  if (mintOk !== undefined) state.gsa.mintOk = mintOk;
  if (mintFail !== undefined) state.gsa.mintFail = mintFail;
  if (lastMintOkAt !== undefined) state.gsa.lastMintOkAt = lastMintOkAt;
  if (lastMintFailAt !== undefined) state.gsa.lastMintFailAt = lastMintFailAt;
  if (lastMintError !== undefined) state.gsa.lastMintError = lastMintError;
}

/** 测试钩子：直接设置铸造出的访问令牌状态。 */
export function __setMintedForTest({ token, expiresAt }) {
  state.minted.token = token;
  state.minted.expiresAt = expiresAt;
  state.minted.mintedAt = token ? Date.now() : 0;
  state.minted.error = null;
}

/** 测试钩子：清空注入/ provider 缓存与全部凭证状态。 */
export function __resetAuthForTest() {
  state.injected = null;
  state.providerCache = null;
  state.minted = { token: null, expiresAt: 0, mintedAt: 0, error: null };
  state.gsa = {
    email: config.gsaEmail || null,
    masterToken: config.gsaMasterToken || null,
    androidId: normalizeAndroidId(config.gsaAndroidId),
    origin: config.gsaMasterToken ? "env" : null,
    boundAt: null,
    mintOk: 0,
    mintFail: 0,
    lastMintOkAt: 0,
    lastMintFailAt: 0,
    lastMintError: null,
  };
}

/** 供 /admin/* 与 /healthz 查询用 */
export function tokenStatus() {
  const src = state.injected
    ? "injected"
    : state.providerCache
      ? "provider"
      : state.gsa.masterToken
        ? "gpsoauth"
        : config.robinAuthToken
          ? "env"
          : "none";

  const cur = state.injected ?? (state.gsa.masterToken ? state.minted : null) ?? state.providerCache ?? null;

  return {
    source: src,
    account: state.injected?.account ?? state.gsa.email ?? state.providerCache?.account ?? null,
    expiresAt: state.injected?.expiresAt != null ? new Date(state.injected.expiresAt).toISOString() : null,
    expiresInSec:
      state.injected?.expiresAt != null
        ? Math.max(0, Math.round((state.injected.expiresAt - Date.now()) / 1000))
        : state.minted.expiresAt
          ? Math.max(0, Math.round((state.minted.expiresAt - Date.now()) / 1000))
          : null,
    tokenTail: cur?.token
      ? `…${cur.token.slice(-8)}`
      : config.robinAuthToken
        ? `…${config.robinAuthToken.slice(-8)}`
        : null,
    // 网页登录方案详情
    gpsoauth: {
      bound: Boolean(state.gsa.masterToken),
      origin: state.gsa.origin, // "env" | "runtime" | null
      masterTokenTail: state.gsa.masterToken ? `…${state.gsa.masterToken.slice(-8)}` : null,
      service: config.gsaService,
      app: config.gsaApp,
      mintedAt: state.minted.mintedAt ? new Date(state.minted.mintedAt).toISOString() : null,
      error: state.minted.error,
      // ★ 铸造成败统计（区分"配了"与"还能用"）
      mintOk: state.gsa.mintOk,
      mintFail: state.gsa.mintFail,
      lastMintOkAt: state.gsa.lastMintOkAt ? new Date(state.gsa.lastMintOkAt).toISOString() : null,
      lastMintFailAt: state.gsa.lastMintFailAt ? new Date(state.gsa.lastMintFailAt).toISOString() : null,
      lastMintError: state.gsa.lastMintError,
    },
  };
}

/**
 * ★ 凭证可用性判定（healthz 专用，纯被动——不发任何网络请求）。
 *
 * 存在的理由：`auth: "configured (gpsoauth)"` 只反映"`.env` 里有没有配"，
 * 不反映"那个 token 还有没有效"。2026-10-17 实测踩中——master token 早已被
 * Google 撤销（perform_oauth 403 BadAuthentication），healthz 却一直显示
 * configured，只有翻 journal 才发现。这个判定把状态分成四档：
 *
 *| verdict | 含义 | 该做什么 |
 *   |--------|------|----------|
 *   | `unbound` | 没有任何凭证 | 走 `/login` 绑定 |
 *   | `unverified` | 配了但本进程还没成功换过令牌 | 正常；等首个请求或 `?action=mint` |
 *   | `valid` | 最近一次铸造成功，且令牌仍在有效期内 | 正常 |
 *   | `stale` | 配了但最近一次铸造失败 | ★ 重新绑定；请求会 auth-failure 且零额度 |
 *
 * `expired` 单独一档：master token 成功换过令牌、只是访问令牌到期等下次续期，
 * 属正常状态，不该报警。
 *
 * @returns {{verdict: string, usable: boolean, checked: boolean, reason: string|null}}
 */
export function credentialHealth() {
  const gsa = state.gsa;
  if (!gsa.masterToken && !state.injected && !state.providerCache && !config.robinAuthToken) {
    return { verdict: "unbound", usable: false, checked: true, reason: "未配置任何 Robin 凭证" };
  }
  if (state.injected && isFresh(state.injected.expiresAt)) {
    return { verdict: "valid", usable: true, checked: true, reason: null };
  }
  if (!gsa.masterToken) {
    // 走的是注入 / provider / 静态 env 兜底路径，不经过 master token 铸造
    return { verdict: "unverified", usable: Boolean(config.robinAuthToken || state.providerCache), checked: false, reason: null };
  }

  const fresh = isFresh(state.minted.expiresAt);
  if (fresh) {
    return { verdict: "valid", usable: true, checked: true, reason: null };
  }
  // 令牌不在有效期内：区分"刚过期待续期"与"铸造本身失败"
  if (gsa.mintFail > 0 && (!gsa.lastMintOkAt || gsa.lastMintFailAt > gsa.lastMintOkAt)) {
    return {
      verdict: "stale",
      usable: false,
      checked: true,
      reason: gsa.lastMintError ?? state.minted.error ?? "master token 已无法换取访问令牌",
    };
  }
  if (gsa.mintOk > 0) {
    return { verdict: "expired", usable: true, checked: true, reason: null };
  }
  return { verdict: "unverified", usable: true, checked: false, reason: null };
}

/**
 * 取当前可用的 Robin token。
 * @returns {Promise<string>} 空串 = 无可用凭证（调用方应返回 UNAUTHENTICATED 提示）
 */
export async function getRobinToken() {
  // 1. 注入缓存
  if (state.injected && isFresh(state.injected.expiresAt)) {
    return state.injected.token;
  }

  // 2. 供应商拉取（带 TTL 缓存 + 失败回退）
  if (config.tokenProviderUrl) {
    const c = state.providerCache;
    if (c && Date.now() - c.fetchedAt < config.tokenProviderTtlMs) {
      return c.token;
    }
    try {
      const res = await fetch(config.tokenProviderUrl, {
        headers: config.tokenProviderKey
          ? { "x-provider-key": config.tokenProviderKey }
          : undefined,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const j = await res.json();
        if (j && typeof j.token === "string" && j.token.startsWith("ya29.")) {
          state.providerCache = {
            token: j.token,
            fetchedAt: Date.now(),
            account: j.account ?? null,
          };
          return j.token;
        }
      }
      console.warn("[auth] token provider 返回无效内容:", res.status);
    } catch (err) {
      console.warn("[auth] token provider 拉取失败:", err?.message);
      // 失败时沿用旧缓存（可能已过期，但聊胜于无）
      if (c) return c.token;
    }
  }

  // 3. ★ 网页登录方案：master token → 现取访问令牌（自动续期）
  if (state.gsa.masterToken) {
    const t = await mintAccessToken();
    if (t) return t;
  }

  // 4. 环境变量兜底
  return config.robinAuthToken || "";
}
