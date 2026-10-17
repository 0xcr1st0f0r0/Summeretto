#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gpsoauth.py —— 零依赖复刻 Google Play Services OAuth（"网页登录 → 端点取 token"路线）

═══════════════════════════════════════════════════════════════════════════════
为什么需要这个工具
═══════════════════════════════════════════════════════════════════════════════
Gemini / AGSA 的 Robin gRPC 通道需要 `authorization: Bearer ya29.*`，其 scope
是 `https://www.googleapis.com/auth/assistant` —— 一个**不在 Google 公开 OAuth
scope 列表**里的内部 scope。因此：

  ✗ 无法用第三方 client_id 走标准 OAuth 授权码流程（scope 不存在 → 直接拒）
  ✗ 无法自建"登录页"（需要 Google 侧白名单 + client_id → 三重死锁）

但 Google 自己给 Android 设备留了一条**网页登录**通道，被 microG 与 gpsoauth
生产级验证了十余年：

  ┌─ 阶段 1：网页登录（用户在真实浏览器里输密码，不经过我们）────────────┐
  │  打开 https://accounts.google.com/EmbeddedSetup?…&tmpl=new_account     │
  │  UA 必须以 " MinuteMaid" 结尾（microG 的 MAGIC_USER_AGENT）            │
  │  登录 + 点 "I agree" → 浏览器 cookie 里出现 `oauth_token`              │
  └───────────────────────────────────────────────────────────────────────┘
                       ↓ 用户复制 oauth_token（一个长字符串）
  ┌─ 阶段 2：exchange_token（本脚本）─────────────────────────────────────┐
  │  POST https://android.clients.google.com/auth                          │
  │    Token=<oauth_token>  ACCESS_TOKEN=1  service=ac2dm                  │
  │    client_sig=38918a45…  callerSig=38918a45…                           │
  │  → 返回 `Token=oauth2rt_1/…`  ← master token（长期有效）               │
  └───────────────────────────────────────────────────────────────────────┘
                       ↓ master token 只存服务端
  ┌─ 阶段 3：perform_oauth（本脚本）──────────────────────────────────────┐
  │  POST 同一端点                                                          │
  │    EncryptedPasswd=<master_token>  app=com.google.android.quicksearchbox│
  │    service=oauth2:https://www.googleapis.com/auth/assistant             │
  │    client_sig=38918a45…                                                 │
  │  → 返回 `Auth=ya29.…`  ← 正是 Robin 需要的 Bearer token（约 1h 有效）  │
  └───────────────────────────────────────────────────────────────────────┘

关键前提（已在本项目验证）：
  · AGSA（com.google.android.googlequicksearchbox）的签名证书 SHA-1
    = 38918a453d07199354f8b19af05ec6562ced5788
    = 与 com.google.android.gms（GMS Core）**完全相同**的一张 Google 平台证书。
    见 tools/apksig.py。服务端以 client_sig 判定调用者身份，因此我们"冒充"
    AGSA 时签名校验天然通过 —— 无需伪造任何密码学材料。

⚠️ 已知风险（需实测）：
  1. EmbeddedSetup 是否仍对新账号开放（microG 现役代码仍在用，但 Google 可随时下线）
  2. auth/assistant 这类内部 scope 是否仍接受 has_permission=1 放行
  3. droidguard_results 目前传假值即可（gpsoauth 传 "dummy123"，microG 传 "null"）
  4. 端点对 TLS 极度挑剔：**不能发 ALPN 扩展**、不能设 OP_NO_TICKET

═══════════════════════════════════════════════════════════════════════════════
用法
═══════════════════════════════════════════════════════════════════════════════
  # 0) 探测：端点是否可达、TLS 是否被接受（不需要任何凭证）
  python tools/gpsoauth.py probe

  # 1) 一条龙：oauth_token → master token → assistant scope token
  python tools/gpsoauth.py robin --email me@gmail.com --oauth-token <粘贴>

  # 2) 分步（便于排查）
  python tools/gpsoauth.py exchange --email me@gmail.com --oauth-token <粘贴>
  python tools/gpsoauth.py oauth --email me@gmail.com --master-token oauth2rt_1/... \\
      --service oauth2:https://www.googleapis.com/auth/assistant

  # 3) 从浏览器 Cookie 文本里抠 oauth_token
  python tools/gpsoauth.py cookie --from-stdin

  # 4) 只看网页登录的 URL / UA（把命令输出直接贴到浏览器）
  python tools/gpsoauth.py login-url

环境变量：GSA_ANDROID_ID / GSA_EMAIL / GSA_OAUTH_TOKEN / GSA_MASTER_TOKEN / HTTPS_PROXY
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import ssl
import time
import sys
import urllib.error
import urllib.parse
import urllib.request

# ─────────────────────────────── 常量 ───────────────────────────────

AUTH_URL = "https://android.clients.google.com/auth"
USER_AGENT = "GoogleAuth/1.4"  # ← Google 端硬性要求，见 gpsoauth/__init__.py:36

# AGSA 的签名证书 SHA-1（= GMS 的），由 tools/apksig.py 从 APK 实测得出
CLIENT_SIG = "38918a453d07199354f8b19af05ec6562ced5788"

GPS_VERSION = "240913000"  # google_play_services_version，gpsoauth 同值
DROIDGUARD_DUMMY = "dummy123"

AGSA_PKG = "com.google.android.googlequicksearchbox"
ASSISTANT_SCOPE = "https://www.googleapis.com/auth/assistant"
ASSISTANT_SERVICE = f"oauth2:{ASSISTANT_SCOPE}"

# 网页登录
EMBEDDED_SETUP_URL = "https://accounts.google.com/EmbeddedSetup"
EMBEDDED_REAUTH_URL = "https://accounts.google.com/embedded/reauth/v2/android"
MAGIC_UA_SUFFIX = " MinuteMaid"  # microG LoginActivity.java:101
COOKIE_NAME = "oauth_token"  # microG LoginActivity.java:102

DEVICE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", ".gpsoauth-device.json")
CRED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out", "gsa-credentials.json")


def save_credentials(**kv) -> str | None:
    """把 email / androidId / masterToken / robinToken 落盘到 out/gsa-credentials.json。

    ⚠️ 该文件含长期凭证，属敏感数据 —— out/ 已在 .gitignore 中，切勿提交。
    """
    try:
        os.makedirs(os.path.dirname(CRED_FILE), exist_ok=True)
        data = {}
        try:
            with open(CRED_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            pass
        data.update({k: v for k, v in kv.items() if v})
        data["savedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        with open(CRED_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return CRED_FILE
    except OSError:
        return None


# ─────────────────────────────── TLS ───────────────────────────────

class _NoALPNContext(ssl.SSLContext):
    """Google 的 /auth 端点在收到 ALPN 扩展时直接返回 403 BadAuthentication。

    覆写为空实现即可让 http.client / urllib3 的 `set_alpn_protocols()` 调用变成
    静默 no-op（与 gpsoauth 的做法一致）。
    """

    def set_alpn_protocols(self, *args, **kwargs):  # noqa: D102
        return None


def make_ssl_context() -> ssl.SSLContext:
    ctx = _NoALPNContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    # OP_NO_TICKET 会让 Google 返回 403，显式清除
    ctx.options &= ~ssl.OP_NO_TICKET
    ctx.load_default_certs()
    return ctx


# ─────────────────────────── 协议实现 ───────────────────────────

def parse_auth_response(text: str) -> dict:
    """响应是一行一个 `key=value`（不是 JSON）。"""
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


def _perform_auth_request(data: dict, *, timeout: float = 30.0, proxy: str | None = None):
    """向 AUTH_URL 发 POST 表单，返回 (parsed_dict, http_status, raw_text)。"""
    body = urllib.parse.urlencode({k: v for k, v in data.items() if v is not None}).encode("utf-8")
    req = urllib.request.Request(
        AUTH_URL,
        data=body,
        method="POST",
        headers={
            "Accept-Encoding": "identity",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
    )
    handlers = [urllib.request.HTTPSHandler(context=make_ssl_context())]
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)

    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return parse_auth_response(raw), resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        return parse_auth_response(raw), e.code, raw


def exchange_token(
    email: str,
    oauth_token: str,
    android_id: str,
    *,
    service: str = "ac2dm",
    client_sig: str = CLIENT_SIG,
    device_country: str = "us",
    operator_country: str = "us",
    lang: str = "en",
    sdk_version: int = 31,
    timeout: float = 30.0,
    proxy: str | None = None,
):
    """网页 oauth_token → master token（响应里的 `Token` 字段，形如 oauth2rt_1/…）。

    载荷与 gpsoauth.exchange_token / microG retrieveRtToken() 逐字段一致。
    """
    data = {
        "accountType": "HOSTED_OR_GOOGLE",
        "Email": email,
        "has_permission": 1,
        "add_account": 1,
        "ACCESS_TOKEN": 1,
        "Token": oauth_token,
        "service": service,
        "source": "android",
        "androidId": android_id,
        "device_country": device_country,
        "operatorCountry": operator_country,
        "lang": lang,
        "sdk_version": sdk_version,
        "google_play_services_version": GPS_VERSION,
        "client_sig": client_sig,
        "callerSig": client_sig,
        "droidguard_results": DROIDGUARD_DUMMY,
    }
    return _perform_auth_request(data, timeout=timeout, proxy=proxy)


def perform_oauth(
    email: str,
    master_token: str,
    android_id: str,
    *,
    service: str,
    app: str,
    client_sig: str = CLIENT_SIG,
    device_country: str = "us",
    operator_country: str = "us",
    lang: str = "en",
    sdk_version: int = 31,
    timeout: float = 30.0,
    proxy: str | None = None,
):
    """master token → 目标服务 token（响应里的 `Auth` 字段 = ya29.*）。

    注意 master token 是放在 `EncryptedPasswd` 字段里的（历史命名，与密码无关）。
    """
    data = {
        "accountType": "HOSTED_OR_GOOGLE",
        "Email": email,
        "has_permission": 1,
        "EncryptedPasswd": master_token,
        "service": service,
        "source": "android",
        "androidId": android_id,
        "app": app,
        "client_sig": client_sig,
        "device_country": device_country,
        "operatorCountry": operator_country,
        "lang": lang,
        "sdk_version": sdk_version,
        "google_play_services_version": GPS_VERSION,
    }
    return _perform_auth_request(data, timeout=timeout, proxy=proxy)


# ─────────────────────────── 辅助 ───────────────────────────

def load_or_create_android_id(explicit: str | None = None) -> tuple[str, bool]:
    """androidId 是 16 位十六进制。首次生成后落盘，保证稳定（换 ID 可能触发风控）。"""
    if explicit:
        return _normalize_android_id(explicit), False
    env = os.environ.get("GSA_ANDROID_ID")
    if env:
        return _normalize_android_id(env), False
    try:
        with open(DEVICE_FILE, "r", encoding="utf-8") as f:
            aid = json.load(f).get("androidId")
            if aid:
                return aid, False
    except (OSError, ValueError):
        pass
    aid = secrets.token_hex(8)  # 16 hex chars
    try:
        os.makedirs(os.path.dirname(DEVICE_FILE), exist_ok=True)
        with open(DEVICE_FILE, "w", encoding="utf-8") as f:
            json.dump({"androidId": aid}, f)
    except OSError:
        pass
    return aid, True


def _normalize_android_id(s: str) -> str:
    s = re.sub(r"[^0-9a-fA-F]", "", s).lower()
    if len(s) != 16:
        raise SystemExit(f"androidId 必须是 16 位十六进制，收到 {len(s)} 位：{s!r}")
    return s


def extract_oauth_token(blob: str) -> str | None:
    """从浏览器 Cookie 文本 / DevTools 粘贴内容里抠出 oauth_token。"""
    s = str(blob or "")
    # ① cookie 串 / 单行粘贴：oauth_token=VALUE
    m = re.search(rf"\b{COOKIE_NAME}=([^;\s\"']+)", s)
    if m:
        return urllib.parse.unquote(m.group(1))
    # ② Netscape cookies.txt：制表符分隔，第 6 列是名字、第 7 列是值
    m = re.search(rf"(?:^|\t){COOKIE_NAME}\t([^\s]+)", s, re.M)
    if m:
        return urllib.parse.unquote(m.group(1))
    return None


def login_page_url(lang: str = "en", cc: str = "us", tmpl: str = "new_account") -> str:
    """复刻 microG LoginActivity.buildUrl()，供用户直接在浏览器打开。"""
    q = urllib.parse.urlencode(
        {
            "source": "android",
            "xoauth_display_name": "Android Device",
            "lang": lang,
            "cc": cc,
            "langCountry": f"{lang}_{cc}",
            "hl": f"{lang}-{cc}".replace("_", "-"),
            "tmpl": tmpl,
        }
    )
    return f"{EMBEDDED_SETUP_URL}?{q}"


def _show(resp, status, raw, keys):
    """统一打印响应：挑出关键字段；失败时回显原始文本帮助排查。"""
    for k in keys:
        if k in resp:
            return resp[k], True
    print(f"❌ 未拿到预期字段。HTTP {status}", file=sys.stderr)
    print("--- 原始响应 ---", file=sys.stderr)
    print(raw.strip() or "(空)", file=sys.stderr)
    if "Error" in resp:
        print(f"Error = {resp['Error']}", file=sys.stderr)
    if "ErrorDetail" in resp:
        print(f"ErrorDetail = {resp['ErrorDetail']}", file=sys.stderr)
    return None, False


# ─────────────────────────── 子命令 ───────────────────────────

def cmd_probe(args):
    """不需要凭证：确认端点可达 + 我们这套 TLS 参数是否被接受。"""
    print(f"→ POST {AUTH_URL}")
    print(f"  UA        = {USER_AGENT}")
    print("  ALPN      = 不发送（no-op 覆写）")
    print("  OP_NO_TICKET = 已清除")
    print("  proxy     = " + (args.proxy or os.environ.get("HTTPS_PROXY") or "(直连)"))
    print()
    data = {
        "accountType": "HOSTED_OR_GOOGLE",
        "Email": "probe@example.invalid",
        "EncryptedPasswd": "not-a-real-token",
        "service": "ac2dm",
        "source": "android",
        "androidId": "0123456789abcdef",
        "device_country": "us",
        "operatorCountry": "us",
        "lang": "en",
        "sdk_version": 31,
        "google_play_services_version": GPS_VERSION,
        "client_sig": CLIENT_SIG,
        "droidguard_results": DROIDGUARD_DUMMY,
    }
    try:
        resp, status, raw = _perform_auth_request(data, timeout=args.timeout, proxy=args.proxy)
    except Exception as e:  # noqa: BLE001
        print(f"❌ 连接层失败：{type(e).__name__}: {e}")
        print()
        print("判读：")
        print("  · 若是 SSL/TLS 握手错误 → 试试 --proxy，或网络层被干扰")
        print("  · 若是超时/连接重置 → android.clients.google.com 在当前网络不可达")
        return 2

    print(f"HTTP {status}")
    print(f"响应字段: {sorted(resp.keys())}")
    print()
    if status in (200, 403) and ("Error" in resp or "Auth" in resp or "Token" in resp):
        err = resp.get("Error", "(无 Error 字段)")
        print(f"✅ 端点可达且 TLS 被接受。Error={err}")
        print()
        print("判读：拿到 BadAuthentication 是**好消息** —— 说明请求已经过了 TLS 与")
        print("      协议层，只是凭证是假的。说明这套端点方案可行。")
        print()
        print("  下一步：")
        print("    1) python tools/gpsoauth.py login-url   # 复制输出的 URL 到浏览器登录")
        print("    2) 登录后取 oauth_token（见 README §凭证获取）")
        print("    3) python tools/gpsoauth.py robin --email <你的邮箱> --oauth-token <粘贴>")
        return 0
    print("⚠️ 响应形态异常，原始内容：")
    print(raw.strip()[:2000] or "(空)")
    return 1


def cmd_login_url(args):
    url = login_page_url(args.lang, args.cc)
    print("在**真实浏览器**中打开下面这个 URL（不要用 curl / 脚本）：")
    print()
    print(url)
    print()
    print("如果你用的是 Chrome/Edge，建议先把 User-Agent 改成下面这个值")
    print("（DevTools → 三点菜单 → More tools → Network conditions → User agent）：")
    print()
    print(f"  Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko)"
          f" Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36{MAGIC_UA_SUFFIX}")
    print()
    print("登录 → 点 “I agree” → 页面可能一直转圈，属正常现象。")
    print("然后 DevTools → Application → Cookies → https://accounts.google.com")
    print(f"  找到名为 `{COOKIE_NAME}` 的 cookie，复制它的值。")
    print()
    print(f"备用端点（重认证场景）：{EMBEDDED_REAUTH_URL}?tmpl=new_account")
    return 0


def cmd_cookie(args):
    blob = sys.stdin.read() if args.from_stdin else (args.text or "")
    if not blob:
        print("需要 --from-stdin 或 --text", file=sys.stderr)
        return 1
    tok = extract_oauth_token(blob)
    if not tok:
        print(f"❌ 没找到 {COOKIE_NAME}=…", file=sys.stderr)
        return 1
    print(tok)
    return 0


def cmd_exchange(args):
    email = args.email or os.environ.get("GSA_EMAIL")
    token = args.oauth_token or os.environ.get("GSA_OAUTH_TOKEN")
    if not (email and token):
        print("需要 --email 与 --oauth-token", file=sys.stderr)
        return 1
    aid, fresh = load_or_create_android_id(args.android_id)
    if fresh:
        print(f"ℹ️ 已生成并保存 androidId = {aid}（{DEVICE_FILE}）", file=sys.stderr)

    resp, status, raw = exchange_token(
        email, token, aid, service=args.service, timeout=args.timeout, proxy=args.proxy
    )
    master, ok = _show(resp, status, raw, ("Token",))
    if not ok:
        return 1
    print("✅ master token（长期有效，务必保密）")
    print(master)
    saved = save_credentials(email=email, androidId=aid, masterToken=master)
    if saved:
        print(f"💾 已保存到 {saved}", file=sys.stderr)
    if args.json:
        print(json.dumps({"masterToken": master, "androidId": aid, "email": email}, indent=2))
    return 0


def cmd_oauth(args):
    email = args.email or os.environ.get("GSA_EMAIL")
    master = args.master_token or os.environ.get("GSA_MASTER_TOKEN")
    if not (email and master):
        print("需要 --email 与 --master-token", file=sys.stderr)
        return 1
    aid, _ = load_or_create_android_id(args.android_id)

    resp, status, raw = perform_oauth(
        email,
        master,
        aid,
        service=args.service,
        app=args.app,
        timeout=args.timeout,
        proxy=args.proxy,
    )
    auth, ok = _show(resp, status, raw, ("Auth",))
    if not ok:
        return 1
    print(f"✅ service token（{args.service}）")
    print(auth)
    if args.json:
        print(json.dumps({"auth": auth, "services": resp.get("services", "")}, indent=2))
    return 0


def cmd_robin(args):
    """一条龙：oauth_token → master → assistant scope token。"""
    email = args.email or os.environ.get("GSA_EMAIL")
    token = args.oauth_token or os.environ.get("GSA_OAUTH_TOKEN")
    if not (email and token):
        print("需要 --email 与 --oauth-token（先跑 login-url 拿 token）", file=sys.stderr)
        return 1
    aid, fresh = load_or_create_android_id(args.android_id)
    if fresh:
        print(f"ℹ️ 已生成并保存 androidId = {aid}（{DEVICE_FILE}）", file=sys.stderr)

    print(f"[1/2] exchange_token  service=ac2dm", file=sys.stderr)
    resp, status, raw = exchange_token(email, token, aid, timeout=args.timeout, proxy=args.proxy)
    master, ok = _show(resp, status, raw, ("Token",))
    if not ok:
        print("\n排查：", file=sys.stderr)
        print("  · Error=BadAuthentication → oauth_token 过期/复制错；重新走 login-url", file=sys.stderr)
        print("  · Error=... 其他 → 见上面原始响应", file=sys.stderr)
        return 1
    print(f"      master token = {master[:22]}…", file=sys.stderr)
    saved = save_credentials(email=email, androidId=aid, masterToken=master)
    if saved:
        print(f"      💾 master token 已保存到 {saved}", file=sys.stderr)

    print(f"[2/2] perform_oauth  service={ASSISTANT_SERVICE}", file=sys.stderr)
    print(f"      app={args.app}  client_sig={CLIENT_SIG[:12]}…", file=sys.stderr)
    resp2, status2, raw2 = perform_oauth(
        email, master, aid, service=args.service, app=args.app, timeout=args.timeout, proxy=args.proxy
    )
    auth, ok2 = _show(resp2, status2, raw2, ("Auth",))
    if not ok2:
        print("\n注意：master token 已成功拿到（见上），可单独重试 perform_oauth。", file=sys.stderr)
        print(f"  python tools/gpsoauth.py oauth --email {email} --master-token {master}", file=sys.stderr)
        return 1

    print()
    print("✅ assistant scope Bearer token（Robin gRPC 直接可用）")
    print(auth)
    print()
    print("用法：")
    print(f"  authorization: Bearer {auth}")
    print()
    print("注入到反代服务：")
    print(f"  curl -X POST {{你的服务}}/admin/token -H 'x-admin-key: <ADMIN_KEY>' \\")
    print(f"       -H 'content-type: application/json' -d '{{\"token\":\"{auth}\",\"expiresInSec\":3600}}'")
    saved2 = save_credentials(email=email, androidId=aid, masterToken=master, robinToken=auth)
    if saved2:
        print(f"💾 全部凭据已保存到 {saved2}", file=sys.stderr)
    if args.json:
        print(json.dumps({"auth": auth, "masterToken": master, "androidId": aid}, indent=2))
    return 0


# ─────────────────────────── CLI ───────────────────────────

def main(argv=None):
    p = argparse.ArgumentParser(
        prog="gpsoauth.py",
        description="零依赖复刻 Google Play Services OAuth（网页登录路线）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument("--proxy", default=None, help="如 http://127.0.0.1:7890")
    p.add_argument("--json", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("probe", help="探测端点可达性 + TLS 兼容性（无需凭证）")
    sp.set_defaults(func=cmd_probe)

    sp = sub.add_parser("login-url", help="打印网页登录 URL 与 UA")
    sp.add_argument("--lang", default="en")
    sp.add_argument("--cc", default="us")
    sp.set_defaults(func=cmd_login_url)

    sp = sub.add_parser("cookie", help="从 cookie 文本中提取 oauth_token")
    sp.add_argument("--from-stdin", action="store_true")
    sp.add_argument("--text", default=None)
    sp.set_defaults(func=cmd_cookie)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--email", default=None)
    common.add_argument("--android-id", default=None)

    sp = sub.add_parser("exchange", help="oauth_token → master token", parents=[common])
    sp.add_argument("--oauth-token", default=None)
    sp.add_argument("--service", default="ac2dm")
    sp.set_defaults(func=cmd_exchange)

    sp = sub.add_parser("oauth", help="master token → service token", parents=[common])
    sp.add_argument("--master-token", default=None)
    sp.add_argument("--service", default=ASSISTANT_SERVICE)
    sp.add_argument("--app", default=AGSA_PKG)
    sp.set_defaults(func=cmd_oauth)

    sp = sub.add_parser("robin", help="一条龙：oauth_token → master → assistant token", parents=[common])
    sp.add_argument("--oauth-token", default=None)
    sp.add_argument("--service", default=ASSISTANT_SERVICE)
    sp.add_argument("--app", default=AGSA_PKG)
    sp.set_defaults(func=cmd_robin)

    args = p.parse_args(argv)
    if not args.proxy:
        args.proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
