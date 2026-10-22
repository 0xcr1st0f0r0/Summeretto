# OpenAI 兼容桥（可选组件）

主服务对外只暴露 **Gemini 原生格式**，而不少第三方客户端只认 **OpenAI 那一套**。
本组件是一个独立的翻译层，夹在两者之间；**不改动主服务任何代码**。

- 脚本：`openai-shim.mjs`（零依赖，纯 `node:http`）
- 编排：`docker-compose.openai-shim.yml`（与 `docker-compose.yml` 相互独立）

## 1. 什么时候需要它

| 客户端形态 | 直接连主服务 |
|---|---|
| 官方 `@google/genai` SDK、Gemini 原生 HTTP 客户端 | ✅ 直接连 `/v1beta/...`，**不需要本组件** |
| 只提供「OpenAI 兼容 / 自定义 OpenAI」接入的客户端 | ❌ 会得到 404「未知路由」→ 需要本组件 |

实测确认过：主服务对 `POST /v1/chat/completions` 与 `GET /v1/models` 均返回
`404 {"error":{"message":"未知路由：POST /v1/chat/completions"}}`——
路由全集只有 Gemini 原生那套。

## 2. 快速开始

### 方式 A：Docker（推荐）

```bash
cd service
# 假设主服务已在宿主机 3000 端口发布
docker compose -f docker-compose.openai-shim.yml up -d
curl -s http://127.0.0.1:8081/v1/models   # 验证
```

### 方式 B：裸 Node

```bash
cd service
node openai-shim.mjs
# 或指定上游与端口
UPSTREAM=http://127.0.0.1:3000 SHIM_PORT=8081 node openai-shim.mjs
```

客户端填：

```
Base URL = http://127.0.0.1:8081/v1
API Key  = 任意字符串
```

> 主服务若设置了 `PROXY_API_KEY`，客户端需带 `x-goog-api-key`（或 `Authorization: Bearer`），
> 桥会原样透传；未设置时桥与主服务都不校验。

## 3. 端点映射

| OpenAI 侧 | 桥内部 | 主服务侧 |
|---|---|---|
| `GET /v1/models` | 拉模型列表并转格式（60s 缓存） | `GET /v1beta/models` |
| `POST /v1/chat/completions`（`stream:false`） | messages → contents | `POST /v1beta/models/{model}:generateContent` |
| `POST /v1/chat/completions`（`stream:true`） | SSE 逐帧转 `chat.completion.chunk` | `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` |
| `GET /healthz` | 直通（诊断用） | `GET /healthz` |

**字段转换**

| OpenAI | Gemini |
|---|---|
| `messages[].role: "system" \| "developer"` | `systemInstruction.parts[]` |
| `messages[].role: "assistant"` | `contents[].role: "model"` |
| `content` 为字符串 | `parts: [{ text }]` |
| `content[]` 的 `{type:"image_url", image_url:{url:"data:…;base64,…"}}` | `parts: [{ inlineData: { mimeType, data } }]` |
| `reasoning_effort` / `thinkingConfig.thinkingLevel` | `generationConfig.thinkingConfig.thinkingLevel` |
| `temperature` / `top_p` / `max_tokens` | `generationConfig.temperature / topP / maxOutputTokens` |

响应侧：`finishReason` `STOP / MAX_TOKENS / SAFETY / RECITATION` → OpenAI
`stop / length / content_filter / content_filter`；`usageMetadata` → `usage`。

## 4. 已知限制

- **模型名不存在时主服务不报错，而是静默降级**到最低档位（实测传 `no-such-model`
  返回的是 `Used 3.5 Flash-Lite model`）。请从 `/v1/models` 拉取列表后再选，
  不要手敲模型名。
- 工具调用 / function calling 未做结构化转换（本项目上游无工具声明位，
  走的是 prompt 仿真，见 `lib/toolcall.js`）。`role: "tool"` 的消息会并入 user 轮。
- 远程图片 URL 不做下载，按文本透传；只有 `data:` URI 能正确转成 `inlineData`。
- 单请求体受主服务 `MAX_BODY_BYTES` 限制；大文件请走主服务的
  `POST /upload/v1beta/files` 分片上传，桥未做代理。

## 5. ★ 空回复与重试调优（请先读 §5.1）

本组件的 `EMPTY_RETRY` / `EMPTY_RETRY_DELAY_MS` 默认值来自**本机一轮实测**，
换网络、换账号、换时段后**建议重新实测再定**。

### 5.1 ⚠️ 上游已根治空回复，本文的旧数据请按「历史」理解

主服务在 `79b5ce3`（`fix: 根治空回复 —— 等待上限 300s + 确定性收尾信号`）中已修掉根因。

旧实现用**统一 10s 静默定时器**判定「上游没动静了」，于是把**上游慢但活着**的响应
掐成空回复。实测首正文延迟：轻请求 0.3~5.4s，生产载荷 10.8~30.1s（最大帧间隙 26.4s）
⇒ 10s 必然误杀。修法是引入**确定性收尾信号**（`Lgapu.#19==2` 正文完成标记 /
上游 EOS 标记）并把总时限拉到 300s。

上游作者实测效果（`service/README.md` §9.3）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 空回复率（轻请求） | ~5~8% | **0%** |
| 空回复率（重载荷） | 100% 复现 | **0%** |
| flash-lite 纯文本中位延迟 | 19.3s | **3.2~3.4s（≈6× 提速）** |
| 结束方式 | 静默超时猜 | 完成标记（实测 20/20） |
| 慢上游（实测 127s / 191s / 275s 才吐字） | 全被掐成空回复 | 全部正常返回 |

> **本组件初稿时实测到的 1/4~1/3 空响应率，测的正是这个 bug**，不是上游常态。
> 若你还在修复前的版本，请先升级——否则下面的调参建议会误导你。

### 5.2 修复后，桥侧重试只需作轻量保险

| 参数 | 默认 | 说明 |
|---|---|---|
| `EMPTY_RETRY` | `1` | 桥侧重试次数。根因修掉后基本用不上 |
| `EMPTY_RETRY_DELAY_MS` | `500` | 桥侧重试间隔 |

主服务侧的自愈（`ROBIN_EMPTY_RETRY`）**建议保持仓库默认**（`1`）。
上游 `79b5ce3` 未改 `ROBIN_EMPTY_RETRY_DELAY_MS` 的默认值（仍为 0），
但根因已修的前提下该延迟不再是关键路径。

#### 修复后本地实测（上游含 `79b5ce3`）

20 个**互不相同**的 prompt（否则会撞 90s 响应缓存，见 §5.5）：

| 指标 | 结果 |
|---|---|
| 客户端可见空回复 | **0/20 = 0%** |
| 上游内部空事件 | 2 次，`endedBy:"server-end"`、`idleCutBeforeText:false`、诊断 **E**（上游静默拒答·账号资源态） |
| 这 2 次的归宿 | 均被桥侧重试救回，客户端无感 |

诊断 **E** 与旧的「A2 空闲截断」是**不同类问题**：A2 是我方定时器误杀（已修），
E 是上游主动沉默（账号资源态），**调重试参数解决不了**，只能重试或换账号。

分档位延迟（各 5 次不同 prompt）：

| 档位 | 平均延迟 |
|---|---|
| `3.5-flash-lite` | ~3.6s（与上游 README §9.3 的 3.2~3.4s 吻合） |
| `3.8-flash` | ~4.8s |
| `4-argon` | ~13s |

> 上游修复的代价是**等得久但不再丢内容**：慢上游现在能正常返回，代价是等待时间变长。
> 追求快请用 `3.8-flash` / `3.5-flash-lite`，`4-argon` 本身就是最慢档位。

### 5.3 ★ 仍需注意：不要让两层重试叠乘

若你的环境仍出现空回复（未升级、或走自建上游），主服务与桥都有重试，**会叠乘**：
主服务重试 3 次 ≈ 20s，桥再重试 2 次最坏可达 60s。本组件初稿时实测出现过单次 21.5s。

结论：**重试交给懂协议的主服务那层，桥只做 1 次轻量保险。**

### 5.4 上游 `79b5ce3` 新增的配置项

| 变量 | 默认 | 含义 |
|---|---|---|
| `ROBIN_TIMEOUT_MS` | `300000` | 总时限（≤300s） |
| `ROBIN_IDLE_MS` | `10000` | 上游真空（一个字节都没回）的快速失败宽限 |
| `ROBIN_IDLE_AFTER_TEXT_MS` | `30000` | 正文已开始后的兜底静默宽限 |
| `ROBIN_IDLE_FIRST_MS` | `300000` | 首正文前的等待上限；**调小可恢复「卡死即重试」的旧行为** |
| `ROBIN_DEDUP_WAIT_MS` | `300000` | 等同键在途请求时长（须 ≥ 总时限，否则重发会重复计费） |

### 5.5 怎么自己实测

> ⚠️ **测延迟必须用互不相同的 prompt。** 主服务带 90s 响应缓存
> （`/healthz → dedup.ttlMs=90000`，含 `cached` / `hits` 计数），
> 相同 prompt 在 TTL 内会直接命中缓存，测出来的是**缓存命中耗时**而非推理耗时。
> 本组件初稿时就因此把 48ms 误当成推理延迟，真实值差两个数量级。

```bash
# 连续 N 次，**每次 prompt 都要不同**（绕过 90s 响应缓存）
for i in $(seq 1 20); do
  s=$(date +%s%N)
  n=$(curl -s -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
    -d "{\"model\":\"4-argon\",\"messages\":[{\"role\":\"user\",\"content\":\"#$i 用三个字说什么在发光\"}]}" \
    | python -c "import sys,json;print(len(json.load(sys.stdin)['choices'][0]['message']['content']))")
  echo "$i $(( ($(date +%s%N)-s)/1000000 ))ms len=$n"
done

# 主服务侧的空响应/重试/缓存计数
curl -s "$UPSTREAM/healthz" | python -c \
  "import sys,json;d=json.load(sys.stdin);print(d['emptyRetry']);print(d['degradeGuard']);print(d['dedup'])"
```

判据：

- **延迟低得可疑（几十毫秒）** → 多半撞了响应缓存，看 `dedup.hits`；
- **空响应率高** → 先确认主服务是否已含 `79b5ce3`；未升级**先升级，别急着调参**；
- 升级后仍空 → 看 `/healthz → degradeGuard.lastEmpty.diagnosis`：
  `A2` = 我方超时截断（上游只是慢，可调 `ROBIN_IDLE_FIRST_MS`）、
  **`E` = 上游静默拒答（账号资源态），调参无用**、
  `D` = 真·盲区扩展；
- **延迟不可接受** → 优先减桥的 `EMPTY_RETRY`；若整体都慢则换更快的档位
  （`3.8-flash` 约 4.8s，`4-argon` 约 13s）；
- 观测点：`/healthz → emptyRetry` 给出 `emptyEvents / retries / successes / exhausted`，
  修复后新增 `transientEvents`（上游明确拒答但可瞬时恢复，如「地域不可用 ZZ」）。

## 6. 文件清单

| 文件 | 作用 |
|---|---|
| `openai-shim.mjs` | 兼容桥本体，零依赖，纯 `node:http` |
| `docker-compose.openai-shim.yml` | 可选编排，独立于 `docker-compose.yml` |
| `OpenAI-compat.md` | 本文档 |