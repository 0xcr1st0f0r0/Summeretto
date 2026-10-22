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
    const parts = toParts(msg?.content);
    if (!parts.length) continue;

    if (role === "system" || role === "developer") {
      systemParts.push(...parts);
    } else if (role === "tool" || role === "function") {
      contents.push({ role: "user", parts });
    } else {
      contents.push({ role: role === "assistant" ? "model" : "user", parts });
    }
  }

  // Gemini 要求 contents 非空；纯 system 场景补一条空 user 占位
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "hi" }] });

  const out = { contents };
  if (systemParts.length) out.systemInstruction = { parts: systemParts };

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

/** Gemini 响应 → OpenAI choices[] */
function geminiToOpenAI(gem, model) {
  const cand = gem?.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const content = parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
  const u = gem?.usageMetadata ?? {};
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: normalizeModel(model),
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: FINISH_MAP[cand?.finishReason] ?? "stop",
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
async function callUpstream(model, body, apiKey) {
  const url = `${UPSTREAM}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let attempt = 0;
  let last = null;

  while (attempt <= EMPTY_RETRY) {
    attempt++;
    const headers = { "content-type": "application/json" };
    if (apiKey) headers["x-goog-api-key"] = apiKey;

    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    last = { status: r.status, json: j };

    if (!r.ok) return last; // 上游明确报错，不重试

    const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
    if (text.trim()) return last;
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

  let r;
  try {
    r = await fetch(`${UPSTREAM}/v1beta/models`, { signal: AbortSignal.timeout(8000) });
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

async function streamChat(req, res, model, body, apiKey) {
  const url = `${UPSTREAM}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const headers = { "content-type": "application/json" };
  if (apiKey) headers["x-goog-api-key"] = apiKey;

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
          const fr = j?.candidates?.[0]?.finishReason;
          if (fr) {
            emit({}, FINISH_MAP[fr] ?? "stop");
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
  const apiKey =
    req.headers["x-goog-api-key"] ??
    String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") ??
    "";

  if (req.method === "OPTIONS") {
    res.writeHead(204, H);
    return res.end();
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

      if (body?.stream) return await streamChat(req, res, model, geminiBody, apiKey);

      const { status, json } = await callUpstream(model, geminiBody, apiKey);
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
  console.log(`[openai-shim] 客户端 Base URL 填： http://${HOST}:${PORT}/v1`);
});