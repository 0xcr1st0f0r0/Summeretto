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

## 5. ★ 实测与调优（重要，请勿照抄参数）

本组件的 `EMPTY_RETRY` / `EMPTY_RETRY_DELAY_MS` 默认值来自**本机一轮实测**，
换网络、换账号、换时段后**建议重新实测再定**。

### 5.1 观察到的现象

上游会**间歇性返回空正文**：`candidates[].content.parts` 为空、`finishReason:"STOP"`，
HTTP 仍是 200。此时 `modelVersion` 只会**原样回显请求的模型名**（没有 `Used …` 前缀），
可据此与真实响应区分。

本机实测空响应率在 **1/4 ~ 1/3** 区间波动（不同轮次差异明显），与客户端无关
（curl 与 SDK 分别实测均出现）。

### 5.2 根因：重试延迟为 0

主服务自带空响应自愈（`ROBIN_EMPTY_RETRY`，`lib/config.js`），
但其延迟项 `ROBIN_EMPTY_RETRY_DELAY_MS` **默认为 0**——
重试会立刻打在同一个坏后端上，等于没重试。实测该配置下 15 次重试仅救回 4 次。

另外，空响应判定依赖流结束（实测 `endedBy:"idle"`），**单次空响应约耗 5s**。
所以重试次数是直接乘进延迟的。

### 5.3 ★ 不要让两层重试叠乘

主服务与桥都有重试。同一次空响应，主服务重试 3 次 ≈ 20s；
桥若再重试 2 次，最坏可达 **60s**。本机实测出现过**单次请求 21.5s**。

结论：**重试交给懂协议的主服务那层，桥只做 1 次轻量保险。**

### 5.4 本机定稿配置与结果

| 参数 | 值 | 位置 |
|---|---|---|
| `ROBIN_EMPTY_RETRY` | `3`（仓库默认 `1`，上限 3） | 主服务环境变量 |
| `ROBIN_EMPTY_RETRY_DELAY_MS` | `400`（仓库默认 `0`） | 主服务环境变量 |
| `EMPTY_RETRY` | `1` | 桥环境变量 |
| `EMPTY_RETRY_DELAY_MS` | `500` | 桥环境变量 |

定稿后连续 10 次调用：**10/10 成功、0 空响应、0 异常，平均 48ms、最长 53ms**。

> 注：上述主服务参数**未包含在仓库的 `docker-compose.yml` 里**（那里保留较保守的
> `ROBIN_EMPTY_RETRY: 1`）。本机是通过本地 override 覆盖的，是否采纳由部署方决定。

### 5.5 怎么自己实测

```bash
# 连续 N 次，统计空响应率与延迟
for i in $(seq 1 20); do
  s=$(date +%s%N)
  n=$(curl -s -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' \
    -d '{"model":"4-argon","messages":[{"role":"user","content":"说三个字"}]}' \
    | python -c "import sys,json;print(len(json.load(sys.stdin)['choices'][0]['message']['content']))")
  echo "$i $(( ($(date +%s%N)-s)/1000000 ))ms len=$n"
done

# 主服务侧的空响应/重试计数
curl -s "$UPSTREAM/healthz" | python -c \
  "import sys,json;d=json.load(sys.stdin);print(d['emptyRetry']);print(d['degradeGuard'])"
```

判据：
- **空响应率高** → 调大主服务 `ROBIN_EMPTY_RETRY`（≤3）并**务必补 `ROBIN_EMPTY_RETRY_DELAY_MS`**；
- **延迟不可接受** → 优先减桥的 `EMPTY_RETRY`，而不是减主服务的；
- 单次空响应本身约 5s，这是判定机制决定的，调参只能减少发生次数、无法消除单次成本。

## 6. 文件清单

| 文件 | 作用 |
|---|---|
| `openai-shim.mjs` | 兼容桥本体，零依赖，纯 `node:http` |
| `docker-compose.openai-shim.yml` | 可选编排，独立于 `docker-compose.yml` |
| `OpenAI-compat.md` | 本文档 |