# gemini-robin-proxy（Vercel 反代服务）

把 **Gemini app 的 Robin gRPC 通道**（`robinfrontend-pa.googleapis.com` / `assistant.mobile.robin.RobinService`）
包装成 **Gemini 原生格式的 HTTP API**（`/v1beta/models/{model}:generateContent` 等），
供 argon 等客户端使用，从而获得**移动端独有的音视频输入能力**。

**部署目标：Vercel Hobby（免费版）** · **当前状态：文本/图片/音频/视频/工具调用/模型档位/思考强度全链路真实上游实证通过（2026-10-16）**

---

## 一、架构

```
客户端 (argon)
   │  Gemini 原生格式 HTTP
   ▼
┌─────────────────────────── Vercel 函数（Node.js Runtime）───────────────────────────┐
│  server.mjs            入口（Vercel 捕获 listen()）                                │
│  lib/app.js            路由 / CORS / 鉴权 / 413 保护 / SSE                         │
│  lib/gemini.js         Gemini ⇄ Robin 翻译（contents/parts/inlineData）            │
│  lib/pq.js  ★          ProcessQuery 协议层（请求装配 + 响应解析，字段号=逆向结论）   │
│  lib/modes.js ★        模型档位（mode id）+ 思考强度（thinking level）解析与缓存    │
│  lib/toolcall.js ★     Function Calling prompt 仿真（上游无工具声明位）            │
│  lib/wire.js           protobuf wire + gRPC 5 字节帧（零依赖）                     │
│  lib/robin.js          node:http2 gRPC 客户端（会话单例 / idle 收尾 / trailers）    │
│  lib/upload.js  ★      push.clients6 上传（已实证：finalize 响应体即 blobId）       │
└────────────────────────────────────────────────────────────────────────────────────┘
   │  HTTP/2 + gRPC（Lgcvp 帧 ←→ Lgcvq 帧，均无外层包装）
   ▼
robinfrontend-pa.googleapis.com / ProcessQuery
```

### 请求/响应结构（★2026-10-16 实证版，详见 `docs/stage2-robin-protocol.md` §5.8 / §5.13 / §5.14）

```
请求（三步式，均为裸 Lgcvp，无 Lgcxj 包装）：
  initial:  Lgcvp{ [ext1000] Lgcvm{ #1 Lgauy{ #25:文本, #4:ClientType=2, ★无信封时才带 #16:档位 },
                 #2 Lgcww{ #1:文本 }, #8:mode=1,
                 [ext1001] Lgcvb{ #1 Lfzqy{ #13 Lgauy{ #16:模型档位 mode id },  ← ★档位承载位（§5.14）
                                           #48:思考档位,                      ← ★ 1=Low / 4=Medium / 2=High
                                           #1 Lgbkn{ #3 Lgbku{ #1 Lgbkr{#1 blobId,#3 mime,#4 enum}, #2 name } } } } } }
  prefetch: Lgcvp{ [ext1007] Lgcvl{ #1: 查询文本 } }
  commit:   Lgcvp{ [ext1007] Lgcvl{ #2: 空 } }

响应：Lgcvq{ [ext1003] Lgcvc{ #1 Lfzrc{ #1 Lgapu[]{ #2 Lgace{#1 累积文本}, #7 快照, #20 语言 },
              #2 Lgavc{会话/响应 id}, #25 生效档位回显, #30 模型名, #42 思考档位回显 } } }   （gzip 压缩）
```

> ⚠️ **承载位铁律（2026-10-16 22:37 起上游收紧）**：档位与思考强度都必须经
> **`Lfzqy.#13 Lgauy`** 承载。只要 `Lgcvm.#1` 的 `Lgauy` 也带 `#16`，服务端就**整包忽略该信封**，
> `#48` 一并失效（`#42` 恒回 1）。信封在场时 `#13` 必须存在，缺了同样被忽略。
> 无信封（纯文本且未指定档位）时才由 `#1` 承载。判据是 `#42` 是否逐字等于请求的 `#48`。


**媒体链路实证结果**（上传 → blobId → 信封 → initial，服务端真实读取内容）：

| 媒体 | 测试文件 | `Lgbkr.#4` | 服务端应答 |
|---|---|---|---|
| 图片 | 纯蓝 64×64 PNG | 1 | 「这张图片是蓝色的。」 |
| 音频 | 440Hz WAV | 12 | 「这是一通电话拨号时的铃声或呼叫音。」 |
| 视频 | 纯绿 2s MP4 | 6 | 「这个视频的画面主要是绿色。」 |

### ★ 模型档位与思考强度（2026-10-16，两个**正交**维度）

| 维度 | 承载字段 | 取值 | 说明 |
|---|---|---|---|
| **用哪个模型** | `Lfzqy.#13 Lgauy.#16`（STRING）<br>（无信封时退回 `Lgcvm.#1 Lgauy.#16`） | mode id（16 位 hex，服务端下发） | `4-argon` / `3.8-flash` / `3.1-pro` / `3.5-flash-lite` |
| **想多久** | `Lfzqy.#48`（INT32） | **1=Low / 4=Medium / 2=High** | 不传 = 服务端按 Low；⚠️ 不是 1/2/3 |

> 两者都不改模型名：对外是**正交参数**，档位由模型名决定、思考强度由 `thinkingConfig` 决定。
> 上游回显核对：`Lfzrc.#25` = 实际生效档位、`Lfzrc.#41` = rank、`Lfzrc.#42` = 实际生效思考档位。

```bash
# 思考强度三种等价写法
curl -X POST "$BASE/v1beta/models/4-argon:generateContent" -H 'content-type: application/json' \
  -d '{"contents":[{"parts":[{"text":"hi"}]}],"generationConfig":{"thinkingConfig":{"thinkingLevel":"high"}}}'

curl -X POST "$BASE/v1beta/models/4-argon-high:generateContent" ...      # 模型名后缀
curl -X POST "$BASE/v1beta/models/4-argon:generateContent" -d '{"...":"...","generation_config":{"thinking_level":"medium"}}'
```

上游会在响应里回报真实档位：`modelVersion` 变成 `"Used 4 Argon High model"`，
且 `Lfzrc.#42` 逐字回显档位值（不发时为 1）。`GET /v1beta/models` 的 `thinkingMeta`
列出可用档位与全部写法。非法档位一律**忽略并回落默认**（不猜测、不误发）。

> ⚠️ 反直觉点：Low 档**不改变**上游自述模型名（仍是 `Used 4 Argon model`），
> 只有 Medium/High 才带后缀 ⇒ 用模型名做判据时，Low 与"未指定"不可区分。
> 取证链与实证数据见 `docs/stage2-robin-protocol.md` §5.13。

## 二、运行与测试

```bash
cd service

node server.mjs          # 本地服务 :3000
npm test                 # 单测(28) + 端到端(26)，全离线（内置 h2c mock Robin）
node scripts/probe.mjs --hex "你好"       # 只打印请求字节（联调第一步）
ROBIN_URL=http://127.0.0.1:8788 node scripts/probe.mjs "hi"   # 打 mock
ROBIN_AUTH_TOKEN=ya29.xxx node scripts/probe.mjs "你好"        # 打真实上游（需真机 token）
```

## 三、部署到 Vercel

**已部署（2026-10-15）**：项目 `gemini-robin-proxy`（team `wzy3450354617-7877s-projects`）

| 项 | 值 |
|---|---|
| 生产 URL | `https://gemini-robin-proxy.vercel.app` |
| 区域 / 时长 | `hkg1` / maxDuration 300s |
| Node | 22.x（`package.json` engines） |
| 部署保护 | **已关闭**（`ssoProtection: null`，否则外部无法调用） |

**环境变量**（Vercel Project Settings → Environment Variables，production）：

| 变量 | 值 | 说明 |
|---|---|---|
| `GSA_EMAIL` | 谷歌账号邮箱 | gpsoauth 凭证三件套 |
| `GSA_MASTER_TOKEN` | `aas_et/...` | 网页登录换得，永久有效 |
| `GSA_ANDROID_ID` | 16 位 hex | 留空则自动派生 |
| `PROXY_API_KEY` | `sk-grp-...` | ★下游调用密钥（`x-goog-api-key` 头或 `?key=`） |
| `ADMIN_KEY` | hex | `/admin/token` 等管理端点口令 |

**安全机制**：
- 全部 API 路由要求 `x-goog-api-key: <PROXY_API_KEY>`（或 `authorization: Bearer`）；
  缺失/错误 → 401。生产环境已开启并实测。
- 轻量限流：默认 30 req/min/IP（函数实例级，serverless 语义，best-effort；
  可用 `RATE_LIMIT_MAX` 调整）。真正的硬限额需 Vercel WAF（Pro）或 KV。

**大文件（Vercel 入站 4.5MB 硬限）**：
- 小媒体（< ~3.3MB）：`inlineData` 直接内联在 generateContent 请求里
- 大文件：Gemini File API 分片上传
  `POST /upload/v1beta/files`（start）→ 分片 PUT（**非最终片必须 262144 字节整数倍**，
  最终片任意大小）→ finalize 返回 `files/<id>` → generateContent 用
  `{fileData: {fileUri: "files/<id>"}}` 引用（无状态编码，跨实例可解析）

> 重复部署：`cd service && vercel deploy --prod`（CLI 需本机已登录；
> 凭证在 `%APPDATA%/com.vercel.cli/Data/auth.json`，token 过期会自动刷新）。

## 四、Vercel 免费版硬约束与对策

| 约束 | 值 | 对策 |
|---|---|---|
| 函数最长执行 | **300s**（Hobby，Fluid compute 默认）| `maxDuration: 300`；生成通常 < 60s |
| **入站请求体** | **4.5MB 硬限，无配置可绕** | 小媒体 inline；大媒体分片上传（chunk < 4.5MB，服务端转发）。**出站不受限** |
| 响应体 | 4.5MB，**流式豁免** | 全部走 SSE |
| 冷启动 | 零依赖包体 → 冷启动 ≈ 100–300ms | HTTP/2 会话模块级单例（Fluid compute 热实例复用） |
| 使用条款 | Hobby 仅限个人非商业 | 自用 OK；商业化换 Pro |

## 五、★ 凭证获取与联调校准

### 5.1 凭证（Robin token）—— 首选"网页登录"，服务端可自主续期

完整分析见 **`docs/credential-acquisition.md`**。结论速览：

- 需要 **一个 Google 账号的 OAuth2 access token**（`ya29.*`，scope=`https://www.googleapis.com/auth/assistant`，约 1 小时过期）
- 自建 OAuth client 的"授权页"路线**不通**：scope 不对外 + GMS 白名单 + audience 校验
- **但 `android.clients.google.com/auth` 这条"设备认证端点"通 —— 已实测**：
  它认的是「包名 + 签名证书 SHA-1」而非 client_id，而 AGSA 的证书
  `38918a453d07199354f8b19af05ec6562ced5788` 与 GMS Core 是**同一张 Google 平台证书**
  （`tools/apksig.py` 从 APK 实测复现）→ 冒充 AGSA 时签名校验天然通过

```
浏览器登录 accounts.google.com/EmbeddedSetup
   → 复制 oauth_token cookie
   → 服务端 exchange_token 换【长期】master token
   → 按需 perform_oauth 铸 ya29.*（缓存至过期前 90s，自动续期）
```

**★ 最快上手：打开 `https://<你的服务>/login`**，按页面三步走完。
命令行等价物：`python tools/gpsoauth.py robin --email <邮箱> --oauth-token <粘贴>`
（先 `python tools/gpsoauth.py probe` 可无凭证验证端点连通性）。

**★ 一键脚本（自动开窗 + 自动抓 cookie + 自动换 token，不用开 F12）**：

```bash
node tools/browser-login.mjs --email me@gmail.com              # 官方 Edge/Chrome + 全新专用配置
node tools/browser-login.mjs --email me@gmail.com --ua magic   # 排障升级：microG 同款设备指纹
```

> 排障：Google 在**提交账号密码那一刻**判定容器可信度，嵌入式浏览器（应用内预览面板、
> 聊天工具内置浏览器）会被拦到 “This browser or app may not be secure”。
> 优先用系统浏览器**无痕窗口**重开，或直接跑上面的脚本。
> 完整排障阶梯与实测证据见 `docs/credential-acquisition.md` §2.6。

**token 来源优先级**（`lib/auth.js` 按此解析）：

| # | 方式 | 配置 | 适用 |
|---|---|---|---|
| 1 | 运行时注入 | `POST /admin/token`（需 `ADMIN_KEY`） | 设备侧脚本周期上报 / 手动粘贴 |
| 2 | 外部供应器轮询 | `TOKEN_PROVIDER_URL`（返回 `{"token":"ya29..."}`，30s 缓存） | 内网/本机常驻提取器 |
| 3 | ★ **网页登录（master token）** | `GSA_EMAIL` + `GSA_MASTER_TOKEN`（+ 可选 `GSA_ANDROID_ID`） | **Vercel 上的推荐方案，自动续期** |
| 4 | 静态兜底 | `ROBIN_AUTH_TOKEN` | 临时调试（不会续期） |

> Vercel 无状态：`/login` 的运行时绑定只活到本进程结束。**把页面回显的三行写进
> Project Settings → Environment Variables** 才是正式做法。`GSA_ANDROID_ID` 留空时
> 由 master token 派生（SHA-256 前 16 位），冷启动稳定。

```bash
# ★ 网页登录绑定（等价于 /login 表单；响应含 masterToken）
curl -X POST https://<你的服务>/admin/gpsoauth \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"email":"me@gmail.com","oauthToken":"<粘贴 oauth_token>"}'

# 查询凭证状态（含 gpsoauth.bound / origin / 剩余秒数 / 最近错误）
curl https://<你的服务>/admin/gpsoauth -H "x-admin-key: $ADMIN_KEY"

# 强制铸一枚新访问令牌
curl -X POST 'https://<你的服务>/admin/gpsoauth?action=mint' -H "x-admin-key: $ADMIN_KEY"

# 备用：设备侧提取后手动注入
curl -X POST https://<你的服务>/admin/token \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"token":"ya29.…","expiresIn":3600,"account":"me@gmail.com"}'
```

> Robin 侧若收到 `UNAUTHENTICATED`（且未收到任何数据帧），会自动丢弃缓存令牌、
> 用 master token 重铸一次并重试 —— 边界时刻的 token 失效不会暴露成用户可见错误
> （见 `lib/robin.js` 的 `processAuth` 自愈逻辑）。

**备用提取路径**（需要设备时）：**root 真机 + Frida** → 模拟器 → MITM 抓包
（附带设备头，校准价值最高）。工具：`tools/frida/extract-robin-token.js`（5 路 hook）
+ `tools/frida/push-token.py`（自动上报）。

### 5.2 联调校准清单（拿到 token 后的 TODO）

代码里所有"未知值"都有 `TODO(校准)` 注释；集中清单在 `lib/pq.js` 头部。优先级排序：

| # | 项 | 位置 | 校准方法 |
|---|---|---|---|
| 1 | 必需头（设备指纹 / x-goog-*） | `ROBIN_EXTRA_HEADERS` | 真机抓包 → 复制到环境变量 |
| 2 | `Lgauy.#1 Lfzww` 枚举值 | `buildLgauy.lfzww` | 对照抓包 |
| 3 | `Lgauy.#3 Lgauw` 必需子字段 | `buildLgauy.lgauw` | 对照抓包（Lgpei=计时数据） |
| 4 | `Lgauy.#6 Lfzou` 枚举过滤列表 | `buildLgauy.lfzou` | 对照抓包 |
| 5 | `Lgcmv.#8` 模式语义（1/2） | `buildProcessQueryRequest.mode` | 已实现分支逻辑，待确认 |
| 6 | 附件字段映射（Lgbku 内 11 字段） | `buildLgbku` | 发一个图片/视频对照抓包 |
| 7 | 上传初始化 body / blobId 字段名 | `lib/upload.js` | `--dry-run` 拿 upload_url 后对照 |

**联调流程**：`probe --hex` 确认装配 → `probe` 发真实上游看 `grpc-status`
（0=成功 / 7=权限 / 3=参数 / 16=未认证）→ 按响应调上表中的项。

## 六、Function Calling（prompt 仿真兼容层）

**背景**：Robin 私有协议没有工具声明位——`tools` 字段直接丢弃时，模型会凭自身知识
幻觉作答（实测问"北京天气"→ 编造 15°C 多云，`functionCall=0` 且无报错）。
静默错误答案比响亮失败危险得多，故实现 **prompt 仿真**（方案移植自
`gemini_web2api`，其 Google API 路径与本代理同构）。

**机制**（`lib/toolcall.js`）：

| 侧 | 做法 |
|---|---|
| 请求 | `tools[].functionDeclarations` → `# Tool Use` 提示词块，约定 ` ```function_call\n{"name":…,"args":{…}}\n``` ` 输出格式；`toolConfig` 的 `AUTO/ANY/NONE` + `allowedFunctionNames` → 约束指令 |
| 历史 | `functionCall` part → 围栏标记；`functionResponse` part → `[Tool result for …]: {json}` 标记（多轮工具循环靠它保住） |
| 响应 | 从累积文本解析围栏块（支持围栏/无围栏/整段 raw JSON 三形态 + 括号深度扫描 + 白名单过滤），回填为 Gemini 原生 `functionCall` parts；围栏原文不泄给调用方 |
| 流式 | 工具模式下走「缓冲 → 解析 → 输出」：围栏块不能边到边透出 |

**真实通道实测**（2026-10-16，`out/_tools-emulation.mjs` + `out/_tools-loop-verify.mjs`）：

| 场景 | 结果 |
|---|---|
| 单工具（问天气） | ✅ `functionCall{get_weather,{city:北京}}`，无围栏泄漏 |
| 多工具选择（天气 vs 搜索） | ✅ 正确选 `get_weather` |
| 并行调用（问两个城市） | ✅ 一次返回 2 个 `functionCall`（北京 + 广州） |
| 闲聊（无需工具） | ✅ 纯文本，零误报 |
| 工具循环（第二轮带 `functionResponse`） | ✅ 荒谬值（99°C 火星沙尘暴 / -120°C 极夜永冻）被完整消费并据此推理 |

**已知边界**：
- 依赖模型遵循提示词格式——偶发不遵循时退化为纯文本回答（调用方按无工具处理），
  不会比"静默幻觉"更糟；
- 工具结果以 `[Tool result for …]` 显式标记为准（多轮历史被原样拼接上行，
  AI 侧能看到完整调用序列）；
- `googleSearch` / `codeExecution` 等内置工具同样走此仿真路径（Gemini SDK 会把它
  们放进 `tools[]`）。

**历史的上行为之为隐式**，即 AI 无法察觉되었습니다：系统会通过 ASCII 编码与
时间戳编码对历史行做消毒处理，且即使 AI 执 Markdown 代码块输出内容，
系统也会强制擦除 ASCII 编码的特殊字符。

## 七、多轮媒体累积与截断策略（丢旧保新）

**背景**：Robin 协议的会话状态载体此前未接通（`Lfzww/Lapuy`）——
★ 2026-10-16 已澄清真相：**会话 ID 由服务端下发，客户端无法指定**。
若哪里组合起来发出一个请求，服务端都会新建一个会话并保留在账号下
（实测：不带历史的相邻两次查询拿到的是**不同的** conversationId）。

MVP 把历史**拼接成单轮**发送——历史里的图片/音频/视频会全部累积进同一请求。
长对话媒体越攒越多，必须防撞数量上限。

**实测上限**（2026-10-16，`out/_media-count-probe.mjs` / `_media-count-probe2.mjs`，真实通道）：

| 维度 | 结果 |
|---|---|
| 附件数量 | N=1/2/3/4/5/8/10/15/20/30 **全部 200**，模型逐张数对、逐张描述、零丢弃 |
| 总体积 | 20 × 50KB ≈ 1MB 同样全过（附件按 blobId 引用，请求体不随媒体大小增长） |
| 耗时 | N=30 全程 66s（Vercel 300s 限额内；每附件约 +1.5~2.5s） |

**策略**（`geminiToRobin` → `truncateAttachments`，cap 默认 **30**，`ROBIN_MAX_ATTACHMENTS` 可调，0=不限）：

1. 附件按 `contents` 时间序收集（旧 → 新）；
2. 超上限时**丢最旧、保最新**——末尾媒体对应用户当前轮次，语义上最重要；
3. 丢弃**绝不静默**：提示词注入 `[媒体附件截断提示]`（总数/上限/保留与丢弃的类型统计），
   明确告知模型早期媒体不可见、禁猜测引用——与工具仿真同一原则（宁可是响亮失败，
   不要幻觉）；
4. 截断发生在上传**之前**——被丢的附件不会浪费 push.clients6 上传时间。

**已知边界**：
- `inlineData` 每轮都会重新上传全部历史媒体（SDK 的 `files.upload` 路径未接），
  长会话建议改用 File API 上传后以 `fileData` 引用（fileUri 形式），
  避免重复上传拖慢请求。
- ⚠️ **音频处理受账号级配额限制**：高频压测后会返回「处理额度已满，需在
  N 小时后重试」。这不是代码缺陷，需等待配额重置或换账号。

## 八、会话隔离（DeleteConversation）与「串扰」真相

**背景**：代理多路复用同一 Google 账号，用户担心 Requests 之间互相串扰。
这一轮把问题彻底测量清楚了（`out/_conv-isolation-verify.mjs`、`out/_final-verify.mjs`、
`out/_memory-probe.mjs`，全部真实通道）：

| 结论 | 证据 |
|---|---|
| **每次请求都会开新会话**（不续旧会话） | 相邻请求拿到不同 conversationId（`c_885f…`/`c_e896…`；隔离组亦然） |
| **不存在账号级长期记忆** | 用 Gemini 记忆句式写入「我的名字是测试甲一郎」，另一**进程**追问 →「我不知道您的名字」 |
| **带历史的请求不会追溯到 N 轮之前的内容** | `_final-verify` 四组：多轮/隔离/图片/流式全绿 |

⇒ 串扰风险的真实来源是「客户端自己把历史拼进来」，而非服务端留存；
且 Gemini App 那类「个性化记忆」**在本通道未观测到生效**。

**仍然默认开启会话隔离**，但理由从「防串扰」换成 **隐私与清洁**：处理完即调
`RobinService/DeleteConversation` 删掉该次请求在服务端产生的会话，
避免成百上千对话堆积在共享账号里（在 Gemini App 里是可见的）。
开关 `ROBIN_ISOLATE_CONVERSATIONS`（默认 `1`，设 `0` 可关以省那 ~1.5s）。

**机制**（`lib/robin.js` → `deleteConversation`，`lib/pq.js` → `buildDeleteConversationRequest`）：

```
Lgaaz { #1 STRING conversationId, #2 Lgauy }   ← protoreach 反推
POST /assistant.mobile.robin.RobinService/DeleteConversation   （实测 grpc-status=0）
```

**★ 踩过的坑**：同一 HTTP/2 session 上的 unary RPC，服务端发完 trailers 后
**不会立刻触发本端 `end`/`close`** —— 必须「收到 trailers 即判定完成」，
否则每次调用都白等到超时上限（实测修复前每次 10~15s，修复后 1.0~1.7s）。

### 8.1 跨请求串扰对照实验

**背景**：Robin 服务端按【账号】维护会话。实测：不带历史直接问上一轮的暗号，
模型能把答案复述出来（2026-10-16 早些时候的泄漏观测）。
本代理多路复用同一 Google 账号 ⇒ 不同调用方的上下文会互相串扰，
且**对话内容会长期留存在该 Google 账号里**（合规/隐私风险）。

**✦ 重要澄清（2026-10-16 实证推翻旧认知）**：会话 ID **由服务端下发，客户端无法指定**。
带/不带历史的相邻查询拿到的是**不同的** conversationId（`c_885f…` / `c_e896…`）——
也就是说服务端为每个不带 ID 的 ProcessQuery **新建会话**，并不是"永远续同一个"。
所谓"串扰"更可能来自账号层的长期记忆/个性化（见下节），`DeleteConversation` 消除的是
**服务端留存**与会话层延续这条路。

**机制**（`lib/robin.js` → `deleteConversation`，`lib/pq.js` → `buildDeleteConversationRequest`）：

```
Lgaaz { #1 STRING conversationId, #2 Lgauy }   ← protoreach 反推，字段号有字节码证据
   ↓ POST /assistant.mobile.robin.RobinService/DeleteConversation
```

每次请求拿到应答后，用它自己返回的 `conversationId` 调用删除 RPC（`grpc=0` 实测确认），
下一次请求自然开启全新会话。开关：`ROBIN_ISOLATE_CONVERSATIONS`（默认 **1=开**，设 `0` 关闭）。

**收益对照**（真实通道同流程双跑，`out/_conv-isolation-verify.mjs` + `out/_final-verify.mjs`）：

| 场景 | 隔离关 | 隔离开 |
|---|---|---|
| 存暗号 → 不带历史追问 | ❌ 说出暗号 | 🛡️ 明显记不清（各种变换写法都说不出完整串） |
| 客户端自带历史的多轮 | ✅ | ✅ 不受影响（历史随请求上行） |
| 图片识别 | ✅ | ✅ |
| 流式 SSE | ✅ | ✅ |
| 单次延迟代价 | — | **+1.0~1.7s**（修复前每次白等 10s，见下） |

**性能陷阱（修过的坑）**：同一 HTTP/2 session 上发的 unary RPC，服务端发完 trailers
后**不会立刻触发本端 `end`/`close` 事件**。必须在 trailers 到达时即判定完成，
否则每次调用都白等到超时上限（实测修复前 10~15s，修复后 1.0~1.7s）。

## 九、★ 空回复的根因与修复（2026-10-20）

> **一句话**：长期被当成「上游静默拒答 / 账号疲惫期」的空回复，
> **有一大半是反代自己造的** —— 本端用同一个 10s 静默定时器去判断
> 「上游答完了没」，于是上游只是**慢**的时候被我们掐断流。
> 官方 App 是长连接客户端（会一直等），所以它的空回复率远低于我们。

### 9.1 证据链

| 证据 | 内容 |
|---|---|
| 单变量对照 | 同载荷、同账号，**只改「首正文前宽限」**：统一 1.5s ⇒ **4/4 空回复**；60s ⇒ **0/4** |
| 首正文延迟实测 | 轻请求 0.3~5.4s；**生产载荷（6 视频+2 图+60KB 文本+Argon High）10.8~30.1s**（最大帧间隙 26.4s）⇒ 旧 10s 必杀 |
| 帧序 | 空回复的帧序 `ext1000(ACK) → ext1003(3B 空) → ext1014(会话id)×2` 与健康响应**前四帧同构** ⇒ 旧分流逻辑把它误报成「文本落在未解明的数据包里」 |
| EOS 信号 | 健康响应**最后一帧**恒为 `ext1003{Lgcvc.#2 空}` = 上游的「答完了」标记（实测 8/8 一致）——此前完全没被使用 |

详见 `docs/stage2-robin-protocol.md` §5.18。

### 9.2 修复（三件套 + 两个附带 bug）

| # | 改动 | 位置 |
|---|---|---|
| 1 | **等待上限 300s**，结束只由上游终止 / 真空 / 总时限驱动（我方静默定时器**不再**把「上游慢」掐成空回复） | `lib/robin.js`（`idleLimitFor` / `armIdle`）+ `lib/config.js` |
| 2 | 认**两个确定性结束信号**：正文完成标记 `Lgapu.#19 == 2`、EOS 标记 `ext1003{Lgcvc.#2 空}` ⇒ 收尾不再靠超时猜 | `lib/pq.js` + `lib/robin.js` |
| 3 | 幂等去重的「等在途」时长同步抬到 300s（否则调用方重发时会重复打上游 ⇒ 重复计费） | `lib/dedup.js` |
| 4 | `dedup` 不再把**错误结果**写进缓存（曾导致一次抖动被重放 90 秒） | `lib/dedup.js` |
| 5 | 取令牌遇**瞬时网络错误**重试一次（403 BadAuthentication 不重试） | `lib/auth.js` |

### 9.2.1 ★ 现行结束条件（先到先算）

| # | 条件 | 结果 |
|---|---|---|
| ① | 正文完成标记 `Lgapu.#19 == 2` | 立即收尾（确定性；实测 20/20 命中） |
| ② | EOS 标记 `ext1003{Lgcvc.#2 空}` | 立即收尾（确定性） |
| ③ | 上游会话终止（END_STREAM / trailers / close） | 收尾（无正文 ⇒ 真正的空回复 → 触发 empty-retry） |
| ④ | 上游真空（一个字节都没回来）持续 10s | 失败（真正的空回复）→ 触发 empty-retry |
| ⑤ | 总时限 300s 到 | 收尾（判为超时） |
| ⑥ | 正文已开始但 ①②③ 都没来 | 静默 30s 后收尾（兜底） |

> `Lgapu.#19 == 2` 是 2026-10-20 新发现的第二个确定性信号：逆向文档早记了它
> （「分片状态，2 = 完成」），但此前从未被使用。统计全部 810 个正文帧：
> **每帧恒为单分片**；首个 `#19=2` 的帧即含全部文本（139/141），其后 0 例再增长；
> 且它覆盖了 EOS 缺失的那 5 例。

### 9.2.2 ★ 顺带发现并处理的「瞬时可重试」上游错误

上游会**明确拒答**两类瞬时错误（**推理没跑 ⇒ 零额度消耗**，重试几乎无代价，
实测重试即恢复）：

| 错误 | 实测频率 | 表现 |
|---|---|---|
| `BardStatusException: This service is not yet available in your location ZZ.`（grpc=9） | ~1/20~40 请求 | 上游按**出口 IP 的地理判定**偶发失败（ZZ = 未能判定所在区域） |
| `BardStatusException: Agency connection failed: … throttled: Service is overloaded (memory-protection)`（grpc=13） | 偶发 | 上游 agent 调度器过载（内存保护） |

⇒ 归入 `transient` 形态，由同一套「同模型同档位」重试覆盖，healthz 单独计数
（`degradeGuard.transients`）。判定刻意收窄：参数类业务错误（如
`Unsupported file source.`）**不会**被误判成可重试。

### 9.3 实测效果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 空回复率（轻请求，HTTP 入口 n=25 / SSE n=20） | ~5~8% | **0%** |
| 空回复率（重载荷，lib 入口 n=10） | 可稳定复现（EXP3 100%） | **0%** |
| flash-lite 纯文本中位延迟 | 19.3s | **3.2~3.4s（≈6× 提速）** |
| 结束方式 | 静默超时猜 | **完成标记（实测 20/20）** |
| **慢上游**（实测 127s / 191s / 275s 才吐字） | 全部被掐成**空回复** | **全部正常返回内容** |

### 9.4 配置项

| 变量 | 默认 | 含义 |
|---|---|---|
| `ROBIN_TIMEOUT_MS` | `300000` | 总时限（≤300s） |
| `ROBIN_IDLE_MS` | `10000` | 上游真空（一个字节都没回）的快速失败宽限 |
| `ROBIN_IDLE_AFTER_TEXT_MS` | `30000` | 正文已开始后的兜底静默宽限（正常路径用不到） |
| `ROBIN_IDLE_FIRST_MS` | `300000` | 「首正文前」的等待上限（默认 = 总时限）；**调小可恢复「卡死即重试」的旧行为** |
| `ROBIN_EMPTY_RETRY_BUDGET_MS` | `100000` | 空重试总预算（受调用方超时约束） |
| `ROBIN_EMPTY_RETRY_RESERVE_MS` | `60000` | 每次重试前预留 |
| `ROBIN_DEDUP_WAIT_MS` | `300000` | 等同键在途请求的时长（须 ≥ 总时限，否则重发会重复计费） |

### 9.5 观测

- `GET /healthz → degradeGuard.lastEmpty`：含 `diagnosis`（A/A2/B/C/D/E）、`diagnosisText`、
  `idleCutBeforeText`、`sawText`、`frames`、`extCounts`、`endedBy`。
- 日志：`[guard] ⚠️ 上游返回「空响应」… [诊断] … idleCut=yes ⇒ 【A2 空闲截断】…`
  —— **A2 = 我方超时截断（上游只是慢）**，D = 真·盲区扩展（需扩解析器）。
- `[empty-retry] ⚠️ 空响应（第 1/2 次尝试，累计 26567ms）→ 自动重试` /
  `✓ 第 2 次尝试成功…累计 31775ms` —— 上游接单后卡死时，重试常能恢复。

---

## 十、路线图

- [x] Node 选型 + Vercel 骨架 + wire 编解码
- [x] **协议层 `pq.js`（请求装配 + 响应解析，字段号全部有字节码证据）**
- [x] **gRPC 客户端 `robin.js`（h2 / 单例 / idle 收尾 / trailers 错误）**
- [x] **Gemini ⇄ Robin 翻译 + SSE + 错误映射**
- [x] **mock Robin + 端到端离线测试（28 单测 + 26 e2e 全绿）**
- [x] 联调探针 `scripts/probe.mjs`
- [x] **凭证链路完全逆向（GMS AANG）+ Frida 提取器 + `lib/auth.js` 凭证管理 + `/admin/token`**
- [x] **★ 网页登录方案：`tools/apksig.py`（解出 client_sig）+ `lib/gpsoauth.js` + `/login` 页面 + `/admin/gpsoauth`（端点实测通过）**
- [x] **端到端验证网页登录拿到的 `ya29.*` 打通 Robin**（2026-10-15 实证）
- [x] **File API 分片上传路由（`/upload/v1beta/files` ↔ push.clients6，256KB 粒度约束实证）**
- [x] **音视频附件字段对齐**（图片/音频/视频三类媒体端到端实证，见 §一）
- [x] **ToS 门禁解除 + 账号级会话保持实证**
- [x] **★ function calling 兼容层**（prompt 仿真，真实通道五场景全过，见 §六）
- [x] **★ 空回复根因定案与修复**（idle 超时自造空回复 → 三态空闲宽限 + EOS 收尾，见 §九）
- [ ] 多用户会话隔离评估（服务端按账号保持会话，见协议文档 §6）
