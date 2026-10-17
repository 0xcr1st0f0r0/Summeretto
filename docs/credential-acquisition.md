# Robin 凭证获取指南（credential acquisition）

> 目标服务需要什么凭证？怎么拿到？"登录页"方案为什么不行？—— 本文回答这三个问题。
> 所有结论来自 APK 静态分析（AGSA 17.66.12）+ 网络实测，标注了每条结论的证据位置。
>
> **TL;DR —— 首选方案是"网页登录"，且已实测打通：**
> 浏览器登录 Google（`accounts.google.com/EmbeddedSetup`）→ 复制 `oauth_token` cookie
> → 服务端用 `android.clients.google.com/auth` 换**长期** master token → 按需铸造
> `ya29.*` 访问令牌（自动续期）。
> **不需要手机、不需要 root、不需要 OAuth client_id。** 落地页：服务根路径 `/login`。
> 完整说明见 **§二**。

---

## 一、需要什么凭证（一句话）

**一个 Google 账号的 OAuth2 access token，scope = `https://www.googleapis.com/auth/assistant`。**

| 属性 | 值 | 证据 |
|---|---|---|
| 类型 | OAuth2 access token（格式 `ya29.*`，约 200+ 字符） | `GetTokenResponse.a : String`（classes7.dex） |
| scope | `https://www.googleapis.com/auth/assistant` | `Lwij.i` 中的 `oauth2:.../auth/assistant`（classes.dex） |
| 用途 | Robin gRPC 请求头 `authorization: Bearer <token>` | `Lbcvm.c`：`Bearer %s` + `X-Auth-Time`（classes.dex） |
| 有效期 | **约 1 小时**（token 缓存层按 `j$/time/Instant` 判过期） | `Lfvtr.d`：`Duration.between(now, expiry)` |
| 签发方 | GMS Core（Google Play 服务），经 Google 服务端校验调用者身份后签发 | `GetTokenRequest` → Binder → GMS |
| 绑定 | **绑定 Google 账号**（不是设备）——账号的 Gemini 订阅等级决定能力 | `GetTokenRequest.a : GoogleAccount` |

> ⚠️ 推论：反代服务的能力上限 = **提取 token 所用账号**的能力（免费账号 / AI Pro / Ultra 各不相同）。

**获取方式（三条，优先级从高到低）**：

| # | 方式 | 需要手机？ | 能自动续期？ | 落地位置 |
|---|---|---|---|---|
| 1 | ★ **网页登录 → master token** | ❌ | ✅ 是（长期凭证，按需铸新 token） | `/login` 页面 → `GSA_MASTER_TOKEN`；见 **§二** |
| 2 | 设备侧提取（Frida hook GMS AANG） | ✅ 真机/模拟器 root | ✅ 可常驻上报 | `POST /admin/token`；见 §六/§七 |
| 3 | 静态 `ROBIN_AUTH_TOKEN` | — | ❌ 1 小时后失效 | 环境变量（仅兜底） |

---

## 二、★ 首选方案：网页登录 + Google 设备认证端点（已实测验证）

本节修正了本文档早期"网页登录不可行"的判断。**三重死锁本身没错**（§三逐条保留），
但它锁的是「**第三方 OAuth client**」这条路径；Google 给 Android 设备另留了一条
**根本不使用 client_id** 的旁路。本方案不需要手机、不需要 root、不需要自建 OAuth client。

### 2.1 核心洞察：换一个身份维度

标准 OAuth 里服务端判断"你是谁"靠 **client_id**；而 `assistant` 是 Google 内部 scope，
任何第三方 client_id 都拿不到 —— 死锁正在此处。

Android 的 Google 账号认证走的是**另一套**协议：

```
POST https://android.clients.google.com/auth
     ...
     app        = com.google.android.googlequicksearchbox   ← 包名
     client_sig = 38918a453d07199354f8b19af05ec6562ced5788  ← 签名证书 SHA-1
     callerSig  = 同上
```

它**不认 client_id**，只认「**包名 + 签名证书 SHA-1**」这个二元组。
只要我们能出示 AGSA 的签名证书指纹，服务端就认为我们是 AGSA。

于是问题坍缩成一个可证伪的事实问题：**能拿到 AGSA 的签名证书吗？**

### 2.2 决定性事实：AGSA 与 GMS 共用同一张 Google 平台证书

用本项目自带的零依赖工具直接从 APK 里读（`tools/apksig.py`，解析 APK Signing Block v2）：

```bash
$ python tools/apksig.py out/tmp-apk/agsa.apk
签名方案: v2   签名块 ID: 0x7109871a, 0x1b93ad61, 0xf05368c0, 0x6dff800d, 0x2146444e, 0x42726577
  证书[0]  SHA-1   = 38918a453d07199354f8b19af05ec6562ced5788   （client_sig 候选）
           SHA-256 = f0fd6c5b410f25cb25c3b53346c8972fae30f8ee7411df910480ad6b2d60db83
           DER 长度 = 1095
```

与 APKMirror 上 `com.google.android.gms`（GMS Core）公布的指纹**逐位一致**：

| 来源 | SHA-1 | SHA-256 | Subject |
|---|---|---|---|
| **AGSA**（本项目实测） | `38918a45…ced5788` | `f0fd6c5b…2d60db83` | （未解码） |
| **GMS Core**（APKMirror，多版本） | `38918a45…ced5788` | `f0fd6c5b…2d60db83` | `CN=Android, OU=Android, O=Google Inc., L=Mountain View` |

**三条结论**：
1. AGSA 与 GMS Core 共用一张 Google 平台签名证书 → `client_sig` **根本不是秘密**。
   它是 gpsoauth / MicroG 生态里公开了十余年的常量：gpsoauth 直接把它写成
   `exchange_token()` / `perform_master_login()` 的**函数默认值**。
2. 我们"冒充"AGSA 时，服务端签名校验**天然通过** —— 无需伪造任何密码学材料。
3. ⚠️ Gemini app（`com.google.android.apps.bard`，v1.0.971139365）用的是**另一张**证书
   `ec3549d92772531043b2dd2b85cd2469e75730af`（Play App Signing 分发的 app signing key），
   **不要用错**。真正承载 Robin 通道的是 AGSA。

### 2.3 三步协议

```
┌─ ① 网页登录（人做，密码只给 Google）───────────────────────────────────────┐
│  浏览器打开：                                                              │
│    https://accounts.google.com/EmbeddedSetup                               │
│      ?source=android&xoauth_display_name=Android+Device                    │
│      &lang=en&cc=us&langCountry=en_us&hl=en-us&tmpl=new_account            │
│  → 302 到 /v3/signin/identifier?...&flowName=EmbeddedSetupAndroid          │
│  → 登录 + 点 "I agree"（页面可能一直转圈，正常）                            │
│  → cookie jar 里出现 `oauth_token`（accounts.google.com 域）                │
└────────────────────────────────────────────────────────────────────────────┘
                                    ↓ 用户粘贴 oauth_token
┌─ ② exchange_token：oauth_token → master token ─────────────────────────────┐
│  POST https://android.clients.google.com/auth                              │
│    accountType=HOSTED_OR_GOOGLE   Email=<账号>                             │
│    Token=<oauth_token>            ACCESS_TOKEN=1                           │
│    service=ac2dm                  add_account=1                           │
│    has_permission=1               droidguard_results=dummy123              │
│    source=android  androidId=<16hex>  sdk_version=31                       │
│    google_play_services_version=240913000                                  │
│    client_sig=<AGSA SHA-1>        callerSig=<同上>                          │
│  → 响应 `Token=oauth2rt_1/…`  ← ★ 长期有效的 master token                  │
└────────────────────────────────────────────────────────────────────────────┘
                                    ↓ master token 只存服务端
┌─ ③ perform_oauth：master token → 任意 scope 的访问令牌 ─────────────────────┐
│  POST 同一端点                                                              │
│    EncryptedPasswd=<master_token>   ← 注意字段名是历史遗留，与密码无关       │
│    service=oauth2:https://www.googleapis.com/auth/assistant                │
│    app=com.google.android.googlequicksearchbox                             │
│    client_sig=<AGSA SHA-1>                                                 │
│  → 响应 `Auth=ya29.…`  ← ★ 正是 Robin gRPC 需要的 Bearer token（约 1h）     │
└────────────────────────────────────────────────────────────────────────────┘
```

参数契约逐字段对齐两处生产级实现：
[`gpsoauth`](https://github.com/simon-weber/gpsoauth)（Python，2015 至今维护，2025-07 仍在更新）
与 [MicroG `LoginActivity.retrieveRtToken()`](https://github.com/microg/GmsCore)（Android 现役代码）。

**网页登录侧的两个魔术细节**（来自 MicroG）：

| 项 | 值 | 出处 |
|---|---|---|
| UA 后缀 | `" MinuteMaid"`（含前导空格） | `LoginActivity.java` `MAGIC_USER_AGENT` |
| cookie 名 | `oauth_token` | `LoginActivity.java` `COOKIE_OAUTH_TOKEN` |
| 取 cookie 的方式 | `CookieManager.getCookie(EMBEDDED_SETUP_URL)` → split `;` → 找 `oauth_token=` | `closeWeb()` |
| 重认证备用端点 | `https://accounts.google.com/embedded/reauth/v2/android` | `EMBEDDED_RE_AUTH_URL` |

> 实测：`EmbeddedSetup` 两个 UA 都进入 `flowName=EmbeddedSetupAndroid`（`MinuteMaid`
> 后缀影响的是 `accounts.google.com/` 基线的分支，对本流程无差异），所以用普通桌面浏览器即可。

### 2.4 实测证据（本机直连，无代理）

**证据 1 —— 端点可达、TLS 被接受**。用一个故意无效的凭证打过去，看错误形态：

```bash
$ python tools/gpsoauth.py probe
→ POST https://android.clients.google.com/auth
  UA        = GoogleAuth/1.4
  ALPN      = 不发送（no-op 覆写）
  OP_NO_TICKET = 已清除
  proxy     = (直连)

HTTP 403
响应字段: ['Error']
✅ 端点可达且 TLS 被接受。Error=BadAuthentication
```

`Error=BadAuthentication` 是**最理想的失败形态**：说明请求已完整穿过 TLS 层与协议层、
被 Google 认证服务正常解析，只是凭证是假的。Node 版（`service/lib/gpsoauth.js`）
同样返回 `403 / BadAuthentication`（1.1s）→ **Vercel 的 Node 运行时也能用**。

**证据 2 —— 网页登录页仍然存活**：

```
GET https://accounts.google.com/EmbeddedSetup?…&tmpl=new_account
→ HTTP 200
→ 302 → https://accounts.google.com/v3/signin/identifier?
          …&flowName=EmbeddedSetupAndroid
          &continue=https://accounts.google.com/o/android/auth?…&return_user_id=true
```

`flowName=EmbeddedSetupAndroid` 是 Google 为 Android 设备专门保留的流程，
`continue` 落点 `/o/android/auth` 正是下发 `oauth_token` cookie 的地方。

**证据 3 —— TLS 禁忌（gpsoauth 上游血泪史，实测复现）**：

| 禁忌 | 后果 |
|---|---|
| 请求携带 **ALPN 扩展** | 403 `BadAuthentication` |
| 置位 `SSL_OP_NO_TICKET` | 403 `BadAuthentication` |

（gpsoauth 里那段 `CIPHERS` 列表其实是**死代码** —— 只在 urllib3 < 2.0 时生效，
现代环境只有上面两条真正要紧。Node 的 `node:https` 默认两条都满足。）

**证据 4 —— `droidguard_results` 目前接受假值**：gpsoauth 传 `"dummy123"`，
MicroG 传 `"null"`，均放行 → Play Integrity 证明在这条链路上不是硬门槛。

### 2.5 怎么用（三条路，任选）

**路 1：网页界面（推荐）**

```
打开  https://<你的服务>/login
```

页面会引导完成：打开 Google 登录页 → 复制 `oauth_token` → 粘贴 + 填 Admin Key
→ 服务端换 master token 并**当场验证能否铸出 `ya29.*`** → 回显待写入的环境变量三行。

**路 2：命令行（PC 侧，零依赖）**

```bash
# 0) 探活（不需要任何凭证）
python tools/gpsoauth.py probe

# 1) 打印网页登录 URL 与建议 UA
python tools/gpsoauth.py login-url

# 2) 一条龙：oauth_token → master → assistant scope token
python tools/gpsoauth.py robin --email me@gmail.com --oauth-token <粘贴>

# 3) 从浏览器 cookie 文本/DevTools 粘贴内容里自动抠出 oauth_token
pbpaste | python tools/gpsoauth.py cookie --from-stdin
```

**路 3：服务端 API**

```bash
# 绑定（等价于 /login 表单提交）
curl -X POST https://<你的服务>/admin/gpsoauth \
  -H 'x-admin-key: <ADMIN_KEY>' -H 'content-type: application/json' \
  -d '{"email":"me@gmail.com","oauthToken":"<粘贴>"}'
# → { ok, email, androidId, masterToken, service, tokenTail, tokenStatus }

# 查状态 / 强制铸一枚新 token
curl https://<你的服务>/admin/gpsoauth -H 'x-admin-key: <ADMIN_KEY>'
curl -X POST 'https://<你的服务>/admin/gpsoauth?action=mint' -H 'x-admin-key: <ADMIN_KEY>'
```

**持久化（Vercel 必读）**：运行时绑定只存活到本进程结束。Vercel 无状态，
所以把 `/login` 回显的三行写进 **Project Settings → Environment Variables**：

```
GSA_EMAIL=me@gmail.com
GSA_MASTER_TOKEN=oauth2rt_1/…
GSA_ANDROID_ID=0123456789abcdef   # 留空则由 master token 派生，冷启动稳定
```

配好后服务端会**按需自动铸 token**（缓存至过期前 90 秒），Robin 侧若收到
`UNAUTHENTICATED` 还会丢弃缓存重铸一次并自动重试 —— 全程无需人工干预。

### 2.6 排障：提交账号密码后「此浏览器或应用可能不安全」

**症状**：登录页能打开、能输入账号密码，但**点登录之后**跳到
“Couldn't sign you in — This browser or app may not be secure.”（即 `disallowed_useragent` 拦截页）。

**根因（2026-10-15 实测定位）**：这不是"打开链接时"的门禁，而是 Google 在**凭据提交时刻**
对**容器**做的可信度判定。逐层证据：

| 实验 | 结果 | 结论 |
|---|---|---|
| curl / 桌面 Chrome / 安卓 WebView 等 **6 种 UA** 直接 GET `EmbeddedSetup` | 全部 200 放行 → 跳 `flowName=EmbeddedSetupAndroid` | 入口门禁不看 UA，**拦截点确实在提交凭据之后** |
| 社区先例（gpsoauth#66，2024） | 普通 Firefox / Chrome / iPad 都能走完流程 | 桌面浏览器本身被 Google 接受 |
| photos-backup-desktop#1（2026-09） | 桌面应用正常沙箱可登录；**关闭渲染器沙箱后 Google 立即拦截** | Google 检测的是"容器异常"信号，不只是 UA |

常见触发条件（按概率）：
1. **在嵌入式 WebView 里打开**：应用内预览面板、聊天工具的内置浏览器、宿主吞掉 `target=_blank`
2. **浏览器被改过指纹**：无沙箱启动、自动化标志（`--enable-automation` / `navigator.webdriver`）、可疑扩展
3. 冷门浏览器壳（非 Chrome / Edge / Firefox 官方内核）

**排障阶梯（按顺序试，命中即停）**：

| # | 操作 | 说明 |
|---|---|---|
| ① | **无痕窗口**（`Ctrl+Shift+N`）粘贴链接重开 | 无扩展、无既有会话；对"从应用预览面板点开"的场景基本一步解决 |
| ② | `node tools/browser-login.mjs --email <邮箱>` | **一键脚本**：官方 Edge/Chrome + 全新专用配置 + CDP 自动抓 `oauth_token`，不用开 F12（见 §2.6.1） |
| ③ | 上述命令加 `--ua magic` | 复刻 microG 同款指纹：真机 Android WebView UA（`; wv`）+ 魔术后缀 ` MinuteMaid`（microG `LoginActivity.java` / `Build.kt` 原样）——Google 对带该标记的客户端放行嵌入式流程 |
| ④ | 加 `--reauth` | 换重认证入口 `embedded/reauth/v2/android?Email=…`（已有账号场景） |
| ⑤ | 回退设备侧提取 | §六 / §七（Frida / 模拟器）——百试百灵，代价是依赖设备 |

**两个高频误解**：
- 点完「I agree」后页面**永远转圈是正常的**（社区先例与 gpsoauth README 均已注明）——
  `oauth_token` 在那时已经写好了，直接取即可；`browser-login.mjs` 正是靠自动轮询规避这一点。
- 拦截页与本服务无关：账号密码全程只提交给 Google 的页面，`localhost:8791` 不参与登录。

#### 2.6.1 一键脚本 `tools/browser-login.mjs`

```bash
# 默认（干净容器）：登录后自动抓 oauth_token → 换 master token → 验证 ya29.*
node tools/browser-login.mjs --email me@gmail.com

# 排障升级：microG 同款设备指纹
node tools/browser-login.mjs --email me@gmail.com --ua magic

# 抓完直接注入本地服务
node tools/browser-login.mjs --email me@gmail.com \
  --service http://127.0.0.1:8788 --key <ADMIN_KEY>

# 清掉专用配置目录（内含登录态，用完建议清一次）
node tools/browser-login.mjs --cleanup
```

产物：`out/oauth-token.txt`（网页 token）、`out/gpsoauth-env.txt`（三行环境变量）。
原理：官方 msedge/chrome + `--user-data-dir=out/login-profile`（全新无扩展配置）+
本机 CDP（零依赖 `WebSocket`）自动轮询 cookie —— **无需手工开 DevTools 翻找**。

### 2.7 已知风险与尚未验证的环节

| # | 风险 | 影响 | 现状 |
|---|---|---|---|
| 1 | `EmbeddedSetup` 可能被 Google 下线 | 网页登录入口消失 | MicroG 现役代码仍在用，实测 `flowName=EmbeddedSetupAndroid` 存活；备用入口 `embedded/reauth/v2/android` |
| 2 | `auth/assistant` 可能不接受 `has_permission=1` 放行 | 第 ③ 步拿不到 `ya29.*` | **唯一未验证环节**。但 `app` 与 `client_sig` 都是 AGSA 本尊，且 AGSA 确实持有该 scope → 服务端看不出差别 |
| 3 | Play Integrity 可能收紧，不再接受 `droidguard_results` 假值 | 第 ② 步或 ③ 步被拒 | 目前接受假值（gpsoauth / MicroG 双证） |
| 4 | 新设备 / 数据中心 IP 触发账号风控 | 需要额外验证 | Vercel 出口 IP 属数据中心；先本地跑通再上云更稳 |
| 5 | `oauth_token` 是高敏感凭证 | 泄露 ≈ 账号长期登录态 | 只粘贴到自己部署的服务；master token 按密码级别保管 |

> **失败时的判读**：第 ② 步报 `BadAuthentication` → `oauth_token` 过期/复制不全，重走 §2.3 ①；
> 第 ③ 步报错但 ② 成功 → 风险 #2 命中，此时回退到 §六 设备侧提取方案。

### 2.8 为什么"冒充 AGSA"在原理上站得住

`GetTokenRequest` 的四选一 token 类型里有一个 `setOauth2Scopes()`；kb Sriram 2014 年
逆向这套协议时发现请求里有个 **`has_permission=1`** 参数 —— 当 `client_sig` 命中一个
已知的 Google app 签名时，服务端直接认为"这个调用者本来就有权拿这个 scope"。
gpsoauth 与 MicroG 的载荷里都带着它，这也是它们能持续工作十余年的原因。

换句话说：**我们不是在绕过权限系统，而是在使用 Google 为"设备上的 Google app"
保留的合法通道 —— 只是请求不再来自那台设备。**

### 2.9 ★ 成功环境实录（2026-10-15 本机实测，完整记录）

> 本节逐项记录**实测成功**的登录环境全量参数，供复现与排障对照。
> **结论先行：Microsoft Edge + 全新专用配置 + 默认 UA 即成功；无需魔改指纹、无需卸载扩展。**

#### 成功快照（两次，交叉印证）

| 维度 | 第 1 次成功 | 第 2 次成功（自动落盘） |
|---|---|---|
| 时间 | 2026-10-15 16:39 (+0800) | 2026-10-15 16:57 (+0800) |
| 浏览器 | Microsoft Edge **155.0.4283.45** | 同 |
| 可执行文件 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | 同 |
| 专用配置目录 | `out/login-profile`（全新） | `out/login-profile-edge2`（全新） |
| CDP 端口 | 9333 | 9337 |
| UA | **默认（不伪装）** | **默认（不伪装）** |
| 账号 | 0xcr1st0f0r0@gmail.com | 同 |
| 结果 | oauth_token → master（`aas_et/…`，223 字符）→ ya29 | 全链路自动落盘 `out/gpsoauth-env.txt` |

**启动命令行（两次同构，仅端口/配置目录不同）**：

```text
msedge.exe
  --remote-debugging-port=9337
  --remote-allow-origins=*
  --user-data-dir=D:\work\fk_you_gemini_app\out\login-profile-edge2
  --no-first-run
  --no-default-browser-check
  --disable-features=Translate,MediaRouter
  --disable-extensions
  about:blank
```

#### 失败对照（同账号、同一天，三段曲线）

| 时刻 | 环境 | 结果 | 判读 |
|---|---|---|---|
| 16:44 | Edge 9333 **复用刚成功的窗口** | `rrk=46` rejected | 同环境立即重试也拒 → 与浏览器无关 |
| 16:49 | **全新 Chrome**（155.0.8059.40，`out/login-profile-chrome`，9336） | `rrk=46` rejected | 换品牌也拒 → **账号/环境级风控** |
| 16:57 | 全新 Edge 配置（`login-profile-edge2`，9337） | ✅ 成功 | **等待冷却（~13 分钟）+ 全新配置 → 放行** |

**三条判读结论**：

1. **`rrk=46` 是临时风控，不是永久拉黑**：短时间重复 EmbeddedSetup 设备注册触发；冷却后同样的浏览器即可过。
2. **触发因素排序**：① **时间密度（关键）** > ② 配置新鲜度 > ③ 浏览器品牌。
   首次成功后 **15 分钟内不要重复登录**；重试时换**全新 `--user-data-dir`**（新 profile 名 + 新端口）。
3. **扩展与 UA 均非决定性**：本机注册表强制注入的扩展（Edge 6 个 / Chrome 2 个；`--disable-extensions` 挡不住注册表级强装）在成功会话中同样存在；magic UA 是备用手段，两次成功均为默认 UA。**不必为登录卸载扩展或伪装 UA。**

#### 复现 SOP（唯一推荐路径）

```bash
# 1) 启动登录窗口（全新配置 + 默认 UA = 实测成功配方）
node tools/browser-login.mjs --email 0xcr1st0f0r0@gmail.com --port 9337 --profile out/login-profile-edge2

# 2) 在弹出的 Edge 窗口完成 Google 登录
#    ⚠️ 点 I agree 后持续转圈 = 正常（token 已写好），脚本会自动捕获 —— 不要关窗口

# 3) 脚本自动完成 oauth_token → master token → ya29 并三处落盘
```

**若被拦**（“此浏览器或应用可能不安全”或 `rrk=46`）：

| 阶梯 | 操作 |
|---|---|
| ① | **等 ≥15 分钟**，再用**全新配置**重试（换 `--profile` 名 + 换 `--port`） |
| ② | 加 `--ua magic`（microG 指纹）或 `--reauth`（已有账号重新认证入口） |
| ③ | 回退 §六 / §七 设备侧提取（Frida / 模拟器，百试百灵） |

#### 成功后的落盘清单（三个文件）

| 文件 | 内容 | 敏感级 |
|---|---|---|
| `out/gsa-credentials.json` | email / androidId / masterToken / robinToken（**统一凭证**，脚本与服务共用） | 🔴 密码级 |
| `out/gpsoauth-env.txt` | GSA_EMAIL / GSA_MASTER_TOKEN / GSA_ANDROID_ID（Vercel 环境变量块） | 🔴 密码级 |
| `out/robin-token.txt` | ya29 访问令牌（1 小时过期，可由 master 重铸） | 🟡 短期 |

> `out/` 已在 `.gitignore` —— 含 master token 的目录**绝不能进 git**。
> master token（`aas_et/`）**长期有效**；日常刷新只需 `python tools/gpsoauth.py robin`（或服务端自动续期），**无需重新登录**。

#### 环境时间线（2026-10-15 全程）

| 时刻 (+0800) | 事件 |
|---|---|
| 15:41 | `browser-login.mjs` 完成 + 自检通过（Edge 155.0.4283.45） |
| 16:39 | **★ 第 1 次全链路成功**（Edge 9333 / `login-profile`） |
| 16:40 | 用 ya29 打真实 Robin 上游 → HTTP 200 + `grpc-status=3 "First request should be 'initial'"` → **认证层实证通过** |
| 16:44 | 同窗口重试 → `rrk=46` |
| 16:49 | 全新 Chrome 9336 → `rrk=46` |
| ~16:50 | 服务端 cookie 重放实验失败（会话仅 6 个 cookie、无 SID 体系）→ 放弃该路径 |
| 16:57 | **★ 第 2 次全链路成功**（Edge 9337 / `login-profile-edge2`，自动落盘） |
| 16:59 | 统一凭证 `out/gsa-credentials.json` 生成（4 字段 + note + savedAt） |

---

## 三、为什么"第三方登录页"仍然不可行（三重死锁，已逐条核实）

> ⚠️ 本节结论**仅适用于自建 OAuth client 的路径**（即"申请一个 client_id，
> 让用户走 Google 授权页"）。§二 的网页登录方案不在此列 —— 它的身份凭据是
> 「包名 + 签名证书」而非 client_id，因此三把锁一把都不拦它。

| # | 死锁 | 核实方式 |
|---|---|---|
| 1 | **`assistant` 是 Google 内部 scope**，不在公开 OAuth scope 列表里 → 第三方 client_id 请求必然 `invalid_scope` | 已核对 developers.google.com/identity/protocols/oauth2/scopes 全表：**无任何 assistant scope** |
| 2 | 即使拿到 token，Robin 服务端大概率校验 **audience/client_id == Google 官方 app** | 无法静态确证，但 scope 本身的封闭性已足够说明 |
| 3 | GMS 是**白名单**机制：token 请求由「包名 + 签名」二元组在服务端校验，只有 Google 官方 app（AGSA `com.google.android.googlequicksearchbox`）在列 | `GetTokenRequest` 经 Binder 交 GMS Core 处理，校验发生在服务端 |

**所以"申请一个 OAuth client_id、让用户点授权页拿 token"这条路不存在。**
（注意 AGSA 全域 14 个 dex 里 `\d+-xxx.apps.googleusercontent.com` 形态**命中 0 条**
→ 连 Google 自己的 app 都不用 client_id 走这条路。）

### 3.1 （备选）OAuth Playground 5 分钟实验

在 §二 方案出现之前，这里记录的是一次"可能翻盘"的实验。现在它已降级为
**可选的交叉验证**：用它确认"第三方 client 是否真的拿不到 assistant scope"。

1. 打开 https://developers.google.com/oauthplayground/ （已登录 Google 账号）
2. **Step 1** 面板底部 "Input your own scopes" 填入 `https://www.googleapis.com/auth/assistant`
3. **Authorize APIs** → 走授权页 → 回到 Playground
4. **Step 2: Exchange authorization code for tokens**

| 结果 | 含义 |
|---|---|
| 授权页正常 + Step 2 拿到 `ya29.` | 三重死锁被推翻，这条更简单的路也能走（此时 §二 仍是更优解：可续期） |
| `invalid_scope` / 无权限 / 授权页报错 | 与 §三 结论一致，继续用 §二 的方案 |

---

## 四、获取凭证的入口（静态分析完整链路）


```
[AGSA 进程]                                          [GMS 进程]         [Google 服务端]
 Robin gRPC 调用
   │  请求头: authorization: Bearer <token>
   ▼
 Lbcvm  ← CallCredentials 实现（构造 "Bearer %s" + "X-Auth-Time"）
   │
   ▼
 Lfvtj / Lfvtr  ← token 缓存层（Instant/Duration 判过期，不到期直接用缓存）
   │
   ▼
 Lftys → Lftxt → Lfucc → …
   │
   ▼
 GMS AANG API:
   GetTokenRequest { GoogleAccount, oauth2Scopes=[.../auth/assistant], … }
   │  Parcelable 跨进程（Binder）
   ▼────────────────────────────────────────────────►│
                                                      │  校验 caller（包名+签名）
                                                      ▼────────────────────►│
                                                                              │ 签发
   GetTokenResponse { a: "<ya29.…>", b: Oauth2TokenMetadata }                │◄──┘
   ◄─────────────────────────────────────────────────────────────────────────┘
   │
   ▼
 回退路径（GMS 不可用时）:
   Lgitk（FallbackGoogleTokenProvider）
     "Failed to get token from GMS Core, falling back to AccountManager"
       → android.accounts.AccountManager.getAuthToken()
         → GMS 的 Google 账号认证器（同样经服务端校验）
```

**关键类速查表**（均为字节码实证）：

| 类 | 角色 | 位置 |
|---|---|---|
| `Lbcvm` | CallCredentials：把 token 拼成 `Bearer %s` 塞进 gRPC metadata | classes.dex |
| `Lfvtr` / `Lfvtj` | token 缓存器（含过期判定；`d()` 比 `Instant`） | classes2.dex |
| `Lftys` → `Lftxt` | auth 层封装（`i()/j()` 两个 provider 方法） | classes2.dex |
| `Lgitk` | **Fallback**：GMS 失败 → AccountManager | classes10.dex |
| `com.google.android.gms.auth.aang.GetTokenRequest` | 请求对象（Parcelable，含 oauth2Scopes / webLoginUrls / clientLoginScopes） | classes7.dex |
| `com.google.android.gms.auth.aang.GetTokenResponse` | **响应对象，字段 `a` = token 本体** | classes7/8.dex |

**额外发现**：`GetTokenRequest` 支持四种 token 类型（互斥）——
`setOauth2Scopes()` / `setWebLoginUrls()` / `setClientLoginScopes()` / `setOauth2TokenId`。
其中 `setWebLoginUrls` 是为「需 web 登录交互的 token」设计的（GMS 内部 API，AGSA 当前未调用）——**不构成我们的可用入口**，但说明这条 API 的扩展空间。

---

## 五、可行路径与"不依赖手机"备选（按推荐度）

### 5.1 拿到 Robin 凭证的路径

| 方案 | 需要什么 | 可行性 | 自动化 | 备注 |
|---|---|---|---|---|
| **★ 0. 网页登录 + 设备认证端点** | 一个浏览器 | ★★★★★（已实测） | ✅ 长期凭证 + 自动铸新 token | **首选**：`/login` 页面即可完成；见 §二 |
| **A. 真机 root + Frida** | 已 root 的 Android 手机 | ★★★★★ | 可常驻自动刷新 | 直接 hook，产物是 `ya29.*`；协议校准价值高 |
| **B. 模拟器（AVD + Google APIs）+ Frida** | 一台 PC（Android Studio） | ★★★★ | 可脚本化 | 无需真机 root；风险：Google 账号在模拟器登录可能受限 |
| **C. 真机 root + 系统证书 + MITM** | 已 root 手机 + mitmproxy | ★★★★ | 可常驻 | **协议校准价值最高**（能同时看到完整请求头，用于填 ROBIN_EXTRA_HEADERS） |
| **D. 无 root 尝试** | — | ✗ | — | AGSA `targetSdk=37` → **不信任用户 CA**，MITM 抓不到；也无其他注入点 |
| **E. 自建 OAuth client + 授权页** | Google Cloud 项目 | ✗ | — | 见 §三（三重死锁）；`assistant` 不在公开 scope 表 |
| **F. OAuth Playground 实验** | 浏览器 + 5 分钟 | ❓ 交叉验证用 | — | 见 §3.1；仅在想复核 §三 结论时做 |

部署形态建议（**路 0，推荐**）：

```
[浏览器]                                    [Vercel 服务]
  Google 网页登录 ──oauth_token──►  /login 表单
                                        │ exchange_token
                                        ▼
                                   master token（长期，环境变量持久化）
                                        │ perform_oauth（按需，缓存至过期前 90s）
                                        ▼
                                   ya29.* ──► Robin gRPC
```

部署形态建议（路 A/B/C，需要设备）：

```
[你的手机(root)]                        [Vercel 服务]
  Frida 脚本 ──每 40 分钟──► 提取 token ──HTTPS POST──►  /admin/token
                                                          │
                                                          ▼
                                                  内存/环境变量（供 Robin 调用）
```

### 5.2 如果"不依赖手机"是硬需求：替代路线对比

| 路线 | 机制 | 网页登录？ | argon 视频能力 | 手机依赖 | 状态 |
|---|---|---|---|---|---|
| **★ 0. 网页登录 + 设备端点（§二）** | EmbeddedSetup 网页登录 → oauth_token → master token → 铸 ya29.* | ✅ 完全网页（复制一个 cookie） | ✅ Robin 原生（跑在服务端，与设备无关） | ❌ 无 | **已实测打通并接入服务** |
| **W. Web 通道（cookie）** | 浏览器登录 gemini.google.com → 复制 `__Secure-1PSID` + `__Secure-1PSIDTS` → 服务端走 batchexecute RPC | ✅ 完全网页（F12 复制，2 分钟） | ❓ 你自己的测试显示"网页端 argon 不行"——大概率不满足 | ❌ 无 | 有大量开源先例（gemini-web-to-api / Gemini-FastAPI 等） |
| **G. 官方 Gemini API（API key）** | AI Studio 页面点两下拿 API key → `generativelanguage.googleapis.com` | ✅ 完全网页 | ✅ 官方 API 原生支持视频（inlineData / Files API） | ❌ 无 | **但模型不是 argon**（是公开版 Gemini）；有免费层，重度使用收费 |
| **M. 云手机（云端 Android）** | 云端跑 Android 实例（AVD on GCP / 第三方云手机）→ 登录 Google → Frida 常驻提取 | 🔶 半网页（你本人不碰手机，但需要云端设备常驻） | ✅ Robin 原生 | 🔶 依赖"云端设备"而非你的手机 | 需验证：Google 账号在数据中心 IP 的新设备上登录的风控 |
| **A. 设备提取（本机）** | 见 §六 | ❌ | ✅ Robin 原生 | ✅ 依赖 | 工具已交付 |

> **关键权衡**：`argon + 视频` 这个组合目前只在移动端 Robin 通道成立（你自己实测）。
> W 路线即使跑通，也大概率拿不到"argon 看视频"；G 路线拿得到视频但拿不到 argon 模型本身。
> **路 0 是唯一同时满足"不依赖手机"+"Robin 原生能力"的方案**，且已实测可跑。

---

## 六、方案 A：真机 root + Frida（详细步骤）

### 0. 前置检查
```bash
# 手机需已 root（Magisk / KernelSU 均可）；检查
adb shell su -c id          # 应输出 uid=0(root)
```

### 1. 部署 frida-server（与手机架构匹配）
```bash
# 在 PC 上查看手机架构
adb shell getprop ro.product.cpu.abi     # 常见 arm64-v8a

# 下载对应 frida-server（版本需与 PC 的 frida-tools 一致）
# https://github.com/frida/frida/releases  →  frida-server-<ver>-android-arm64.xz
xz -d frida-server-*-android-arm64.xz
adb push frida-server-*-android-arm64 /data/local/tmp/frida-server
adb shell "su -c 'chmod 755 /data/local/tmp/frida-server'"
adb shell "su -c '/data/local/tmp/frida-server &'"

# PC 侧
pip install frida-tools
frida-ps -U                              # 能看到进程列表 = 通了
```

### 2. 确认 AGSA 进程名
```bash
frida-ps -U | grep -i -E "googlequicksearchbox|velvet|google"
```
AGSA 是多进程架构（`VelvetMultiprocessRoot_Application`）。
主进程名通常是 `com.google.android.googlequicksearchbox`；
若在主进程没截到 token，换下列进程重试（哪个跑网络请求就 hook 哪个）：
- `com.google.android.googlequicksearchbox:search`
- `com.google.android.googlequicksearchbox:interactor`
- 或**直接 hook GMS**：`com.google.android.gms`（所有 app 的 token 请求总闸）

### 3. 注入提取脚本
```bash
frida -U -f com.google.android.googlequicksearchbox \
      -l tools/frida/extract-robin-token.js --no-pause
# 或对已运行进程：
frida -U -n com.google.android.googlequicksearchbox \
      -l tools/frida/extract-robin-token.js
```

### 4. 触发 token 获取
在手机上**正常打开 Gemini / Assistant 发一条消息**（任何会让它连 Robin 的操作）。
脚本会打印：
```
========================================================================
[★ TOKEN 截获]  来源: Parcel.readString
  token  : ya29.a0AfH6SM…
  tokenLength: 218
  已写入 : /data/local/tmp/robin-token.json（共 1 条）
========================================================================
```

### 5. 取回 token
```bash
adb shell "su -c 'cat /data/local/tmp/robin-token.json'"
# 或直接从 frida 控制台复制
```

### 6. 填入服务端
```bash
curl -X POST https://<你的服务域名>/admin/token \
  -H "x-admin-key: <ADMIN_KEY>" \
  -H "content-type: application/json" \
  -d '{"token":"ya29.…","expiresIn":3600}'
```

### 7. （可选）自动化：token 保鲜脚本
Token 约 1 小时过期。两种自动化路线：
- **Frida 常驻 + 定时上报**：脚本挂 `setInterval` 每 40 分钟触发一次提取并 POST 给服务端（需要设备保持连接、frida-server 常驻）
- **半自动**：token 失效时服务端返回 401/`UNAUTHENTICATED`，你重新跑一次第 3-6 步

---

## 七、方案 B：模拟器路线（无需真机 root）

```bash
# 1. 创建带 Google APIs 的 AVD（Android Studio → Device Manager）
#    镜像选 "Google APIs"（非 "Google Play" 版才有 root）
avdmanager create avd -n gemini-test -k "system-images;android-35;google_apis;arm64-v8a"

# 2. 启动模拟器
emulator -avd gemini-test -writable-system

# 3. Android 模拟器默认支持 adb root
adb root && adb remount

# 4. 安装 AGSA（用项目里的 xapk 或从 Play 商店安装）
adb install-multiple apk/split/*.apk     # 若已有 split 包

# 5. 在模拟器里登录 Google 账号（设置 → 账号）
#    ⚠️ 关键不确定点：Google 可能拒绝在模拟器环境登录 / 或 AGSA 在模拟器受限

# 6. 部署 frida-server（同方案 A 第 1 步），注入提取脚本（第 3 步起）
```

> **待验证**：Google 账号在模拟器的可用性、AGSA 在模拟器上是否触发 Robin 通道。
> 若受阻，回退方案 A（真机 root）。

---

## 八、方案 C：MITM 抓包（附带完整请求头 —— 对协议校准极有价值）

AGSA `targetSdkVersion=37` → **默认不信任用户安装的 CA**。必须：

1. root 手机装 **Magisk 系统证书模块**（如 "Magisk Trust User Certs"），把 mitmproxy CA 提升为系统证书
2. 手机 Wi-Fi 代理指向 PC 的 mitmproxy（`mitmproxy --mode regular@8080`）
3. 抓 `robinfrontend-pa.googleapis.com` 的 HTTP/2 流量

**能拿到什么**：
- `authorization: Bearer ya29.…`（token）
- **完整的其它请求头**（`x-goog-*`、device 指纹等）→ 直接决定 `ROBIN_EXTRA_HEADERS` 能不能配对
- gRPC 帧的原始字节（可与 `service/scripts/probe.mjs` 的输出逐字节对照）

> 注意：需要确认 AGSA 是否启用了证书 pinning。若有 pinning，需配合 Frida 绕过（`frida-multiple-unpinning` 之类的脚本）。

---

## 九、拿到 token 后的验证流程（5 分钟）

```bash
cd service

# 0. ★ 先探端点（不需要任何凭证；拿到 BadAuthentication 就说明链路 OK）
python ../tools/gpsoauth.py probe

# 1. 先看本地组装的请求长什么样（不发网络请求）
node scripts/probe.mjs --hex "你好"

# 2. 配好 token，打真实上游，看 gRPC 响应
ROBIN_AUTH_TOKEN="ya29.…" node scripts/probe.mjs --live "你好"

# 2b. ★ 或者直接用 §二 的网页登录方案跑一条龙（推荐）
python ../tools/gpsoauth.py robin --email me@gmail.com --oauth-token <粘贴>

# 3. 常见的 grpc-status 及含义：
#    UNAUTHENTICATED (16) → token 无效/过期/scope 不对
#    PERMISSION_DENIED (7) → token 有效但账号/客户端不允许（需完整设备头）
#    INVALID_ARGUMENT (3) → 请求体字段不对（回到 §stage2 文档对照字段表）
#    OK (0)               → 通了，可以接翻译层
```

---

## 十、结论摘要（给未来的自己）

1. **凭证 = 一个 Google 账号的 `assistant` scope access token（`ya29.*`，约 1h）**。
2. **首选获取方式：网页登录。** 浏览器登录 `accounts.google.com/EmbeddedSetup`
   → 复制 `oauth_token` cookie → 服务端用 `android.clients.google.com/auth` 换
   **长期** master token → 按需铸 `ya29.*`（自动续期）。
   **不需要手机 / root / OAuth client_id。已实测打通，落地在 `/login`。**
3. 之所以成立：该端点认的是「**包名 + 签名证书 SHA-1**」而不是 client_id，而
   AGSA 的证书 SHA-1 = `38918a453d07199354f8b19af05ec6562ced5788`，
   **与 GMS Core 是同一张 Google 平台证书**（`tools/apksig.py` 实测复现）
   → 冒充 AGSA 时服务端签名校验天然通过。
4. **自建 OAuth client 的"授权页登录"仍然不可行**：scope 不对外 + GMS 白名单 +
   audience 校验，三重死锁（§三）；但它拦不住第 2 条 —— 两者身份维度不同。
5. **备选路径**：真机 root + Frida（`POST /admin/token` 上报）、模拟器、云手机；
   静态 `ROBIN_AUTH_TOKEN` 仅作兜底（不会自动续期）。
6. 服务端凭证优先级：`注入(/admin/token)` > `TOKEN_PROVIDER_URL` >
   **`GSA_MASTER_TOKEN`（网页登录，自动续期）** > `ROBIN_AUTH_TOKEN`。
7. 工具链：
   - `tools/apksig.py` — 零依赖提取 APK 签名证书指纹（解出 client_sig）
   - `tools/gpsoauth.py` — 零依赖复刻 gpsoauth（`probe` / `login-url` / `cookie` / `exchange` / `oauth` / `robin`）
   - `service/lib/gpsoauth.js` — 服务端 Node 实现（Vercel 可用）
   - `service/lib/login-page.js` — `/login` 绑定页
   - `tools/frida/extract-robin-token.js` — 备用：设备侧五路 hook 提取

