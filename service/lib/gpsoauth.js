// service/lib/gpsoauth.js —— Google Play Services OAuth 客户端（零依赖）
//
// 这是 tools/gpsoauth.py 的 Node 移植版，用于在服务端**自行获取** Robin 凭证。
//
// ┌─ 完整链路 ─────────────────────────────────────────────────────────────┐
// │ ①【人】浏览器打开 accounts.google.com/EmbeddedSetup?…&tmpl=new_account  │
// │   登录 → 同意 → cookie 里出现 `oauth_token`                            │
// │ ②【本模块】exchangeToken()  oauth_token → master token（长期有效）     │
// │ ③【本模块】performOauth()   master token → ya29.* Bearer（约 1h）      │
// └────────────────────────────────────────────────────────────────────────┘
//
// 关键前提（本项目已验证）：
//   AGSA 的签名证书 SHA-1 = 38918a453d07199354f8b19af05ec6562ced5788
//   = 与 com.google.android.gms 同一张 Google 平台证书（见 tools/apksig.py）。
//   服务端以 client_sig 判定调用者身份 → 我们"冒充"AGSA 时签名校验天然通过。
//
// ⚠️ TLS 禁忌（gpsoauth 上游血泪教训，实测确认）：
//   · 请求**不能带 ALPN 扩展** → 否则 403 BadAuthentication
//   · **不能置位 SSL_OP_NO_TICKET** → 否则 403 BadAuthentication
//   Node 的 node:https 默认两者皆满足；下方仍显式加固以防未来默认值变化。

import https from "node:https";
import { constants as cryptoConstants, randomBytes } from "node:crypto";
import { URLSearchParams } from "node:url";

// ─────────────────────────── 常量 ───────────────────────────

export const AUTH_HOST = "android.clients.google.com";
export const AUTH_PATH = "/auth";
export const USER_AGENT = "GoogleAuth/1.4"; // Google 端硬性要求

/** AGSA 签名证书 SHA-1（= GMS 的），由 tools/apksig.py 从 APK 实测得出。 */
export const CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788";

export const GPS_VERSION = "240913000"; // google_play_services_version
export const DROIDGUARD_DUMMY = "dummy123"; // 假值即被接受（gpsoauth 同款）

export const AGSA_PKG = "com.google.android.googlequicksearchbox";
export const ASSISTANT_SCOPE = "https://www.googleapis.com/auth/assistant";
export const ASSISTANT_SERVICE = `oauth2:${ASSISTANT_SCOPE}`;

export const EMBEDDED_SETUP_URL = "https://accounts.google.com/EmbeddedSetup";
export const EMBEDDED_REAUTH_URL = "https://accounts.google.com/embedded/reauth/v2/android";
export const COOKIE_OAUTH_TOKEN = "oauth_token";

const DEFAULT_TIMEOUT_MS = 20_000;

// ─────────────────────────── 底层请求 ───────────────────────────

/** 响应是"一行一个 key=value"，不是 JSON。空行忽略。 */
export function parseAuthResponse(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return out;
}

/**
 * POST 表单到 Google /auth 端点。
 * @returns {Promise<{fields: object, status: number, raw: string}>}
 */
export function postAuthForm(params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.append(k, String(v));
  }
  const body = sp.toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: AUTH_HOST,
        path: AUTH_PATH,
        method: "POST",
        // agent:false → 每个请求用一次性连接，杜绝连接池带来的 ALPN/会话复用干扰
        agent: false,
        // 显式声明 secureOptions：只要 SSLv2/SSLv3 关闭，**不含** SSL_OP_NO_TICKET
        secureOptions: cryptoConstants.SSL_OP_NO_SSLv2 | cryptoConstants.SSL_OP_NO_SSLv3,
        headers: {
          "accept-encoding": "identity",
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
          "user-agent": USER_AGENT,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ fields: parseAuthResponse(raw), status: res.statusCode, raw });
        });
      },
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`auth 端点超时 (${timeoutMs}ms)`)));
    req.on("error", reject);
    req.end(body);
  });
}

// ─────────────────────────── 两个协议动作 ───────────────────────────

function baseDeviceFields({ email, androidId, deviceCountry, operatorCountry, lang, sdkVersion }) {
  return {
    accountType: "HOSTED_OR_GOOGLE",
    Email: email,
    has_permission: 1,
    source: "android",
    androidId,
    device_country: deviceCountry ?? "us",
    operatorCountry: operatorCountry ?? "us",
    lang: lang ?? "en",
    sdk_version: sdkVersion ?? 31,
    google_play_services_version: GPS_VERSION,
  };
}

/**
 * exchange_token 的完整表单（纯函数，便于测试与审计）。
 * 契约来源：gpsoauth/__init__.py:191-209 + microG LoginActivity.retrieveRtToken()。
 */
export function buildExchangeData({
  email,
  oauthToken,
  androidId,
  service = "ac2dm",
  clientSig = CLIENT_SIG,
  deviceCountry,
  operatorCountry,
  lang,
  sdkVersion,
} = {}) {
  return {
    ...baseDeviceFields({ email, androidId, deviceCountry, operatorCountry, lang, sdkVersion }),
    add_account: 1,
    ACCESS_TOKEN: 1,
    Token: oauthToken, // ← 网页 oauth_token 放在 Token 字段
    service,
    client_sig: clientSig,
    callerSig: clientSig,
    droidguard_results: DROIDGUARD_DUMMY,
  };
}

/**
 * perform_oauth 的完整表单（纯函数）。
 * 契约来源：gpsoauth/__init__.py:244-259。
 * 注意 master token 是放在 `EncryptedPasswd` 字段里的（历史命名，与密码无关）。
 */
export function buildOauthData({
  email,
  masterToken,
  androidId,
  service = ASSISTANT_SERVICE,
  app = AGSA_PKG,
  clientSig = CLIENT_SIG,
  deviceCountry,
  operatorCountry,
  lang,
  sdkVersion,
} = {}) {
  return {
    ...baseDeviceFields({ email, androidId, deviceCountry, operatorCountry, lang, sdkVersion }),
    EncryptedPasswd: masterToken,
    service,
    app,
    client_sig: clientSig,
  };
}

/** ② 网页 oauth_token → master token。 */
export async function exchangeToken({
  email,
  oauthToken,
  androidId,
  service = "ac2dm",
  clientSig = CLIENT_SIG,
  deviceCountry,
  operatorCountry,
  lang,
  sdkVersion,
  timeoutMs,
} = {}) {
  if (!email || !oauthToken) throw new Error("exchangeToken 需要 email 与 oauthToken");
  if (!androidId) throw new Error("exchangeToken 需要 androidId");

  const { fields, status, raw } = await postAuthForm(
    buildExchangeData({
      email,
      oauthToken,
      androidId,
      service,
      clientSig,
      deviceCountry,
      operatorCountry,
      lang,
      sdkVersion,
    }),
    { timeoutMs },
  );

  return { masterToken: fields.Token || null, fields, status, raw };
}

/** ③ master token → 目标服务访问令牌。 */
export async function performOauth({
  email,
  masterToken,
  androidId,
  service = ASSISTANT_SERVICE,
  app = AGSA_PKG,
  clientSig = CLIENT_SIG,
  deviceCountry,
  operatorCountry,
  lang,
  sdkVersion,
  timeoutMs,
} = {}) {
  if (!email || !masterToken) throw new Error("performOauth 需要 email 与 masterToken");
  if (!androidId) throw new Error("performOauth 需要 androidId");

  const { fields, status, raw } = await postAuthForm(
    buildOauthData({
      email,
      masterToken,
      androidId,
      service,
      app,
      clientSig,
      deviceCountry,
      operatorCountry,
      lang,
      sdkVersion,
    }),
    { timeoutMs },
  );

  return {
    token: fields.Auth || null,
    expiresInSec: Number(fields.ExpiresIn) || null, // 端点通常返回，缺失时用 3600
    fields,
    status,
    raw,
  };
}

// ─────────────────────────── 工具 ───────────────────────────

/** 网页登录 URL（复刻 microG LoginActivity.buildUrl()）。 */
export function buildLoginUrl({ lang = "en", cc = "us", tmpl = "new_account" } = {}) {
  const q = new URLSearchParams({
    source: "android",
    xoauth_display_name: "Android Device",
    lang,
    cc,
    langCountry: `${lang}_${cc}`,
    hl: `${lang}-${cc}`,
    tmpl,
  });
  return `${EMBEDDED_SETUP_URL}?${q}`;
}

/** 从浏览器 cookie 文本 / DevTools 粘贴内容里抠出 oauth_token。 */
export function extractOauthToken(blob) {
  const s = String(blob ?? "");
  // ① cookie 串 / 单行粘贴：oauth_token=VALUE
  let m = s.match(/\boauth_token=([^;\s"']+)/);
  if (m) return decodeURIComponent(m[1]);
  // ② Netscape cookies.txt：制表符分隔，第 6 列是名字、第 7 列是值
  m = s.match(/(?:^|\t)oauth_token\t([^\s]+)/m);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

/** 生成合规的 androidId（16 位十六进制）。 */
export function randomAndroidId() {
  return randomBytes(8).toString("hex");
}

/** 校验/规范化 androidId。非法返回 null。 */
export function normalizeAndroidId(s) {
  const v = String(s ?? "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toLowerCase();
  return v.length === 16 ? v : null;
}
