#!/usr/bin/env node
// tools/browser-login.mjs —— 「网页登录 → 自动抓 oauth_token → 换 master token」一键助手
//
// 为什么需要它：
//   Google 在**提交账号密码的那一刻**做浏览器可信度判定。拦截页
//   “Couldn't sign you in / This browser or app may not be secure” 的常见根因：
//     ① 在嵌入式浏览器里打开（应用内预览面板、聊天工具的内置浏览器、桌面应用 WebView）
//     ② 浏览器带了非常规指纹（无沙箱启动、可疑扩展、自动化标志、冷门国产壳）
//   本工具的对策：官方 Edge/Chrome + 全新专用配置（无扩展、无历史）+ 可控 UA，
//   并用 CDP（DevTools 协议）**自动抓取 cookie** —— 不需要手动开 F12 翻找。
//
// 用法（在仓库根目录执行）：
//   node tools/browser-login.mjs --email you@gmail.com
//       默认：干净窗口登录 → 自动抓 oauth_token → 自动换 master token 并验证
//       （省略 --email 时也会尝试从登录后的页面 URL 自动识别邮箱，识别到即同样跑完全链路）
//
//   node tools/browser-login.mjs --email you@gmail.com --ua magic
//       排障升级：把 UA 伪装成 microG 同款的「真机 Android WebView + MinuteMaid」
//       （microG 用这个指纹让 Google 放行嵌入式登录流程，见 docs/credential-acquisition.md）
//
//   node tools/browser-login.mjs --email you@gmail.com --reauth
//       使用重认证入口（embedded/reauth/v2/android?Email=…），适合已有账号
//
//   node tools/browser-login.mjs --headless --probe
//       自检：无头启动，验证 CDP 管道是否正常（不用于真实登录）
//
//   node tools/browser-login.mjs --cleanup
//       删除专用配置目录（内含登录态，用完建议清一次）
//
// 捕获结果写入：
//   out/oauth-token.txt      —— 网页 oauth_token（一次性，换完 master 即作废）
//   out/gpsoauth-env.txt     —— GSA_EMAIL / GSA_MASTER_TOKEN / GSA_ANDROID_ID 环境变量块
//   out/gsa-credentials.json —— 统一凭证文件（与 tools/gpsoauth.py 同一份、同一格式）

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGSA_PKG,
  ASSISTANT_SERVICE,
  EMBEDDED_REAUTH_URL,
  buildLoginUrl,
  exchangeToken,
  normalizeAndroidId,
  performOauth,
  randomAndroidId,
} from "../service/lib/gpsoauth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "out");

// ── microG 同款指纹（见 microG GmsCore LoginActivity / Build.kt）──
// 结构：真机 Android WebView UA（含 `; wv` 标记 + 完整 Build 指纹）+ ` MinuteMaid` 魔术后缀。
// ⚠️ Chrome 版本号必须跟随真实引擎 —— 写死旧版号会命中 Google「浏览器过旧」拦截，
//    因此在运行时依据浏览器实际版本动态生成（见 detectChromiumFullVersion / buildMagicUa）。
const MAGIC_SUFFIX = " MinuteMaid";
const ANDROID_BUILD_ID = "UQ1A.240205.004";

function detectChromiumFullVersion(ver) {
  const s = `${ver?.Browser || ""} ${ver?.["User-Agent"] || ver?.userAgent || ""}`;
  const m = s.match(/(\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : "140.0.0.0";
}

function buildMagicUa(chromiumFullVersion) {
  const major = String(chromiumFullVersion).split(".")[0] || "140";
  const userAgent =
    `Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/${ANDROID_BUILD_ID}; wv) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${chromiumFullVersion} ` +
    `Mobile Safari/537.36${MAGIC_SUFFIX}`;
  const userAgentMetadata = {
    brands: [
      { brand: "Chromium", version: major },
      { brand: "Android WebView", version: major },
      { brand: "Not-A.Brand", version: "99" },
    ],
    fullVersion: String(chromiumFullVersion),
    platform: "Android",
    platformVersion: "14.0.0",
    architecture: "",
    model: "Pixel 7",
    mobile: true,
  };
  return { userAgent, userAgentMetadata };
}

// ─────────────────────────── CLI ───────────────────────────
const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  printHelp();
  process.exit(0);
}

function log(...a) {
  console.log("[browser-login]", ...a);
}
function mask(s) {
  const t = String(s ?? "");
  return t.length > 24 ? `${t.slice(0, 12)}…${t.slice(-6)}` : "…";
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function die(msg) {
  console.error("[browser-login] ❌ " + msg);
  process.exit(1);
}
function parseArgs(argv) {
  const o = { ua: "plain", port: 9333, timeout: 600, _: [] };
  const takes = new Set(["email", "ua", "browser", "port", "profile", "timeout", "service", "key", "android-id"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      o._.push(a);
      continue;
    }
    let k = a.slice(2);
    let v;
    const eq = k.indexOf("=");
    if (eq >= 0) {
      v = k.slice(eq + 1);
      k = k.slice(0, eq);
    }
    k = k.replace(/_/g, "-");
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (takes.has(k)) {
      if (v === undefined) v = argv[++i];
      o[key] = v;
    } else {
      o[key] = true;
    }
  }
  return o;
}
function printHelp() {
  console.log(`
browser-login —— 一键完成「网页登录 → Robin 凭证」的浏览器助手

用法：
  node tools/browser-login.mjs --email <你的邮箱> [选项]

选项：
  --email <addr>      目标 Google 账号；给出后自动完成 exchange → mint 并输出环境变量
  --ua <mode|字符串>  plain（默认）| magic（microG 同款 Android WebView 指纹）| 自定义 UA 字符串
  --reauth            改用重认证入口（embedded/reauth/v2/android?Email=…）
  --browser <path>    edge | chrome | 可执行文件完整路径（默认自动探测）
  --port <n>          CDP 端口（默认 9333）
  --profile <dir>     浏览器专用配置目录（默认 out/login-profile）
  --timeout <sec>     等待登录的超时秒数（默认 600）
  --android-id <hex>  指定 androidId（默认随机生成）
  --service <url>     捕获后把凭证直接 POST 到该服务 /admin/gpsoauth
  --key <adminKey>    配合 --service 使用的 ADMIN_KEY
  --headless          无头模式（仅自检用，真实登录请勿加）
  --probe             自检模式：验证 CDP 管道后立即退出
  --cleanup           结束后删除专用配置目录（含登录态）
  --help              显示本帮助
`);
}

// ────────────────────── 浏览器探测 / 启动 ──────────────────────
const browserPath = findBrowser(opts.browser);
const profileDir = opts.profile ? path.resolve(opts.profile) : path.join(OUT, "login-profile");
mkdirSync(profileDir, { recursive: true });
mkdirSync(OUT, { recursive: true });

function findBrowser(explicit) {
  if (explicit && explicit !== "edge" && explicit !== "chrome") {
    if (existsSync(explicit)) return explicit;
    die(`找不到浏览器可执行文件：${explicit}`);
  }
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const local = process.env.LOCALAPPDATA || "";
  const cands = [];
  if (!explicit || explicit === "edge") {
    cands.push(
      path.join(pf86, "Microsoft/Edge/Application/msedge.exe"),
      path.join(pf, "Microsoft/Edge/Application/msedge.exe"),
    );
  }
  if (!explicit || explicit === "chrome") {
    cands.push(
      path.join(pf, "Google/Chrome/Application/chrome.exe"),
      path.join(pf86, "Google/Chrome/Application/chrome.exe"),
      path.join(local, "Google/Chrome/Application/chrome.exe"),
    );
  }
  for (const c of cands) if (existsSync(c)) return c;
  die("未找到 Edge/Chrome。请用 --browser <完整路径> 指定。");
}

const port = Number(opts.port) || 9333;
const base = `http://127.0.0.1:${port}`;

const launchArgs = [
  `--remote-debugging-port=${port}`,
  "--remote-allow-origins=*",
  `--user-data-dir=${profileDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate,MediaRouter",
  // ⚠️ 本机存在“向全新浏览器配置自动注入第三方扩展”的现象（AdGuard 等，会破坏 Google 登录风控）→ 强制禁用全部扩展
  "--disable-extensions",
  ...(opts.headless ? ["--headless=new"] : []),
  "about:blank",
];

log(`浏览器：${browserPath}`);
log(`专用配置目录：${profileDir}`);
const child = spawn(browserPath, launchArgs, { detached: true, stdio: "ignore" });
child.unref();

// ───────────────────────── CDP 基础设施 ─────────────────────────
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.lastUrl = "";
  }
  async open() {
    await new Promise((res, rej) => {
      const onOpen = () => res();
      const onErr = () => rej(new Error("WebSocket 连接失败（CDP 端口未就绪？）"));
      this.ws.addEventListener("open", onOpen, { once: true });
      this.ws.addEventListener("error", onErr, { once: true });
    });
    this.ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 命令超时：${method}`));
        }
      }, 15000);
    });
  }
  #onMessage(data) {
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message || String(m.error)));
      else p.res(m.result);
      return;
    }
    if (m.method === "Page.frameNavigated" && m.params?.frame && !m.params.frame.parentId) {
      this.lastUrl = m.params.frame.url;
    }
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(fn, timeoutMs, errMsg) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  die(errMsg);
}

async function connectBrowser() {
  await waitFor(
    async () => (await fetch(`${base}/json/version`)).ok,
    25000,
    "CDP 端口未就绪（浏览器可能启动失败或被安全软件拦截）",
  );
  const ver = await (await fetch(`${base}/json/version`)).json();
  const page = await waitFor(async () => {
    const list = await (await fetch(`${base}/json/list`)).json();
    return list.find((t) => t.type === "page");
  }, 15000, "未找到页面目标");
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  return { cdp, ver };
}

async function closeBrowser() {
  try {
    const ver = await (await fetch(`${base}/json/version`)).json();
    const cdp = new CDP(ver.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Browser.close");
    cdp.close();
    await sleep(900);
  } catch {
    /* ignore */
  }
}

// ───────────────────────── 主流程 ─────────────────────────
const loginUrl = opts.reauth ? buildReauthUrl(opts.email) : buildLoginUrl();
log("正在启动专用浏览器窗口…");

const { cdp, ver } = await connectBrowser();
log(`浏览器版本：${ver.Browser}（UA: ${String(ver["User-Agent"] || ver.userAgent || "").slice(0, 80)}…）`);

await cdp.send("Page.enable");
await cdp.send("Network.enable");

// 扩展自检：本机已知会向新配置注入第三方扩展（Google 风控杀手），启动参数已带 --disable-extensions，这里确认一次
try {
  const targets = await (await fetch(`${base}/json/list`)).json();
  const extIds = [
    ...new Set(
      targets
        .filter((t) => String(t.url || "").startsWith("chrome-extension://"))
        .map((t) => String(t.url).split("/")[2]),
    ),
  ];
  if (extIds.length) log(`⚠️ 检测到 ${extIds.length} 个扩展仍被加载：${extIds.join(", ")}`);
  else log("扩展自检：干净（未加载任何扩展）");
} catch {
  /* ignore */
}

// UA 指纹
if (opts.ua === "magic") {
  const chromeVer = detectChromiumFullVersion(ver);
  const { userAgent, userAgentMetadata } = buildMagicUa(chromeVer);
  await cdp.send("Network.setUserAgentOverride", {
    userAgent,
    acceptLanguage: "en-US,en",
    platform: "Android",
    userAgentMetadata,
  });
  log(`UA 指纹：microG 同款（真机 Android WebView + MinuteMaid，Chrome/${chromeVer}）`);
} else if (opts.ua && opts.ua !== "plain") {
  await cdp.send("Network.setUserAgentOverride", { userAgent: String(opts.ua), acceptLanguage: "en-US,en" });
  log(`UA 指纹：自定义（${String(opts.ua).slice(0, 60)}…）`);
} else {
  log("UA 指纹：浏览器默认（不做伪装）");
}

log(`打开登录页：${loginUrl}`);
await cdp.send("Page.navigate", { url: loginUrl });

console.log(
  [
    "",
    "────────────────────────────────────────────────────────",
    "  接下来请在这个新窗口里操作：",
    "    1) 用目标 Google 账号登录（新窗口 = 新设备，可能触发手机二次确认，属正常）",
    "    2) 点「I agree / 同意」",
    "    3) 之后页面可能一直转圈 —— 这是正常的！不要关窗口，",
    "       本工具会自动抓到 oauth_token 并完成后续步骤。",
    "────────────────────────────────────────────────────────",
    "",
  ].join("\n"),
);

// ── 自检模式 ──
if (opts.probe) {
  await sleep(5000);
  const cookies = (await cdp.send("Network.getCookies", {})).cookies || [];
  log("[probe] 当前页面：" + (cdp.lastUrl || "(尚未导航)"));
  log(`[probe] 现有 cookie：${cookies.length} 条`);
  await closeBrowser();
  log("[probe] CDP 管道 OK，浏览器已关闭。");
  process.exit(0);
}

// ── 轮询抓 oauth_token ──
const deadline = Date.now() + (Number(opts.timeout) || 600) * 1000;
let token = null;
let lastTick = 0;
while (Date.now() < deadline) {
  await sleep(2000);
  let cookies;
  try {
    cookies = (await cdp.send("Network.getCookies", {})).cookies || [];
  } catch {
    continue;
  }
  const hit = cookies.find((c) => c.name === "oauth_token" && c.value);
  if (hit) {
    token = hit.value;
    break;
  }
  if (Date.now() - lastTick > 12000) {
    lastTick = Date.now();
    log(`等待登录中…（当前页面：${(cdp.lastUrl || "—").slice(0, 100)}）`);
  }
}

if (!token) {
  log("❌ 超时未捕获到 oauth_token。");
  console.log(
    [
      "",
      "排障阶梯（依次尝试）：",
      "  1. 若 Google 显示「此浏览器或应用可能不安全」→ 换指纹重试：",
      "     node tools/browser-login.mjs --email <邮箱> --ua magic",
      "  2. 若卡在密码/验证码 → 完成验证后不要关窗口，等待自动抓取",
      "  3. 仍失败 → 参见 docs/credential-acquisition.md §二 排障小节",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

log(`✅ 已捕获 oauth_token：${mask(token)}`);
log(`最终页面：${(cdp.lastUrl || "—").slice(0, 160)}`);
writeFileSync(path.join(OUT, "oauth-token.txt"), token + "\n", "utf8");
log(`已写入 ${path.join(OUT, "oauth-token.txt")}`);

// ── 邮箱来源：① --email 参数 ② 登录后页面 URL 中的 Email 参数（自动兜底）──
let emailFromUrl = null;
try {
  const m = String(cdp.lastUrl || "").match(/[?&#]Email=([^&]+)/i);
  if (m) emailFromUrl = decodeURIComponent(m[1]);
} catch {
  /* ignore */
}
const email = opts.email ? String(opts.email).trim() : emailFromUrl;
if (!opts.email && emailFromUrl) log(`从页面 URL 自动识别到账号：${emailFromUrl}`);

// ── 有邮箱 → 直接完成绑定链 ──
if (email) {
  const androidId = normalizeAndroidId(opts.androidId) ?? randomAndroidId();
  log(`换 master token（exchange_token，androidId=${androidId}）…`);
  let ex;
  try {
    ex = await exchangeToken({ email, oauthToken: token, androidId });
  } catch (err) {
    die(`exchange_token 请求失败：${err?.message}`);
  }
  if (!ex.masterToken) {
    die(
      `exchange_token 未返回 master token（HTTP ${ex.status}）` +
        (ex.fields?.Error ? `：${ex.fields.Error}` : ""),
    );
  }
  log(`✅ master token：${mask(ex.masterToken)}`);

  log("验证：master token → 访问令牌（perform_oauth）…");
  let oa;
  try {
    oa = await performOauth({ email, masterToken: ex.masterToken, androidId });
  } catch (err) {
    die(`perform_oauth 请求失败：${err?.message}`);
  }
  if (!oa.token || !oa.token.startsWith("ya29.")) {
    log(`⚠️ perform_oauth 未返回 ya29 令牌（HTTP ${oa.status}）` + (oa.fields?.Error ? `：${oa.fields.Error}` : ""));
    log("   master token 本身可用；把下面三项写入服务端环境变量后再测一次。");
  } else {
    log(`✅ 访问令牌可用：${mask(oa.token)}（TTL ${oa.expiresInSec ?? 3600}s）`);
  }

  const envBlock =
    `GSA_EMAIL=${email}\n` +
    `GSA_MASTER_TOKEN=${ex.masterToken}\n` +
    `GSA_ANDROID_ID=${androidId}\n`;
  const envFile = path.join(OUT, "gpsoauth-env.txt");
  writeFileSync(envFile, envBlock, "utf8");

  // ── 统一凭证文件：与 tools/gpsoauth.py 的 save_credentials() 同格式，合并写 ──
  const credFile = path.join(OUT, "gsa-credentials.json");
  let cred = {};
  try {
    cred = JSON.parse(readFileSync(credFile, "utf8"));
  } catch {
    /* 首次写入 */
  }
  Object.assign(cred, {
    email,
    androidId,
    masterToken: ex.masterToken,
    ...(oa?.token ? { robinToken: oa.token } : {}),
    note: "master token 长期有效；robinToken 1 小时过期，可由 master token 随时重铸（tools/gpsoauth.py robin）",
    savedAt: new Date().toISOString(),
  });
  writeFileSync(credFile, JSON.stringify(cred, null, 2), "utf8");

  console.log("\n───── 服务端环境变量（写入 Vercel / .env）─────");
  console.log(envBlock);
  console.log(`已保存到 ${envFile}`);
  console.log(`凭证已统一落盘：${credFile}\n`);

  if (opts.service && opts.key) {
    const svc = String(opts.service).replace(/\/$/, "");
    try {
      const r = await fetch(`${svc}/admin/gpsoauth`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": String(opts.key) },
        body: JSON.stringify({ email, oauthToken: token, androidId }),
      });
      const j = await r.json().catch(() => ({}));
      log(`已 POST ${svc}/admin/gpsoauth → HTTP ${r.status}${j?.ok ? "（绑定成功）" : ""}`);
    } catch (err) {
      log(`⚠️ POST 服务失败：${err?.message}（可稍后手动注入）`);
    }
  }
} else {
  log("未识别到账号邮箱 —— oauth_token 已保存，仍差最后一步（换 master token）。");
  log('手动完成：python tools/gpsoauth.py robin --email <邮箱> --oauth-token "<token>"');
  log("或直接把邮箱告诉我，我来跑完后续。");
}

if (opts.cleanup) {
  await closeBrowser();
  try {
    rmSync(profileDir, { recursive: true, force: true });
    log(`已清理专用配置目录：${profileDir}`);
  } catch (err) {
    log(`⚠️ 清理失败（可手动删除）：${err?.message}`);
  }
} else {
  log(`完成。浏览器窗口可以关闭了。`);
  log(`提示：专用配置目录（${profileDir}）含该账号登录态，`);
  log(`      如需清除痕迹：node tools/browser-login.mjs --cleanup`);
}

function buildReauthUrl(email) {
  const q = new URLSearchParams({
    source: "android",
    xoauth_display_name: "Android Device",
    lang: "en",
    cc: "us",
    langCountry: "en_us",
    hl: "en-us",
    tmpl: "new_account",
  });
  if (email) q.set("Email", String(email).trim());
  return `${EMBEDDED_REAUTH_URL}?${q}`;
}
