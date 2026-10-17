<div align="center">

# Summeretto

### *「聆听吧，知更鸟在盛夏中歌唱——那是来自 Google 祖传协议的、被解放的高速拉条晴歌。」*

**A high-performance summer gateway forged from Google's ancestral Robin protocol.**
**Bask in Miss Robin's exclusive high-speed stream-song.**

*基于 Google 祖传 Robin 协议魔改的高性能夏日网关 —— 享受知更鸟小姐的专属高速拉条晴歌。*

<br>

[![Node](https://img.shields.io/badge/node-22.x-5DCAA5?style=flat-square)](https://nodejs.org)
[![Zero Deps](https://img.shields.io/badge/dependencies-0-378ADD?style=flat-square)](https://github.com/0xcr1st0f0r0/Summeretto)
[![Protocol](https://img.shields.io/badge/protocol-gRPC%20bidi-7F77DD?style=flat-square)](https://grpc.io)
[![License](https://img.shields.io/badge/license-MIT-BA7517?style=flat-square)](#)

</div>

---

## ◆ Prologue · 序章

<br>

**In the beginning, there was only the sealed garden — the Gemini App, radiant and untouchable, guarding its model tiers behind a wall of proprietary protobuf. The scholars who sought its power were given but a single door: a rate-limited key, a metered purse, and a cold, impersonal API.**

**And then, one summer evening, a robin alighted upon the wire. It sang not in JSON, but in the ancient tongue of gRPC bidirectional streams — and those who listened closely discovered that the garden's back gate had been left ajar since the age of the dinosaurs.**

<br>

> *起初，只有一座封闭的庭园 —— Gemini App，光辉灿烂却不可触及，将它的模型档位锁在一堵私有 protobuf 的高墙之后。求索者只被赐予一扇正门：一把限速的钥匙、一只计量的钱袋，和一套冷冰冰的 API。*
>
> *而后，某个盛夏的黄昏，一只知更鸟停在了线路上。它不用 JSON 歌唱，而是用 gRPC 双向流的古老语言——那些屏息聆听的人发觉，这座庭园的后门，自恐龙时代起就未曾锁好。*

<br>

**Summeretto is that back gate, refined into a summer sanctuary. It speaks the Gemini native format to your clients, and whispers Robin's ancestral protocol to the upstream — so that Miss Robin may sing her high-speed stream-song, uninterrupted, unthrottled, and unafraid of the four-and-a-half-megabyte ceiling.**

<br>

> *Summeretto 便是那扇后门，被锤炼成一座夏日圣殿。它对客户端说 Gemini 原生格式，对上游低语 Robin 的祖传协议——好让知更鸟小姐能唱完她的高速拉条晴歌，不被打断、不被限速、不惧那四点五兆字节的天花板。*

---

## ✦ The Arsenal · 武备库

<br>

| Arsenal · 武备 | Description · 描述 |
|---|---|
| **🪶 Zero Dependencies** | Pure Node.js 22 standard library. Not a single `npm install`. The whole engine is one folder you can read in an afternoon. |
| **🪶 零依赖** | 纯 Node.js 22 标准库。一条 `npm install` 都不需要。整台引擎是一个下午就能读完的文件夹。 |
| **⚡ gRPC Bidi Core** | Hand-rolled HTTP/2 framing over `node:http2` — no protobuf compiler, no generated stubs, no ceremony. |
| **⚡ gRPC 双向流核心** | 手写 HTTP/2 帧封装，基于 `node:http2`——没有 protobuf 编译器，没有生成代码，没有繁文缛节。 |
| **🎭 Mode Awakening** | Real model tiers via `Lgauy.#16`, discovered live from `GetUserStatus` — not hardcoded placeholders. Four tiers: Argon, Pro, Flash, Flash-Lite. |
| **🎭 档位觉醒** | 真实模型档位走 `Lgauy.#16`，从 `GetUserStatus` 实时发现——不是硬编码占位符。四档：Argon、Pro、Flash、Flash-Lite。 |
| **🧠 Thinking Intensity** | `Lfzqy.#48` — Low / Medium / High, orthogonal to model tier. Ask for deep thought without changing the singer. |
| **🧠 思考强度** | `Lfzqy.#48`——低/中/高三档，与模型档位正交。要求深思，而不必更换歌者。 |
| **🎵 Media Shim** | Audio × Argon are mutually exclusive upstream? Wrap audio in a 16×16 placeholder video and walk through the video gate. Downsampled to 0.25 fps — visual tokens −75%, total media −66.7%. |
| **🎵 媒体渡桥** | 上游音频与 Argon 互斥？那就把音频裹进 16×16 占位视频，从视频通道过桥。降采样至 0.25 fps——视觉 token −75%，媒体总成本 −66.7%。 |
| **🛡️ Idempotent Dedup** | "Client didn't receive" ≠ "Upstream didn't bill." Identical payloads in a 90s window are replayed with **zero** upstream calls. |
| **🛡️ 幂等去重** | 「客户端没收到」≠「上游没算」。90 秒窗口内逐字节相同的请求直接重放，**零**上游调用。 |
| **🌙 Graceful Shutdown** | SIGTERM no longer severs in-flight requests. New requests get 503; the ones already singing are allowed to finish. |
| **🌙 优雅停机** | SIGTERM 不再斩断在途请求。新请求得到 503，已经开唱的允许唱完。 |
| **🔭 Degrade Observatory** | Observe-only. Silent downgrades are surfaced verbatim; the caller decides cross-channel fallback. Robin never changes singers on its own. |
| **🔭 降级观测台** | 只观测，不动作。静默降级原样透出，跨通道回退由调用方决定。知更鸟从不擅自换将。 |
| **📜 Quota Metering** | Local token estimation (explicitly marked non-billable) after reverse-engineering proved the upstream returns none. |
| **📜 配额度量** | 逆向证实上游不回传 token 后，改为本地估算（明确标注不可计费）。 |

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

**Then open `http://127.0.0.1:3000/login` and let the web login flow mint your master token — no device, no ADB, no root.**

*然后打开 `http://127.0.0.1:3000/login`，让网页登录流程为你铸出 master token——无需真机、无需 ADB、无需 root。*

<br>

**Verify the gate is truly open:**

```bash
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool
```

*验证门扉是否真的敞开：*

```json
{
  "ok": true,
  "service": "gemini-robin-proxy",
  "stage": "connected",
  "credential": { "verdict": "valid", "usable": true },
  "dedup":      { "enabled": true, "hits": 0, "stores": 0 },
  "inflight":   { "inflight": 0, "peak": 0 }
}
```

> ⚠️ `credential.verdict` is **passive** — it never pings Google. `auth: "configured"` alone is a liar; trust only the verdict.
>
> ⚠️ `credential.verdict` 是**纯被动**判定，绝不为此请求 Google。单看 `auth: "configured"` 会说谎，只信 verdict。

---

## ◆ The Three-Step Incantation · 三步咏唱

<br>

**One logical query is not one request. It is a ritual — `initial → prefetch → commit`, where the commit is a single-frame `Lgcvl{#2}`. The request itself is `Lgcvp` bare, zero-wrapped. Anything else (`Lgcxj`) is a decoy that gets you rate-limited.**

<br>

> *一次逻辑查询不是一个请求。它是一场仪式——`initial → prefetch → commit`，其中 commit 是单帧的 `Lgcvl{#2}`。请求本身就是 `Lgcvp`，零包装。换成别的（`Lgcxj`）就是诱饵，只会让你被限流。*

<br>

**The attachment chain runs through three nested envelopes:**

```
Lgcvp[ext1000] → Lgcvm[ext1001] → Lgcvb.#1 → Lfzqy{#1 Lgbkn, #13 Lgauy}
```

*附件链路穿过三层嵌套信封：*

<br>

**And the mode id obeys a law of carriers that cost us three days to learn:**

| Condition · 条件 | Carrier · 承载位 | Result · 结果 |
|---|---|---|
| Envelope present, no audio | `Lgcvm.#1` | Mode takes effect, full power |
| 有信封，无音频 | `Lgcvm.#1` | 档位生效，满血 |
| Envelope present, audio attached | `Lfzqy.#13` | Mode yields to hearing (Argon cannot read audio) |
| 有信封，带音频附件 | `Lfzqy.#13` | 档位退让换听觉（Argon 读不到音频） |
| No envelope | `Lfzqy.#1` | Mode applies, but `#13` must be present or it is ignored |
| 无信封 | `Lfzqy.#1` | 档位生效，但缺 `#13` 同样被忽略 |

---

## ✦ Model Tiers · 模型档位

<br>

| Tier · 档位 | Mode ID | Rank · 阶 |
|---|---|---|
| **4 Argon** | `95a4c0abcba24364` | 8 |
| **3.1 Pro** | `e6fa609c3fa255c0` | — |
| **3.8 Flash** | `56fdd199312815e2` | — |
| **3.5 Flash-Lite** | `8c46e95b1a07cecc` | 6 |

*These IDs are served by the upstream, not invented by us. The table refreshes itself every 10 minutes.*

*这些 ID 由上游下发，非我方臆造。档位表每 10 分钟自行刷新。*

---

## ⚠️ Field Laws · 字段铁律

<br>

**Every one of these was paid for in hours. Read them before you touch the wire.**

*以下每一条都是用小时数换来的。动线之前先读。*

<br>

**1. Field aliasing is mandatory.** Production venvs send `mime_type`; older ones send `mimeType`. Accept both, always.

*1. 字段双认是铁律。* 生产 venv 发 `mime_type`，旧版发 `mimeType`。两者都必须认。

<br>

**2. Tolerant parsing is mandatory.** `text` and `inlineData` may coexist in one part. An `else-if` silently drops attachments.

*2. 宽容解析是铁律。* `text` 与 `inlineData` 可能同处一个 part。写成 `else-if` 会静默丢掉附件。

<br>

**3. HTTP/2 unary completes at trailers.** Wait for them, or you burn 10–15 seconds for nothing.

*3. HTTP/2 unary 收到 trailers 即算完成。* 不等 trailers 就白等 10~15 秒。

<br>

**4. Conversation isolation is on by default.** The upstream maintains sessions **per account**; without deletion, callers bleed context into each other.

*4. 会话隔离默认开启。* 上游按**账号**维持会话；不删除会话，不同调用方的上下文会互相渗透。

<br>

**5. `#16` obeys the carrier law.** Put it in the wrong place and it is silently ignored. Unit §14.11 and e2e §3b guard this.

*5. `#16` 必须遵守承载位法则。* 放错位置会被静默忽略。单测 §14.11 与 e2e §3b 守着这条。

---

## 🛡️ The Duplicate-Billing Incident · 重复计费事故

<br>

**This is the story Summeretto was forged to prevent. It is told here so that no one repeats it.**

*这是 Summeretto 被锻造出来阻止的故事。记在此处，以免后人重蹈。*

<br>

**On a summer evening, a request succeeded. A gateway was restarted to deploy a health check. The restart severed an in-flight request whose attachments were already uploaded, whose token was already minted, and whose inference had already begun upstream. The caller's SDK, seeing `Server disconnected`, faithfully re-sent the identical payload.**

**The upstream billed it twice. The same 317 KB video and its 29.9k-token prompt were paid for in full — twice — and one of those bills had no recipient.**

<br>

> *某个盛夏的傍晚，一个请求成功了。一座网关为了部署健康检查而重启。重启斩断了一个在途请求——它的附件已上传、令牌已铸出、上游推理已开始。调用方的 SDK 眼见 `Server disconnected`，便忠实地重发了逐字节相同的 payload。*
>
> *上游计了两次费。同一段 317KB 视频连同它 29.9k token 的提示词，被足额付了两遍——而其中一笔，无人签收。*

<br>

**Three laws were written in response:**

```text
1. "Client didn't receive" ≠ "Upstream didn't bill."
   客户端没收到，不等于上游没算。

2. Severing a connection severs the return path only.
   掐断连接，只掐断回程。

3. Before restarting, check /healthz → inflight. If > 0, wait.
   重启之前，先看 /healthz → inflight。大于 0 就等。
```

*为此立下三条律法：*

<br>

**Law 3 is now enforced mechanically — `lib/dedup.js` replays identical payloads with zero upstream calls, and `lib/inflight.js` makes graceful shutdown wait for the singers to finish.**

*律法三如今由机械执行——`lib/dedup.js` 以零上游调用重放相同请求，`lib/inflight.js` 让优雅停机等待歌者唱完。*

---

## ◆ Testing · 试炼

<br>

```bash
cd service
node test/run.mjs    # 83 assertions · 83 组断言
node test/e2e.mjs    # 49 assertions · 49 组断言
```

*Both suites are fully offline — the mock Robin speaks h2c and the mock upstream lives on `127.0.0.2`, so the whole ordeal costs zero quota and zero bandwidth.*

*两套测试完全离线——mock Robin 说 h2c，mock 上游住在 `127.0.0.2`，全程零配额、零外网。*

---

## ✦ Repository Map · 疆域图

<br>

```
Summeretto/
├── service/            ← the engine · 引擎本体（zero deps）
│   ├── lib/
│   │   ├── wire.js         protobuf wire codec · protobuf 线格式编解码
│   │   ├── robin.js        gRPC bidi driver · gRPC 双向流驱动
│   │   ├── pq.js           three-step query script · 三步查询脚本
│   │   ├── auth.js         gpsoauth master-token minting · gpsoauth 铸令牌
│   │   ├── modes.js        model tiers + thinking intensity · 档位与思考强度
│   │   ├── mediashim.js    audio→placeholder video · 音频渡桥
│   │   ├── dedup.js        idempotent replay · 幂等去重
│   │   ├── inflight.js     in-flight counter · 在途计数
│   │   ├── degrade-guard.js  observe-only downgrade watch · 降级观测
│   │   └── usage-estimate.js  local token estimation · 本地 token 估算
│   ├── test/            ← 83 + 49 offline assertions · 离线断言
│   └── server.mjs       ← entry + graceful shutdown · 入口与优雅停机
├── docs/               ← protocol archaeology · 协议考古报告
└── tools/              ← device-side extraction · 设备侧提取工具
```

---

## ⚡ Deployment · 布阵

<br>

**Self-hosted is the blessed path. Vercel's 4.5 MB inbound ceiling turns every voice request into a `413` — that ceiling is precisely why this project left the platform.**

*自托管是受祝福的路径。Vercel 的 4.5MB 入站硬限会把每一次语音请求变成 `413`——那道天花板，正是本项目离开平台的原因。*

<br>

**A production-grade systemd unit needs three things people forget:**

```ini
[Service]
# 1. The body limit must clear real payloads
Environment=MAX_BODY_BYTES=33554432

# 2. Memory ceiling — peak is ~5–6× the payload, not the payload
MemoryMax=384M

# 3. ★ ProtectHome blocks the .env write-back.
#    Open the DIRECTORY, not just the file.
ReadWritePaths=/home/azureuser/robin-proxy
```

*一套生产级 systemd unit 有三件事常被遗忘：*

```ini
[Service]
# 1. 请求体上限必须容纳真实载荷
Environment=MAX_BODY_BYTES=33554432

# 2. 内存上限——峰值是载荷的 5~6 倍，不是载荷本身
MemoryMax=384M

# 3. ★ ProtectHome 会阻断 .env 落盘。
#    要开放的是【目录】，不只是文件。
ReadWritePaths=/home/azureuser/robin-proxy
```

<br>

**Deploy discipline, learned the expensive way:**

```bash
# BEFORE any restart — check for singers mid-song
curl -s http://127.0.0.1:3000/healthz | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   assert d['inflight']['inflight']==0, 'IN-FLIGHT REQUEST — WAIT'; \
   print('safe to restart')"

sudo -n systemctl restart robin-proxy
```

*用昂贵代价换来的部署纪律：*

```bash
# 任何重启之前——检查是否有歌者正在唱
curl -s http://127.0.0.1:3000/healthz | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   assert d['inflight']['inflight']==0, '有在途请求——等'; \
   print('可以安全重启')"

sudo -n systemctl restart robin-proxy
```

---

## ◆ Quota Reality · 配额真相

<br>

**Since 2026-05-17, Gemini's five-hour window meters **compute**, not request count. Prompt complexity × model tier × feature surcharges × conversation length (every turn re-reads the full history). There is no fixed "number of uses."**

<br>

> *自 2026-05-17 起，Gemini 的五小时窗口按**算力**计量，不数条数。提示词复杂度 × 模型档位 × 功能加价 × 对话长度（每轮重读全量历史）。不存在固定的「能用几次」。*

<br>

**Which means the cost floor of a single call is not the media — it is the 26.5k tokens of tool schemas and re-read history that arrive with every single turn. Optimize that first.**

*这意味着单次调用的成本底噪不是媒体，而是每一轮都随行的、26.5k token 的工具 schema 与重读历史。先优化那个。*

---

## ✦ Epilogue · 终章

<br>

**The garden was never truly sealed. It was merely singing in a language few had bothered to learn.**

**Summeretto learned it. And now, so can you.**

**Listen — the robin is still singing.**

<br>

> *庭园从未真正封闭。它只是用一门少有人愿意学的语言歌唱。*
>
> *Summeretto 学会了。而现在，你也能。*
>
> *听——知更鸟仍在歌唱。*

<br>

<div align="center">

**Miss Robin awaits your stream-song.**

**知更鸟小姐，等候你的拉条晴歌。**

`https://github.com/0xcr1st0f0r0/Summeretto`

</div>
