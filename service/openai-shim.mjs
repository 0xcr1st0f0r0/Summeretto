#!/usr/bin/env node
// service/openai-shim.mjs —— OpenAI Chat Completions ⇄ Robin(Gemini 原生) 兼容桥
//
// ┌─ 定位（可选组件，非默认链路）────────────────────────────────────────────────┐
// │ 主服务对外只暴露 Gemini 原生格式：                                            │
// │   POST /v1beta/models/{model}:generateContent│
// │   POST /v1beta/models/{model}:streamGenerateContent?alt=sse                   │
// │   GET  /v1beta/models                                                         │
// │ 而相当多第三方客户端只认 OpenAI 那一套：                                       │
// │   POST /v1/chat/completions  +  GET /v1/models                                │
// │ 对这些客户端，直接填服务地址会得到 404「未知路由」（本机实测确认）。          │
// │ 本脚本是一个**可选**的翻译层，放在服务与客户端之间，不改动主服务任何代码。    │
// └────────────────────────────────────────────────────────────────────────────┘
//
// 特性：
//   · GET  /v1/models            → 拉取 /v1beta/models 并转成 OpenAI 列表格式
//   · POST /v1/chat/completions  → 非流式：返回 chat.completion
//                                 流式：SSE，逐块转成 chat.completion.chunk
//   · system / user / assistant 角色互转（system → systemInstruction）
//   · 图片：OpenAI 的 data: URI → Gemini inlineData
//   · 上游空正文补偿重试（带延迟，详见文末「实测与调优」）
//   · 零依赖，纯 node:http
//
// 用法：
//   node openai-shim.mjs                                   # 监听 127.0.0.1:8081
//   SHIM_PORT=18000 UPSTREAM=http://127.0.0.1:3000 node openai-shim.mjs
//
// 客户端填：Base URL = http://127.0.0.1:8081/v1   API Key = 任意字符串
//
// ⚠️ 调参提示：EMPTY_RETRY / EMPTY_RETRY_DELAY_MS 的默认值来自本机一轮实测，
//    **换网络、换账号、换时段后建议重新实测再定**，不要照抄。方法见 OpenAI-compat.md。
//    注：主服务 79b5ce3「根治空回复」已修掉根因（空回复率实测 0%），桥侧重试
//    现仅作轻量保险，默认 1 次即可。

import { createServer } from "node:http";

const PORT = Number(process.env.SHIM_PORT ?? 8081);
const HOST = process.env.SHIM_HOST ?? "127.0.0.1";
const UPSTREAM = (process.env.UPSTREAM ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const EMPTY_RETRY = Number(process.env.EMPTY_RETRY ?? 1);
const EMPTY_RETRY_DELAY_MS = Number(process.env.EMPTY_RETRY_DELAY_MS ?? 500);

// ── 鉴权 ────────────────────────────────────────────────────────────────
// 上游若配置了 PROXY_API_KEY，则所有 /v1beta 路由都要带 key。
// UPSTREAM_KEY：桥自己调上游时用的凭据（= 上游的 PROXY_API_KEY）。
//   留空 = 上游未开鉴权，桥不注入任何 key。
// CLIENT_KEY：桥要求客户端出示的凭据。
//   留空 = 不校验客户端（仅适合单机自用）。
//   设置后，客户端必须在 Authorization: Bearer / x-goog-api-key 里带上它。
// ★ 两者独立：桥对上游用 UPSTREAM_KEY，对客户端用 CLIENT_KEY，
//   这样「桥的出网凭据」不会因客户端乱填 API Key 而被打回。
const UPSTREAM_KEY = String(process.env.UPSTREAM_KEY ?? "").trim();
const CLIENT_KEY = String(process.env.CLIENT_KEY ?? "").trim();

const H = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

/* ───────────────────────────── 工具函数 ───────────────────────────── */

const sendJson = (res, code, obj) => {
  res.writeHead(code, H);
  res.end(JSON.stringify(obj));
};

/** OpenAI 错误结构 */
function sendErr(res, code, message, type = "invalid_request_error") {
  sendJson(res, code, { error: { message, type, code, param: null } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Gemini finishReason → OpenAI finish_reason */
const FINISH_MAP = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  OTHER: "stop",
};

/** 去掉 models/ 前缀；模型名原样透传（支持 4-argon-high 这类后缀） */
const normalizeModel = (m) => String(m ?? "4-argon").replace(/^models\//, "");

/* ─────────────────── OpenAI messages → Gemini contents ─────────────────── */

/** 把一条 OpenAI content（字符串或数组）转成 Gemini parts */
function toParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];

  if (!Array.isArray(content)) return [{ text: String(content) }];

  const parts = [];
  for (const p of content) {
    if (typeof p === "string") {
      if (p) parts.push({ text: p });
      continue;
    }
    // 兼容 {type:"text",text} / {text} / Anthropic 风格的 {type:"text",text:""}
    if (p?.type === "text" || typeof p?.text === "string") {
      if (p.text) parts.push({ text: p.text });
      continue;
    }
    // 图片：data URI → inlineData
    const url = p?.image_url?.url ?? p?.image?.url ?? p?.source?.data;
    if (typeof url === "string") {
      const m = /^data:([^;,]+);base64,(.+)$/.exec(url);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      else parts.push({ text: url }); // 远程 URL：退化为文本，交由上游处理
      continue;
    }
    if (p?.inlineData) parts.push(p); // 已经是 Gemini 形状，原样透传
  }
  return parts;
}

/**
 * 整条消息数组 → Gemini 请求体
 * · system / developer → systemInstruction
 * · user → role:"user"，assistant → role:"model"
 * · tool / function → 合并为文本（本服务无工具声明位，README 已说明走 prompt 仿真）
 */
function toGeminiBody(body) {
  const contents = [];
  let systemParts = [];

  for (const msg of body?.messages ?? []) {
    const role = String(msg?.role ?? "user").toLowerCase();

    // ★ assistant 携带 tool_calls：转成 functionCall part。
    //   原生侧（lib/gemini.js → toolPartToText）会把 functionCall part
    //   转成 ```function_call 围栏文本，与模型约定的提示词格式对齐。
    if (role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length) {
      const parts = toParts(msg?.content);
      for (const tc of msg.tool_calls) {
        const fn = tc?.function ?? tc;
        if (!fn?.name) continue;
        parts.push({ functionCall: { name: fn.name, args: parseArgs(fn.arguments) } });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    const parts = toParts(msg?.content);
    if (!parts.length) continue;

    if (role === "system" || role === "developer") {
      systemParts.push(...parts);
    } else if (role === "tool" || role === "function") {
      // ★ 工具结果：原生侧把 functionResponse part 转成
      //   "[Tool result for <name>]: <body>" 文本标记，模型据此续答。
      //   OpenAI 侧 name 在 tool_call_id / name 字段上，取不到则用通用名。
      const tName = msg?.name || msg?.tool_call_id || "tool";
      const raw = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content ?? "");
      contents.push({
        role: "user",
        parts: [{ text: `[Tool result for ${tName}]: ${raw}` }],
      });
    } else {
      contents.push({ role: role === "assistant" ? "model" : "user", parts });
    }
  }

  // Gemini 要求 contents 非空；纯 system 场景补一条空 user 占位
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "hi" }] });

  const out = { contents };
  if (systemParts.length) out.systemInstruction = { parts: systemParts };

  // ★ 工具声明：OpenAI → Gemini。转成原生形态后由原生侧统一做 prompt 仿真，
  //   桥不重复实现那套逻辑（保持与原生链路逐字一致）。
  const gTools = toGeminiTools(body?.tools);
  if (gTools.length) out.tools = gTools;
  const gToolCfg = toGeminiToolConfig(body?.tool_choice);
  if (gToolCfg) out.toolConfig = gToolCfg;

  const gc = {};
  if (typeof body?.temperature === "number") gc.temperature = body.temperature;
  if (typeof body?.top_p === "number") gc.topP = body.top_p;
  if (typeof body?.max_tokens === "number") gc.maxOutputTokens = body.max_tokens;
  // 思考强度：兼容 OpenAI 侧的 reasoning_effort 与原生 thinkingConfig
  const eff = body?.reasoning_effort ?? body?.thinkingConfig?.thinkingLevel;
  if (eff) gc.thinkingConfig = { thinkingLevel: String(eff) };
  if (Object.keys(gc).length) out.generationConfig = gc;

  return out;
}

/** OpenAI 的 arguments（JSON 字符串）→ Gemini functionCall.args（对象） */
function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  const s = String(raw).trim();
  if (!s) return {};
  try {
    const p = JSON.parse(s);
    return typeof p === "object" && p !== null ? p : { value: p };
  } catch {
    return { value: raw };
  }
}

/* ───────────────────── OpenAI tools → Gemini tools ───────────────────── */

/**
 * OpenAI 的 tools/function_call → Gemini 的 tools/functionDeclarations。
 *
 * ★ 为什么必须转：Robin 私有协议没有独立的工具声明通道，原生侧靠
 *   lib/toolcall.js 做「prompt 仿真」（把声明序列化进提示词，再从模型
 *   输出里解析 ```function_call 围栏回填）。若桥把 tools 直接丢掉，
 *   模型会**静默凭自身知识编造答案**（实测问"北京天气"→编造 15°C 多云，
 *   functionCall=0，全程无报错）——静默错误比响亮失败危险得多。
 *
 * OpenAI 形态有两种：
 *   新式：{ type:"function", function:{ name, description, parameters } }
 *   旧式：{ name, description, parameters }（直接平铺在 tool 上）
 */
function toGeminiTools(tools) {
  const decls = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = t?.type === "function" || t?.function ? t.function : t;
    if (!fn?.name) continue;
    const d = { name: fn.name, description: fn.description ?? "" };
    const params = fn.parameters ?? fn.parametersJsonSchema;
    if (params) d.parameters = params;
    decls.push(d);
  }
  return decls.length ? [{ functionDeclarations: decls }] : [];
}

/**
 * OpenAI 的 tool_choice → Gemini 的 toolConfig。
 * · "none"            → mode: NONE
 * · "required"/"any"  → mode: ANY
 * · {type:"function",function:{name}} → mode: ANY + 白名单
 * · "auto"/缺省       → AUTO（原生侧默认）
 */
function toGeminiToolConfig(toolChoice) {
  if (toolChoice == null) return null;
  if (typeof toolChoice === "string") {
    const v = toolChoice.toLowerCase();
    if (v === "none") return { functionCallingConfig: { mode: "NONE" } };
    if (v === "required" || v === "any") return { functionCallingConfig: { mode: "ANY" } };
    return null; // auto：原生侧默认 AUTO
  }
  const name = toolChoice?.function?.name ?? toolChoice?.name;
  if (name) {
    return {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] },
    };
  }
  return null;
}

/** Gemini 响应 → OpenAI choices[] */
function geminiToOpenAI(gem, model) {
  const cand = gem?.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const content = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
  const u = gem?.usageMetadata ?? {};

  // ★ functionCall part → OpenAI tool_calls。
  //   原生侧（lib/app.js）已把模型输出的 ```function_call 围栏解析回填为
  //   functionCall part，桥只需翻译成 OpenAI 的 tool_calls 结构。
  const toolCalls = [];
  for (const p of parts) {
    const fc = p?.functionCall ?? p?.function_call;
    if (!fc?.name) continue;
    toolCalls.push({
      id: `call_${Math.random().toString(36).slice(2, 12)}`,
      type: "function",
      function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
    });
  }

  const message = { role: "assistant", content };
  if (toolCalls.length) {
    message.content = content || null; // OpenAI 规范：有 tool_calls 时 content 可为 null
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModel(model),
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : (FINISH_MAP[cand?.finishReason] ?? "stop"),
      },
    ],
    usage: {
      prompt_tokens: u.promptTokenCount ?? 0,
      completion_tokens: u.candidatesTokenCount ?? 0,
      total_tokens: u.totalTokenCount ?? 0,
    },
  };
}

/* ─────────────────────────── 调用上游 ─────────────────────────── */

/** 非流式调用（带空响应重试） */
async function callUpstream(model, body) {
  const url = `${UPSTREAM}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let attempt = 0;
  let last = null;

  while (attempt <= EMPTY_RETRY) {
    attempt++;
    const headers = { "content-type": "application/json" };
    if (UPSTREAM_KEY) headers["x-goog-api-key"] = UPSTREAM_KEY;

    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    last = { status: r.status, json: j };

    if (!r.ok) return last; // 上游明确报错，不重试

    const parts = j?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p?.text ?? "").join("");
    // ★ 只有「既无正文、又无 functionCall」才算空响应。
    //   工具模式下模型只返回 functionCall part 而 text 为空——那是正常应答，
    //   若按空正文判定就会白白重试（把真正的工具调用当抖动丢掉）。
    const hasToolCall = parts.some((p) => p?.functionCall ?? p?.function_call);
    if (text.trim() || hasToolCall) return last;
    // 空正文：上游抖动（实测 1/3 左右概率）。必须带延迟重试——
    // 立刻重试会打在同一个坏后端上，等于没重试。
    if (attempt <= EMPTY_RETRY) await sleep(EMPTY_RETRY_DELAY_MS);
  }
  return last;
}

/* ─────────────────────────── GET /v1/models ─────────────────────────── */

let modelCache = { at: 0, data: null };
const MODEL_TTL = 60_000;

/**
 * 拉取上游模型列表并转成 OpenAI 格式。
 * ⚠️ 上游不可达时**不返回空列表**——那会让客户端误以为"没有模型"，
 *    健康检查也会假阳性通过。宁可抛错返回 502。
 */
async function listModels() {
  if (modelCache.data && Date.now() - modelCache.at < MODEL_TTL) return modelCache.data;

  // 上游的 /v1beta/models 同样受 PROXY_API_KEY 保护，必须带凭据
  const headers = {};
  if (UPSTREAM_KEY) headers["x-goog-api-key"] = UPSTREAM_KEY;

  let r;
  try {
    r = await fetch(`${UPSTREAM}/v1beta/models`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (modelCache.data) {
      console.warn(`[openai-shim] 上游不可达（${err?.message}），返回过期缓存`);
      return modelCache.data;
    }
    throw new Error(`上游不可达：${err?.message}（UPSTREAM=${UPSTREAM}）`);
  }
  if (!r.ok) throw new Error(`上游返回 HTTP ${r.status}`);

  const j = await r.json().catch(() => ({}));
  const data = (j?.models ?? []).map((m) => ({
    id: String(m.name ?? "").replace(/^models\//, ""),
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "summeretto",
  }));
  modelCache = { at: Date.now(), data };
  return data;
}

/* ─────────────────────────── 流式转发 ─────────────────────────── */

async function streamChat(req, res, model, body) {
  const url = `${UPSTREAM}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const headers = { "content-type": "application/json" };
  if (UPSTREAM_KEY) headers["x-goog-api-key"] = UPSTREAM_KEY;

  const up = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!up.ok || !up.body) {
    const j = await up.json().catch(() => ({}));
    return sendErr(res, up.status || 502, j?.error?.message ?? "上游流式请求失败", "upstream_error");
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  const id = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const emit = (delta, finish = null) => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model: normalizeModel(model),
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  emit({ role: "assistant", content: "" }); // OpenAI 惯例：先发一个只带 role 的首块

  const reader = up.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let closed = false;
  let sawToolCall = false; // 本次流里是否出现过 functionCall（决定 finish_reason）

  try {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE 以空行分帧
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let j;
          try {
            j = JSON.parse(raw);
          } catch {
            continue;
          }
          const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
          if (text) emit({ content: text });
          // ★ 流式里的 functionCall part → OpenAI tool_calls delta
          const fcs = (j?.candidates?.[0]?.content?.parts ?? [])
            .filter((p) => p?.functionCall ?? p?.function_call)
            .map((p) => {
              const fc = p.functionCall ?? p.function_call;
              return {
                index: 0,
                id: `call_${Math.random().toString(36).slice(2, 12)}`,
                type: "function",
                function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
              };
            });
          if (fcs.length) {
            sawToolCall = true;
            emit({ tool_calls: fcs });
          }
          const fr = j?.candidates?.[0]?.finishReason;
          if (fr) {
            // ★ 用累积标志而非本帧的 fcs：functionCall 在前帧、finishReason 在后帧时，
            //   本帧 fcs 为空，会把 finish_reason 误报成 stop。
            emit({}, sawToolCall ? "tool_calls" : (FINISH_MAP[fr] ?? "stop"));
            closed = true;
          }
        }
      }
    }
  } catch (err) {
    emit({}, "stop");
  }

  if (!closed) emit({}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

/* ───────────────────────────── 路由 ───────────────────────────── */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  // 客户端出示的凭据（仅用于校验客户端身份，不透传给上游）
  const clientKey =
    req.headers["x-goog-api-key"] ??
    String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") ??
    "";

  if (req.method === "OPTIONS") {
    res.writeHead(204, H);
    return res.end();
  }

  // ── 客户端鉴权 ──
  // CLIENT_KEY 留空 = 不校验（单机自用）；设置后必须出示匹配的凭据。
  // /healthz 不参与鉴权：它是容器健康检查与诊断入口。
  if (CLIENT_KEY && path !== "/healthz" && clientKey !== CLIENT_KEY) {
    return sendErr(res, 401, "API key missing or invalid", "authentication_error");
  }

  try {
    // ── GET /v1/models ──
    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      const data = await listModels();
      return sendJson(res, 200, { object: "list", data });
    }

    // ── GET /healthz（诊断直通）──
    if (req.method === "GET" && path === "/healthz") {
      const r = await fetch(`${UPSTREAM}/healthz`);
      return sendJson(res, r.status, await r.json());
    }

    // ── POST /v1/chat/completions ──
    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return sendErr(res, 400, "请求体不是合法 JSON");
      }

      const model = normalizeModel(body?.model);
      const geminiBody = toGeminiBody(body);

      if (body?.stream) return await streamChat(req, res, model, geminiBody);

      const { status, json } = await callUpstream(model, geminiBody);
      if (status !== 200) {
        return sendErr(res, status, json?.error?.message ?? "上游调用失败", "upstream_error");
      }
      return sendJson(res, 200, geminiToOpenAI(json, model));
    }

    // ── 兜底 ──
    return sendErr(res, 404, `未知路由：${req.method} ${path}`);
  } catch (err) {
    return sendErr(res, 502, `转换桥异常：${err?.message}`, "upstream_error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[openai-shim] 已启动  http://${HOST}:${PORT}/v1`);
  console.log(`[openai-shim] 上游    ${UPSTREAM}（Gemini 原生）`);
  console.log(`[openai-shim] 空响应重试 ${EMPTY_RETRY} 次`);
  console.log(
    `[openai-shim] 鉴权    客户端 ${CLIENT_KEY ? "已开启（需携带 API Key）" : "未开启（任何人可调用）"}`,
  );
  console.log(
    `[openai-shim] 上游凭据 ${UPSTREAM_KEY ? "已配置（UPSTREAM_KEY）" : "未配置（上游应无鉴权）"}`,
  );
  console.log(`[openai-shim] 客户端 Base URL 填： http://${HOST}:${PORT}/v1`);
});