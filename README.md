<div align="center">

<img src="docs/assets/banner.png" alt="Summeretto - Robin • Summeretto Banner" width="100%" />

<br><br>

# Summeretto

### *「告别官方繁琐限制，享受知更鸟小姐的高速流式拉条体验！」*

**A high-performance Gemini reverse gateway powered by Google's internal Robin protocol.**  
**Zero dependencies, instant action advance, full model tiers, and built-in production guards.**

*基于 Google 内部 Robin 协议魔改的高性能 Gemini 网关 —— 纯手写零依赖，享受知更鸟·晴歌（Robin • Summeretto）专属的全速推流体验。*

<br>

[![Node](https://img.shields.io/badge/node-22.x-5DCAA5?style=flat-square)](https://nodejs.org)
[![Zero Deps](https://img.shields.io/badge/dependencies-0-378ADD?style=flat-square)](https://github.com/0xcr1st0f0r0/Summeretto)
[![Protocol](https://img.shields.io/badge/protocol-gRPC%20bidi-7F77DD?style=flat-square)](https://grpc.io)
[![Character](https://img.shields.io/badge/Robin-Summeretto%20%E2%80%A2%20%E6%99%B4%E6%AD%8C-5D88FF?style=flat-square)](https://github.com/0xcr1st0f0r0/Summeretto)
[![License](https://img.shields.io/badge/license-AGPL--3.0-D85A38?style=flat-square)](LICENSE)

</div>

---

## 📖 Introduction · 项目简介

### 这是什么？
**Summeretto** 是一个专为 Google Gemini 打造的高性能逆向代理网关。它把 Google Gemini 移动端 App 底层使用的 **Robin gRPC 双向流协议**（基于 HTTP/2 + Protobuf），转换为标准兼容的 **Gemini REST API**（例如标准的 `/v1beta/models/{model}:generateContent` 和流式输出）。

你的本地客户端或前端应用（如 NextChat、LobeChat、自建 Agent 等）只需要像调用官方 Gemini API 一样发送标准 JSON 请求，Summeretto 就会在后台通过高速 gRPC 双向流与上游交互，并将生成结果实时推流回给客户端。

### 为什么叫 Summeretto？
在《崩坏：星穹铁道》中，人气角色知更鸟褪去匹诺康尼的繁重礼服，化身轻松自由的**「知更鸟·晴歌」（Robin • Summeretto）**，带着三只可爱的忆灵小鸟奔向蔚蓝海滩，开启充满活力的夏日变奏；而在技术世界里，Google 内部专门负责 Gemini 移动端高速推流的底层协议代号恰好也叫 **Robin**。

本项目以此为灵感命名，旨在打破官方公有 API 的种种繁琐限制，像知更鸟在游戏中为全队“100% 极限拉条”一样，让你的 AI 交互享受零排队、满血档位、毫秒级首字响应的极速体验！

---

## ✨ Key Features · 核心特性

Summeretto 不仅是一个转发器，还内置了大量针对官方私有协议深水区难题的生产级解决方案：

| 特性 | 机制别名 | 技术实现与解决的痛点 |
|---|---|---|
| **🪶 纯零依赖**<br>Zero Dependencies | **「我们自成旋律」** | 纯 Node.js 22 标准库手写，**完全不需要执行 `npm install`**。没有体积庞大的第三方库，也不依赖 Protobuf 编译器生成的冗长代码，整台引擎代码轻巧清晰，随时可读。 |
| **⚡ 原生 gRPC 双向流**<br>gRPC Bidi Core | **「巡游无界天空」** | 基于 `node:http2` 手写帧封装与流式双向传输。告别传统 HTTP 轮询与单向推流，首字延迟极低，体验真正的流式全速拉条。 |
| **🎭 真实模型档位实时发现**<br>Mode Awakening | **「档位觉醒」** | 真实模型档位通过 `Lgauy.#16` 从上游 `GetUserStatus` 接口实时动态发现，绝非自欺欺人的占位符。动态支持 **4 Argon**、**3.1 Pro**、**3.8 Flash** 和 **3.5 Flash-Lite**。 |
| **🧠 思考强度独立调节**<br>Thinking Intensity | **「灵动变奏」** | 协议底层支持 `Lfzqy.#48` 独立调节思考时间（枚举值 `1=Low / 4=Medium / 2=High`）。与模型名称完全正交，无需切换模型名字即可按需开启深度思考。 |
| **🎵 音频转视频破除互斥**<br>Media Shim | **「偏离和弦」** | **彻底解决官方致命缺陷**：上游 Robin 协议中，原生音频附件与满血 Argon 档位互斥（带音频就会被强降级）。Summeretto 自动用 ffmpeg 把音频包进 16×16 黑帧视频走视频通道（降采样至 0.25fps），视觉 token 省 75%，总媒体账单降低 66.7%，满血 Argon 听写与深度推理兼得！ |
| **🎺 空响应自动重试自愈**<br>Empty-Response Retry | **「即兴蓝调」** | 针对官方 App 也会偶发的“返回 HTTP 200 STOP 但内容全空”问题，Summeretto 智能甄别“偶发断流”与“账号级降级”，在 100s 预算护栏内自动原地重试，对调用方完全透明无感。 |
| **🛡️ 90秒幂等去重防扣费**<br>Idempotent Dedup | **「免于重复计费」** | 客户端断网后自动重试？Summeretto 在 90 秒滑动窗口内对完全一致的请求直接重放缓存，**0 上游重复调用**，坚决防止同一段大视频/提示词被上游重复计费。 |
| **🌙 优雅停机保护在途请求**<br>Graceful Shutdown | **「守护在途歌者」** | 收到 SIGTERM 停机信号时，不再粗暴杀死进程。新请求温和返回 503，正在跑的请求温柔守候直至推理完整结束，避免重启造成“上游已扣费但客户端没收到”的损失。 |
| **🔭 静默降级透明观测**<br>Degrade Observatory | **「降级观测台」** | 上游若因账号配额不足将高档位静默降为 Flash-Lite，Summeretto 只忠实原样透出响应元数据（`modelVersion`），绝不自作主张擅自换将，将降级切换权交由上层调度器。 |
| **📜 本地 Token 诚实估算**<br>Quota Metering | **「算力度量」** | 逆向证实上游私有协议绝不返回 token 使用量。Summeretto 在本地按官方公开标准严格估算（明确标注文档非计费依据），让你对调用开销保持清醒。 |

---

## 🚀 Quick Start · 快速上手

### 1. 克隆与配置

```bash
# 克隆仓库
git clone https://github.com/0xcr1st0f0r0/Summeretto.git
cd Summeretto/service

# 准备环境变量文件
cp .env.example .env
```

### 2. 网页一键登录获取凭据

你不需要准备真实安卓手机、不需要装 Frida 抓包，也不需要 Root 设备！

启动服务：
```bash
node server.mjs
```

然后直接在浏览器中打开：
```
http://127.0.0.1:3000/login
```
按照内置的简洁网页引导完成一次 Google 账号授权，系统会自动帮你铸造出长效的 `GSA_MASTER_TOKEN` 并自动回写落盘到 `.env` 中。后续服务端会自动管理和刷新短期访问令牌。

### 3. 验证服务状态

使用 `curl` 检查服务是否就绪：

```bash
curl -s http://127.0.0.1:3000/healthz | python3 -m json.tool
```

如果一切正常，你会收到类似如下的 JSON 应答：

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

> 💡 **提示**：`credential.verdict` 是纯被动状态判定，绝不会无谓请求 Google 服务器。只要显示 `"usable": true`，就代表凭证完全可用。

---

## 🛠️ How It Works · 协议原理解密

### 为什么一次请求需要“发三步”？

在常规 REST API 中，发一次请求就是发一个 HTTP POST。但在 Google Robin 双向流协议中，一次完整的查询是一套严密的**三步仪式**，恰好对应知更鸟的三位忆灵伙伴：

```
[步骤一：通道就绪]   Initial Frame  ──►  粉鸟·贝茜 (Bessie)   ─── 建立双向流信道，发送首帧、文本提示与附件引用
[步骤二：上下文预取] Prefetch Frame ──►  啾米 (Chumi)         ─── 挂载预取元数据、展开嵌套信封
[步骤三：正式提交]   Commit Frame   ──►  派丁 (Paddin)        ─── 落地单帧 Lgcvl{#2}，三鸟齐聚，瞬间开始推流！
```

* **关键约束**：第三步提交（Commit）必须是极其利落的单帧 `Lgcvl{#2}`。最外层请求信封为 `Lgcvp` 裸格式，零层多余包装；若错包成旧客户端的 `Lgcxj`，会直接触发上游的严苛限流。
* **附件信封嵌套链路**：
  ```text
  Lgcvp[ext1000] → Lgcvm[ext1001] → Lgcvb.#1 → Lfzqy{#1 Lgbkn, #13 Lgauy}
  ```

### 承载位铁律（Carrier Law）

为什么有时候请求了满血 Argon，模型却变笨了？这是因为上游对 Protobuf 字段的位置有严苛要求：

| 场景条件 | 档位承载位置 | 实际生效结果 |
|---|---|---|
| **无原始音频**（纯文本 / 图片 / 走占位视频转封装） | `Lgcvm.#1` | **满血 Argon 生效**，推流全开（信封内随附 `Lfzqy.#13` 维持结构） |
| **携带原始音频**（未走转封装之回退） | `Lfzqy.#13` | **档位自动退让换听觉**（Argon 原生无法解析音频，自动回落 Flash-Lite） |
| **纯文本无信封**（无附件、默认思考档位） | `Lgcvm.#1` | **直接由 `Lgcvm.#1 Lgauy.#16` 承载**，零多余信封开销生效 |

---

## 🎭 Model Tiers · 模型档位清单

Summeretto 内部每 10 分钟自动与上游同步一次真实档位表：

| 模型档位 (Tier) | 上游真实 Mode ID (Hex) | 阶级 (Rank) | 推荐使用场景 |
|---|---|---|---|
| **4 Argon** | `95a4c0abcba24364` | 8 | 满血旗舰深思与终极复杂逻辑合成（主力旗舰） |
| **3.1 Pro** | `e6fa609c3fa255c0` | 3 | 复杂多轮长文本推理与专业分析 |
| **3.8 Flash** | `56fdd199312815e2` | 1 | 日常高频对话、低延迟快速响应（首选高敏捷档） |
| **3.5 Flash-Lite** | `8c46e95b1a07cecc` | 6 | 超轻量级兜底基线（也是音频未转封装时的听觉退让档） |

---

## ⚠️ Protocol Pitfalls · 协议避坑指南

以下 5 条铁律是逆向分析过程中用大量调试时间换来的血泪经验：

1. **字段名大小写双重兼容**：不同版本的客户端/SDK 序列化规则不一（有的发 `mime_type`，旧版发 `mimeType`）。网关必须双向宽容认领，缺一不可。
2. **文本与附件宽容并存**：在 Gemini 请求体中，`text` 与 `inlineData` 经常出现在同一个 part 对象里。切勿写成 `else-if`，否则会静默丢弃用户的附件。
3. **HTTP/2 Unary 请求必须等 Trailers**：如果不等待 trailers 帧到达就判定完成，客户端会白白空等 10～15 秒直至超时。
4. **会话隔离必须默认开启**：Robin 服务端会按**账号维度**维持连续会话。若不执行显式会话隔离清理，不同调用方的上下文历史会互相串扰污染。
5. **模型 ID 承载位不可放错**：模型 ID 放错嵌套层级会被上游完全无视，导致请求静默回落到最低兜底档位。

---

## 🛡️ The Story · 一次由重启引发的重复计费惨案

### 「客户端没收到」≠「上游没扣费」

在 Summeretto 早期开发的一个傍晚，发生过一次真实的事故：
> 当时正在进行一次包含 317KB 视频附件与 29.9k token 提示词的复杂多模态推理。运维人员因热更新健康检查脚本执行了网关重启。这一重启直接掐断了连接。调用方 SDK 检测到 `Server disconnected` 后，忠实地重新发送了完全一致的请求包。
>
> **结果**：上游针对前后两个请求全额扣了两次配额与费用——而第一次推理生成的回答，因为连接已被掐断，永远沉入了虚空。

为了杜绝此类惨剧，Summeretto 确立了三条刚性工程法则，并转化为机械代码执行：

```text
1. 客户端没收到，绝不代表上游没扣费！
2. 掐断网络连接，只是断了接收的耳朵，上游算力的齿轮依然在转动。
3. 任何重启操作之前，必须检查 /healthz 中的 inflight 计数；只要大于 0，必须等待歌者唱完。
```

* **防线一**：`lib/dedup.js` —— 90 秒滑动窗口内逐字节对比，若发现重复请求直接重放上次缓存流，**零上游调用**。
* **防线二**：`lib/inflight.js` —— 拦截系统 SIGTERM 信号，拒绝新连接，等待在途请求平稳落幕。

---

## 🧪 Testing · 离线全套测试

项目配备了完善的测试套件，**100% 离线自洽运行**，无需花费任何真实配额：

```bash
cd service
node test/run.mjs    # 运行单元测试（83 组断言通过）
node test/e2e.mjs    # 运行端到端集成测试（49 组断言通过）
```

测试内置了基于 `127.0.0.2` 的 h2c mock Robin 服务，无论是占位视频转换、空响应重试、幂等去重还是流式传输，都能在本地以秒级速度完成无损回归验证。

---

## 🗺️ Repository Map · 目录导览

```text
Summeretto/
├── service/                   ← 核心代理引擎（纯标准库，0 npm 外部依赖）
│   ├── lib/
│   │   ├── wire.js            Protobuf 线格式编解码器
│   │   ├── robin.js           HTTP/2 gRPC 双向流网络驱动
│   │   ├── pq.js              ProcessQuery 协议三步组装与解析
│   │   ├── gemini.js          Gemini REST 格式与 Robin 格式双向翻译
│   │   ├── auth.js            Token 状态维护与被动验真
│   │   ├── gpsoauth.js        Google Play Services OAuth 协议实现
│   │   ├── login-page.js      内置 Web 免设备登录交互界面
│   │   ├── modes.js           模型档位与思考强度管理
│   │   ├── mediashim.js       音频转 16x16 极小视频渡桥模块 (0.25fps)
│   │   ├── empty-retry.js     空响应智能重试与时间预算护栏
│   │   ├── dedup.js           90 秒幂等去重重放层
│   │   ├── inflight.js        在途请求跟踪与优雅停机调度
│   │   ├── degrade-guard.js   上游静默降级透明观测器
│   │   ├── usage-estimate.js  本地 Token 算力估算器
│   │   ├── toolcall.js        工具调用 (Function Calling) 仿真注入
│   │   ├── upload.js          push.clients6 分片断点上传管道
│   │   ├── config.js          环境变量与运行时配置中心
│   │   └── app.js             HTTP 路由分发与服务主逻辑
│   ├── test/                  ← 83 + 49 组离线全量断言测试
│   └── server.mjs             ← 服务启动入口与信号接管
├── docs/                      ← 协议考古与实测逆向分析报告
└── tools/                     ← 设备侧抓包与分析辅助脚本
```

---

## 🚢 Deployment · 生产部署建议

### 为什么强烈建议自建 VPS 而非 Serverless 平台？

像 Vercel 等 Serverless 平台普遍存在 **4.5 MB 的请求体硬上限**。在多轮多模态对话中，带有稍微清晰一些的音频或高清图片就会轻松突破 5MB，直接被平台粗暴返回 `413 Payload Too Large`。因此，通过自建 VPS 托管是获得满血体验的最佳路径。

### 生产环境 systemd 配置示例

创建 systemd 服务单元（如 `/etc/systemd/system/summeretto.service`），注意三个核心配置项：

```ini
[Unit]
Description=Summeretto Gemini Robin Proxy
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/Summeretto/service
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5

# 1. 放开请求体上限，容纳多模态大包（建议 32MB）
Environment=MAX_BODY_BYTES=33554432

# 2. 内存上限：流式多模态传输峰值约为体积的 5~6 倍，推荐 384MB
MemoryMax=384M

# 3. ★ 务必开放【整个 service 目录】的读写权限，以便回写 .env token
ReadWritePaths=/path/to/Summeretto/service

[Install]
WantedBy=multi-user.target
```

### 安全重启守则

在需要重启服务时，请先检查是否有在途请求：

```bash
# 重启前检查是否有正在歌唱的在途请求
curl -s http://127.0.0.1:3000/healthz | python3 -c \
  "import sys,json; d=json.load(sys.stdin); \
   assert d['inflight']['inflight']==0, '尚有在途请求未完成，切勿强行重启！'; \
   print('安全，可以重启')"

sudo systemctl restart summeretto
```

---

## 📊 Quota Reality · 算力配额说明

从 2026 年中旬起，Google 对 Gemini 的 5 小时滑动窗口配额已经全面改为**按实际算力（Compute）计量**，而不再是简单的“使用次数”：
$$\text{单次开销} \propto \text{提示词复杂度} \times \text{模型档位乘区} \times \text{功能加权} \times \text{上下文历史长度}$$

> 💡 **实用建议**：在多轮对话中，每一轮交互其实都会将前面所有的历史对话以及约 26.5k token 的工具声明完整重读一遍。因此，保持 Prompt 和历史上下文的简洁，是避免触碰配额墙的最有效手段。

---

## 🌸 Epilogue · 尾声

庭园的门扉其实从未锁死，它只是在用一门独特的双向流语言歌唱。现在，一切障碍已被扫除。

祝你使用愉快，尽情享受知更鸟小姐带来的流式拉条晴歌吧！

<div align="center">

### **Miss Robin • Summeretto awaits your stream-song.**
### **知更鸟·晴歌，等候你的下一次盛夏拉条。**

`https://github.com/0xcr1st0f0r0/Summeretto`

</div>
