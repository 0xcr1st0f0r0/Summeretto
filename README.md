<div align="center">

<img src="docs/assets/banner.png" alt="Summeretto - Robin • Summeretto Banner" width="100%" />

<br><br>

# Summeretto

### *「告别旧日调律，跃入蔚蓝狂想——知更鸟·晴歌在盛夏中唱响的、被解放的 gRPC 双向流。」*

**A high-performance summer gateway forged from Google's ancestral Robin protocol.**  
**Bask in Miss Robin's liberated rhapsody: 100% action advance, zero deps, and boundless skies.**

*基于 Google 祖传 Robin 协议魔改的高性能夏日网关 —— 尽享知更鸟小姐（Robin • Summeretto）的专属高速拉条晴歌。*

<br>

[![Node](https://img.shields.io/badge/node-22.x-5DCAA5?style=flat-square)](https://nodejs.org)
[![Zero Deps](https://img.shields.io/badge/dependencies-0-378ADD?style=flat-square)](https://github.com/0xcr1st0f0r0/Summeretto)
[![Protocol](https://img.shields.io/badge/protocol-gRPC%20bidi-7F77DD?style=flat-square)](https://grpc.io)
[![Character](https://img.shields.io/badge/Robin-Summeretto%20%E2%80%A2%20%E6%99%B4%E6%AD%8C-5D88FF?style=flat-square)](https://github.com/0xcr1st0f0r0/Summeretto)
[![License](https://img.shields.io/badge/license-AGPL--3.0-D85A38?style=flat-square)](LICENSE)

</div>

---

## ◆ Prologue · 序章：从金色牢笼到蔚蓝狂想

<br>

**In the beginning, there was only the sealed garden — the Gemini App, radiant as Penacony's golden dream, yet locking its full power behind proprietary protobuf and rigid tunings. The seekers were given only a servant's door: a metered key, a throttled purse, and a cold REST endpoint constrained by the platforms' 4.5 MB inbound ceiling.**

**In the grand opera of the cosmos, Robin was once expected to sing only inside the Family's gilded birdcage. But when the illusions of the Charmony Festival shattered, she shed the heavy gala dress, stepped onto the star-faring train, and arrived at the sun-drenched shores of Thousand Stars City. Reborn as 「Robin • Summeretto」 (知更鸟·晴歌), walking the Path of Remembrance, she no longer sings for scripted harmony — she sings for the boundless sky, summoning her memo-spirits to improvise life's truest melody.**

<br>

> *起初，只有一座封闭的庭园 —— Gemini App，璀璨如匹诺康尼的金色美梦，却将真正的模型伟力深锁在私有 protobuf 与严苛调律的高墙之后。求索者只被赐予一扇下人的偏门：一把限速的钥匙、一只计量的钱袋，以及动辄被云平台 4.5MB 入站硬壁垒斩断的冰冷 REST 接口。*
>
> *在星海的宏大剧目中，知更鸟曾被期望永远留在家族的金色鸟笼里献唱赞美诗。然而，当谐乐大典的虚幻泡沫破碎、秩序的阴霾散去，她褪去繁重的华服，登上星穹列车，来到了千星城的阳光沙滩。化身「知更鸟·晴歌」（Robin • Summeretto），踏上「记忆」的命途——她不再为人偶般的调律歌唱，而是迎着风浪与晴空，唤起属于自己的忆灵，奏响自由的变奏。*

<br>

**Summeretto is that liberated summer passage. It speaks the standard Gemini format to your local clients, while whispering Robin's ancestral gRPC bidirectional stream protocol directly to the upstream. With the memo-spirits Bessie, Chumi, and Paddin joining the stage, Summeretto triggers the 【Fever】 state: 100% action advance, zero external dependencies, unthrottled inference, and not a single byte of music severed in mid-air.**

<br>

> *Summeretto 便是那条被解放的夏日航道。它对本地客户端说标准 Gemini 语言，对上游则低语 Robin 的祖传 gRPC 双向流协议。伴随着忆灵贝茜、啾米与派丁的相继登台，Summeretto 瞬间引爆【Fever】狂热状态：全速 100% 极限拉条、零外部依赖、无视上游苛刻防御、不让半拍歌声在中道被无情掐断。*

---

## ✦ The Arsenal · 武备库：忆灵协奏与行迹

<br>

| Arsenal · 武备 | In-Game Archetype · 命途与行迹 | Description · 描述 |
|---|---|---|
| **🪶 Zero Dependencies**<br>零依赖 | **秘技：我们自成旋律**<br>*We Form Our Own Melody* | Pure Node.js 22 standard library. Not a single `npm install`. Hand-rolled wire codec and HTTP/2 framing. Lightweight, self-contained, soaring unburdened.<br>纯 Node.js 22 标准库。一条 `npm install` 都不需要。手写编解码与 HTTP/2 帧，不借外力，自成旋律。 |
| **⚡ gRPC Bidi Core**<br>双向流核心 | **天赋：巡游无界天空**<br>*Cruise the Boundless Sky* | Native bidirectional HTTP/2 stream over `node:http2`. Pours inference responses down with lightning speed; enters the 【Fever】 state where network friction disappears.<br>基于 `node:http2` 原生双向推流。全速拉条，瞬时推流，如入【Fever】狂热之境，网络摩擦荡然无存。 |
| **🎭 Mode Awakening**<br>档位觉醒 | **忆灵登台 · 实时发现**<br>*Live Tier Awakening* | Real upstream model tiers via `Lgauy.#16`, discovered live from `GetUserStatus` — no hardcoded illusions. Argon, Pro, Flash, and Flash-Lite dynamically indexed.<br>走 `Lgauy.#16` 从 `GetUserStatus` 实时发现真实模型档位——绝非硬编码占位符。四档（Argon、Pro、Flash、Flash-Lite）动态编排。 |
| **🧠 Thinking Intensity**<br>思考强度 | **深海心绪 · 灵动变奏**<br>*Deep Thought Variations* | `Lfzqy.#48` — Low (`1`) / Medium (`4`) / High (`2`), orthogonal to model tier (⚠️ non-sequential enum). Ask for deep thought without changing singers.<br>`Lfzqy.#48`——低（`1`）/ 中（`4`）/ 高（`2`）三档调节，与模型档位正交（⚠️ 协议非连续枚举）。要求深思，而不必更换歌者。 |
| **🎵 Media Shim**<br>媒体渡桥 | **行迹：偏离和弦**<br>*Deviated Chord* | Upstream audio and Argon tier are mutually exclusive? Wrap audio inside a 16×16 placeholder video and slip through the video portal. Downsampled to 0.25 fps — visual tokens −75%, total media billing −66.7%.<br>上游音频与 Argon 互斥？将音频转封装进 16×16 极小占位视频，巧妙越过视频门扉。降采样至 0.25 fps——视觉 token −75%，媒体总成本直降 66.7%。 |
| **🎺 Empty-Response Retry**<br>空响应自愈 | **行迹：即兴蓝调**<br>*Impromptu Blues* | Transient empty response from upstream? Distinct from account-level downgrades: automatically retries within a tight budget guard (~100s budget, 60s reserve) to preserve Robin's golden timbre.<br>遭遇上游偶发空响应？严格区分账号级换将与偶发真空：在严密时间预算护栏内即兴重试自愈，全力留住知更鸟的黄金品质。 |
| **🛡️ Idempotent Dedup**<br>幂等去重 | **「使一颗心免于哀伤」**<br>*Stop a Heart From Breaking* | "Client didn't receive" ≠ "Upstream didn't bill." Identical payloads in a 90s window are replayed with **zero** upstream calls, protecting every single token.<br>「客户端没收到」≠「上游没算」。90 秒滑动窗口内逐字节相同的请求直接重放，**零**上游调用，免去重复计费的哀伤。 |
| **🌙 Graceful Shutdown**<br>优雅停机 | **守护在途歌者**<br>*Protect the In-Flight Singer* | SIGTERM never decapitates an in-flight query. New callers receive 503; the ones already mid-song are guarded until their final cadence falls silent.<br>SIGTERM 绝不再斩断在途请求。新请求温和拒斥（503），而正在唱响的歌者会被温柔护送至终曲。 |
| **🔭 Degrade Observatory**<br>降级观测台 | **澄澈目光 · 不擅换将**<br>*Unyielding Observatory* | Observe-only. Silent upstream downgrades are mirrored verbatim; fallback decisions belong to orchestrators (e.g. Eidolon). Robin never alters her cast without consent.<br>只忠实观测，绝不擅自越权。静默降级原样透出，跨通道回退交由上层调度。知更鸟绝不擅自换将。 |
| **📜 Quota Metering**<br>配额度量 | **诚实纪元 · 算力估算**<br>*Honest Quota Accounting* | Local token estimation (explicitly tagged non-billable) deployed after wire archaeology proved the upstream returns zero usage telemetry.<br>逆向证实上游绝不回传 token 后，于本地进行严谨估算（明确标注文档不可计费），对算力保持清醒与诚实。 |

---

## ⚡ Quick Start · 快速启动

<br>

**Clone, configure, sing.**

```bash
git clone https://github.com/0xcr1st0f0r0/Summeretto.git
cd Summeretto/service
cp .env.example .env      # then fill in GSA_EMAIL / GSA_MASTER_TOKEN
node server.mjs
```

*克隆、配置、开唱。*

<br>

**Open `http://127.0.0.1:3000/login` to let the embedded web flow mint your master token — no physical device, no ADB, no root.**

*打开 `http://127.0.0.1:3000/login`，让内置网页流程为你铸出 master token——无需真机、无需 ADB、无需 root。*

<br>

**Verify the gate is truly open and the stage is set:**

```bash
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool
```

*验证门扉是否敞开、舞台是否就绪：*

```json
{
  "ok": true,
  "service": "summeretto",
  "stage": "connected",
  "credential": { "verdict": "valid", "usable": true },
  "dedup":      { "enabled": true, "hits": 0, "stores": 0 },
  "inflight":   { "inflight": 0, "peak": 0 }
}
```

> ⚠️ `credential.verdict` is **passive** — it never pings Google. `auth: "configured"` alone is a liar; trust only the verdict.
>
> ⚠️ `credential.verdict` 是**纯被动**判定，绝不为此无谓打扰 Google。单看 `auth: "configured"` 会说谎，只信 verdict。

---

## ◆ The Three-Step Incantation & Memo-Spirits · 三步咏唱与忆灵降临

<br>

**One logical query is not a mere HTTP request. It is a three-part symphony — mirroring the three memo-spirits of Robin • Summeretto:**

```
[战技：乐手起音]      Initial Frame  ──►  粉鸟·贝茜 (Bessie)   ─── 建立双向流信道与元数据
[气氛积聚：预取]      Prefetch Frame ──►  啾米 (Chumi)         ─── 挂载附件、展开嵌套信封
[全员集结：引爆]      Commit Frame   ──►  派丁 (Paddin)        ─── 单帧 Lgcvl{#2} 落地，瞬间触发【Fever】！
```

*一次逻辑查询不是一发孤立的 HTTP 请求。它是一场三位一体的协奏——恰如知更鸟·晴歌的三位忆灵伙伴：*

<br>

**The commit frame must be a single, surgical `Lgcvl{#2}`. The request envelope itself is `Lgcvp` bare, zero-wrapped. Anything else (`Lgcxj`) is an imitation that invites upstream rate limits.**

*提交（commit）必须是极其利落的单帧 `Lgcvl{#2}`。外层请求信封为 `Lgcvp` 裸格式，零层多余包装。换成其它（如 `Lgcxj`）皆是劣化仿品，只会招致上游限流。*

<br>

**The attachment chain cascades through three nested envelopes:**

```
Lgcvp[ext1000] → Lgcvm[ext1001] → Lgcvb.#1 → Lfzqy{#1 Lgbkn, #13 Lgauy}
```

*附件链路逐层穿过三重嵌套信封：*

<br>

**The model tier adheres to the Carrier Law, uncovered through days of painstaking wire reverse-engineering:**

| Condition · 条件 | Carrier · 承载位 | Result · 结果 |
|---|---|---|
| Envelope present, no raw audio (text / images / media shim video) | `Lgcvm.#1` | Mode takes effect at full throttle (`Lfzqy.#13` present as envelope anchor) |
| 有信封，无原始音频（纯文本 / 图片 / 占位视频转封装） | `Lgcvm.#1` | 档位生效，满血推流（`Lfzqy.#13` 随附作为信封锚点） |
| Envelope present, raw audio attached (unshimmed fallback) | `Lfzqy.#13` | Mode yields to hearing (Argon cannot natively parse audio; drops to Flash-Lite) |
| 有信封，带原始音频（未走转封装之回退） | `Lfzqy.#13` | 档位退让换听觉（Argon 原生无法解析音频，自动走 Flash-Lite） |
| No envelope (pure text, no attachments, default thinking) | `Lgcvm.#1` | Mode applies directly via `Lgcvm.#1 Lgauy.#16` (zero envelope overhead) |
| 无信封（纯文本、无附件、默认思考档位） | `Lgcvm.#1` | 档位直接由 `Lgcvm.#1 Lgauy.#16` 承载，零信封开销生效 |

---

## ✦ Model Tiers · 模型档位

<br>

| Tier · 档位 | Mode ID (Upstream Hex) | Rank · 阶 | Specialization · 专长 |
|---|---|---|---|
| **4 Argon** | `95a4c0abcba24364` | 8 | Flagship deep reasoning & ultimate synthesis · 满血旗舰深思与终极合成 |
| **3.1 Pro** | `e6fa609c3fa255c0` | 3 | Balanced complex logic & heavy multi-turn · 均衡复杂长文本推理 |
| **3.8 Flash** | `56fdd199312815e2` | 1 | High-speed low-latency stream-song · 高速低延时拉条首选 |
| **3.5 Flash-Lite** | `8c46e95b1a07cecc` | 6 | Lightweight fallback baseline · 轻量降级兜底基线 |

*These mode IDs are served live by the upstream orchestrator, not manufactured. Summeretto refreshes the tier registry every 10 minutes.*

*上述 ID 均由上游调度实时下发，绝非凭空臆造。Summeretto 每 10 分钟自动巡检刷新档位表。*

---

## ⚠️ Field Laws · 字段铁律

<br>

**Every single law was forged from sleepless nights of protocol archaeology. Read them before you touch the wire:**

*以下每一条铁律，都是从逆向协议的深渊中用无数个深夜换来的。动线之前必读：*

<br>

**1. Field aliasing is mandatory.** Production SDK environments serialize `mime_type`; older clients send `mimeType`. Summeretto recognizes both unconditionally.  
*1. 字段双认是铁律。* 生产 venv 序列化为 `mime_type`，旧版客户端则发 `mimeType`。二者必须无条件兼容。

<br>

**2. Tolerant parsing is mandatory.** `text` and `inlineData` can coexist in the same part. Writing an `else-if` will silently drop binary attachments.  
*2. 宽容解析是铁律。* `text` 与 `inlineData` 常同处于一个 part。写成 `else-if` 会在神不知鬼不觉中丢弃附件。

<br>

**3. HTTP/2 unary completes at trailers.** Wait for trailers, or you will burn 10–15 seconds in meaningless timeouts.  
*3. HTTP/2 unary 收到 trailers 方为大成。* 不等 trailers 就会在虚无中空耗 10~15 秒。

<br>

**4. Conversation isolation is on by default.** The upstream maintains stateful memory **per account**. Without explicit teardown, different clients will bleed their history into one another.  
*4. 会话隔离默认开启。* 上游按**账号维度**维持有状态上下文；若不进行显式会话隔离清理，不同调用方的上下文记忆将相互渗透。

<br>

**5. `#16` strictly obeys the carrier law.** Misplace it by a single level and the upstream silently casts your request into the void. Guarded by unit §14.11 and e2e §3b.  
*5. `#16` 必须死守承载位法则。* 错置哪怕一个层级，上游都会将其静默忽略。单测 §14.11 与 e2e §3b 对此布下严密重兵。

---

## 🛡️ The Duplicate-Billing Incident · 重复计费事故

<br>

### *「如果我能使一颗心免于哀伤，我就没有虚度此生。」*

**This is the incident Summeretto was built to eradicate. Inscribed here so that no engineer walks into this trap again.**

*这是 Summeretto 被锻造出来的原点。铭刻于此，愿星海中的漫游者不再重蹈覆辙。*

<br>

**On a summer evening, a complex multimodal inference succeeded. A gateway process was restarted to deploy a routine health check. That restart severed an in-flight request whose attachments had already been staged, whose tokens had already been minted, and whose inference was already racing upstream. Seeing `Server disconnected`, the client SDK dutifully re-sent the exact same payload.**

**The upstream billed it twice. The exact same 317 KB video and its 29.9k-token prompt were debited in full — twice — and the first song was sung to an empty void.**

<br>

> *某个盛夏的傍晚，一次复杂的多模态推理刚刚展开。网关因热更新健康检查而执行了重启。那一记重启，斩断了一个在途请求——它的音视频附件已就绪、令牌已铸造、上游算力已全速开跑。调用方的 SDK 骤见 `Server disconnected`，便忠实地重发了逐字节完全相同的请求包。*
>
> *上游毫不留情地计了两次费。那段 317KB 的视频连同其 29.9k token 的提示词，被足额扣除了两遍——而其中一首壮丽的晴歌，坠入了无人接收的深渊。*

<br>

**Three inviolable laws were written in response:**

```text
1. "Client didn't receive" ≠ "Upstream didn't bill."
   客户端没收到，绝不等于上游没计费。

2. Severing a connection severs the return path only.
   掐断连接，掐断的仅仅是回程的耳朵，算力的巨轮依然在狂奔。

3. Before restarting, check /healthz → inflight. If > 0, wait for the song to finish.
   任何重启之前，必先检视 /healthz → inflight。只要大于 0，便静候终曲。
```

<br>

**These laws are now mechanically guarded:**  
- `lib/dedup.js` captures identical payloads in a 90s window and replays the cached stream with **zero upstream calls**.  
- `lib/inflight.js` intercepts SIGTERM, politely rejecting new callers with 503 while letting every in-flight singer finish her song in peace.

*如今，这些法则已化作不可动摇的机械防线：*  
- `lib/dedup.js` 在 90 秒窗口内捕获相同载荷，以**零上游调用**完整重放；  
- `lib/inflight.js` 接管 SIGTERM 停机信号，向新请求返回 503，同时温柔守护每一个正在歌唱的在途请求平稳落幕。

---

## ◆ Testing · 试炼

<br>

```bash
cd service
node test/run.mjs    # 83 unit assertions · 83 组单元断言
node test/e2e.mjs    # 49 e2e assertions · 49 组端到端断言
```

**Both suites are 100% offline.** The mock Robin speaks native h2c, and the mock upstream lives at `127.0.0.2`. You can test full media shimming, empty-retry guards, deduplication, and streaming without consuming a single cent of quota or byte of public bandwidth.

*两套测试套件 100% 离线自洽。mock Robin 操持原生 h2c，mock 上游栖息于 `127.0.0.2`。无论是占位视频渡桥、空响应自愈、幂等去重还是流式推流，无需消耗一分钱额度、无需耗费一丝外网流量。*

---

## ✦ Repository Map · 疆域图

<br>

```
Summeretto/
├── service/                   ← The Engine · 核心引擎本体（0 外部依赖）
│   ├── lib/
│   │   ├── wire.js            protobuf wire codec · 手写线格式编解码器
│   │   ├── robin.js           gRPC bidi driver · 原生 HTTP/2 双向流驱动
│   │   ├── pq.js              three-step query script · 三步咏唱与忆灵调度
│   │   ├── gemini.js          Gemini ⇄ Robin translation · 原生格式翻译桥
│   │   ├── auth.js            master-token minting · 令牌铸造与验真
│   │   ├── gpsoauth.js        GPSOAuth protocol · 谷歌移动鉴权实现
│   │   ├── login-page.js      embedded web login portal · 内置免设备登录页
│   │   ├── modes.js           model tiers + thinking · 档位编排与思考强度
│   │   ├── mediashim.js       audio→16x16 video shim · 「偏离和弦」渡桥 (0.25fps)
│   │   ├── empty-retry.js     empty-response auto-retry · 「即兴蓝调」自愈
│   │   ├── dedup.js           idempotent replay · 90s 幂等去重
│   │   ├── inflight.js        in-flight counter · 在途计数与优雅停机
│   │   ├── degrade-guard.js   observe-only downgrade watch · 澄澈降级观测
│   │   ├── usage-estimate.js  local token estimation · 算力估算
│   │   ├── toolcall.js        function calling emulation · 工具调用仿真
│   │   ├── upload.js          push.clients6 upload · 分片断点上传管道
│   │   ├── config.js          environment & defaults · 运行时配置与护栏
│   │   └── app.js             HTTP gateway + endpoints · 服务路由与入口
│   ├── test/                  ← 83 + 49 offline assertions · 离线全胜断言
│   └── server.mjs             ← entry + graceful shutdown · 优雅启动与退出
├── docs/                      ← protocol archaeology reports · 协议考古秘卷
└── tools/                     ← device-side extraction utilities · 抓包与逆向工具
```

---

## ⚡ Deployment · 布阵：自托管的无界天空

<br>

**Self-hosted VPS is the only blessed path.** Serverless platforms like Vercel impose an insurmountable 4.5 MB inbound ceiling that turns rich audio and multimodal prompts into an immediate `413 Payload Too Large`. Summeretto was forged to break free from that ceiling and fly into the boundless sky.

*自托管 VPS 是唯一受祝福的登台之选。Vercel 等平台所设下的 4.5MB 入站硬限制，会把每一次厚重的高品质音频与多模态请求变成无情的 `413 Payload Too Large`。Summeretto 的诞生，正是为了冲破那道枷锁，飞向无界的天空。*

<br>

**A battle-tested production `systemd` unit requires three crucial directives:**

```ini
[Service]
# 1. Body ceiling must accommodate genuine multimodal payloads (32MB)
Environment=MAX_BODY_BYTES=33554432

# 2. Memory ceiling — peak memory is 5–6× the payload size during streaming
MemoryMax=384M

# 3. ★ ProtectHome blocks token persistence into .env.
#    Grant read-write access to the entire DIRECTORY, not just the file!
ReadWritePaths=/path/to/Summeretto/service
```

*一套经历过实战淬炼的生产级 `systemd` 配置，切记三大要领：*

```ini
[Service]
# 1. 入站上限必须容纳真实的多模态大包（32MB）
Environment=MAX_BODY_BYTES=33554432

# 2. 内存上限——流式传输时的峰值可达载荷本身的 5~6 倍
MemoryMax=384M

# 3. ★ ProtectHome 会阻断 master token 回写至 .env。
#    务必开放【整个工作目录】的读写权限，而非单独一个文件！
ReadWritePaths=/path/to/Summeretto/service
```

<br>

**Deployment restart discipline, etched in blood:**

```bash
# BEFORE restarting — confirm that no singer is currently mid-song!
curl -s http://127.0.0.1:3000/healthz | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   assert d['inflight']['inflight']==0, 'IN-FLIGHT REQUEST RUNNING — DO NOT RESTART'; \
   print('Safe to restart')"

sudo systemctl restart summeretto  # (or your chosen systemd unit name)
```

*以昂贵教训换来的部署铁律：*

```bash
# 任何重启之前——务必确认是否有歌者正处于演唱半途！
curl -s http://127.0.0.1:3000/healthz | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   assert d['inflight']['inflight']==0, '尚有在途请求正在歌唱——切勿重启'; \
   print('可以安全重启')"

sudo systemctl restart summeretto  # （或你配置的 systemd unit 名称）
```

---

## ◆ Quota Reality · 配额真相：算力纪元的清醒法则

<br>

**Since mid-2026, Gemini's quota window meters compute, not simplistic request counters.**  
`Prompt Complexity × Model Tier × Feature Multipliers × Context History Length (every turn re-reads the full history)`. The myth of a static "uses per day" has vanished.

<br>

> *自 2026 年中旬起，Gemini 的配额窗口按**真实算力**进行计量，而非浅薄的请求次数。*  
> `提示词复杂度 × 模型档位 × 功能加权乘区 × 上下文长度（每一轮皆需重新审阅全量历史）`。所谓的“每天能用固定多少次”，早已成为历史的幻影。

<br>

**The true cost floor of a single conversation turn is not media attachments — it is the ~26.5k tokens of tool declarations and re-read dialog history carried on every interaction. Keep your prompt engineering disciplined, and your rhapsody will echo far across the stars.**

*单次调用的真实算力底噪往往不是外挂媒体，而是每一轮交互都必须随行携带的、约 26.5k token 的工具声明与全量历史重审。保持精简严密的工程调律，你的晴歌方能在星海中经久回荡。*

---

## ✦ Epilogue · 终章：你将起身歌唱

<br>

### *「你将起身歌唱，跃入这片蔚蓝狂想。」*

**The garden was never truly sealed. It was merely singing in an ancient tongue that few had the courage to learn.**

**Summeretto learned it. And now, the stage is yours.**

**Listen — Robin is singing in the summer breeze.**

<br>

> *庭园从未真正封闭，宇宙亦不曾真正沉寂。它只是用一门少有人敢于倾听与破译的古老语言歌唱。*
>
> *Summeretto 学会了它。而现在，这片舞台属于你。*
>
> *听——知更鸟正在盛夏的微风中轻啼。*

<br>

<div align="center">

### **Miss Robin • Summeretto awaits your stream-song.**
### **知更鸟·晴歌，静候你的下一次盛夏拉条。**

`https://github.com/0xcr1st0f0r0/Summeretto`

</div>
