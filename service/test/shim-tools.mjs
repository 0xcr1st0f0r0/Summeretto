// service/test/shim-tools.mjs — OpenAI 兼容桥的工具调用（function calling）回归测试
//
// 背景：Robin 私有协议没有独立的工具声明通道，原生侧靠 lib/toolcall.js 做
//   「prompt 仿真」——把工具声明序列化进提示词，再从模型输出的
//   ```function_call 围栏解析回填成 functionCall part。
//
// ★ 桥原先把 OpenAI 的 tools 直接丢弃 ⇒ 模型凭自身知识编造答案
//   （实测问"北京天气"→编造 15°C 多云，functionCall=0，全程无报错）。
//   静默错误比响亮失败危险得多，故必须转。
//
// 本测试覆盖：
//   ① 请求侧：OpenAI tools → Gemini tools/functionDeclarations（与原生逐字一致）
//   ② 请求侧：tool_choice（none / required / 指定函数）→ Gemini toolConfig
//   ③ 历史侧：assistant.tool_calls → functionCall part；role:tool → [Tool result for X]
//   ④ 响应侧：原生 functionCall part → OpenAI tool_calls（非流式 + 流式）
//   ⑤ 只有 functionCall、没有正文的响应【不是】空响应（不该触发重试）
//
// 跑法：node test/shim-tools.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpServer } from "node:http2";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GrpcFrameDecoder, grpcFrame } from "../lib/wire.js";
import { buildServerFrame } from "./mock-robin.mjs";

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  [pass] ${m}`);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, "..", "openai-shim.mjs");

/* ── 假上游（h2c）：模拟真实上游返回带 function_call 围栏的模型输出 ── */
const upstream = createHttpServer();
let upstreamCalls = 0; // 只统计 ProcessQuery（真正的推理调用）
let statusCalls = 0; // GetUserStatus（拉档位表，与本测试无关）
upstream.on("stream", (stream, headers) => {
  const dec = new GrpcFrameDecoder();
  let replied = false;
  stream.on("data", (c) => {
    const frames = dec.push(c);
    if (!frames.length || replied) return;
    replied = true;
    const isQuery = String(headers[":path"] ?? "").endsWith("/ProcessQuery");
    if (isQuery) upstreamCalls++;
    else statusCalls++;
    const reply = buildServerFrame(
      '```function_call\n{"name":"get_weather","args":{"city":"北京"}}\n```',
    );
    stream.respond({ ":status": 200, "content-type": "application/grpc+proto" });
    stream.end(grpcFrame(reply));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

/* ── 起原生服务（指向假上游）── */
process.env.ROBIN_URL = `http://127.0.0.1:${upstreamPort}`;
process.env.PROXY_API_KEY = "";
process.env.NODE_ENV = "test";
// ★ 关掉原生侧的空响应重试：本测试只关心「桥自身是否把 functionCall 响应
//   当成空响应重发」。原生侧的重试是独立机制（ROBIN_EMPTY_RETRY），
//   若开着会多打一次上游，干扰上游调用次数的断言。
process.env.ROBIN_EMPTY_RETRY = "0";
const { handle } = await import("../lib/app.js");
const app = createServer((req, res) => {
  handle(req, res).catch(() => {});
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.address().port}`;

/* ── 起桥 ── */
const shimPort = 19100 + (process.pid % 500);
const child = spawn(process.execPath, [SHIM], {
  env: {
    ...process.env,
    SHIM_HOST: "127.0.0.1",
    SHIM_PORT: String(shimPort),
    UPSTREAM: base,
    EMPTY_RETRY: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[shim] ${d}`));
for (let i = 0; i < 60; i++) {
  try {
    await fetch(`http://127.0.0.1:${shimPort}/healthz`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const shim = `http://127.0.0.1:${shimPort}`;
ok(`桥已启动 ${shim}（假上游 :${upstreamPort}）`);

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "查询天气",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

const chat = (payload) =>
  fetch(`${shim}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

try {
  /* ① 非流式：原生 functionCall → OpenAI tool_calls */
  {
    const r = await chat({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: `北京天气怎么样？#nonstream-${Date.now()}` }],
      tools: TOOLS,
    });
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}`);
    const j = await r.json();
    const msg = j.choices?.[0]?.message;
    assert.ok(msg, "应返回 message");
    assert.ok(Array.isArray(msg.tool_calls), "应返回 tool_calls 数组");
    assert.equal(msg.tool_calls.length, 1, "应有 1 个 tool_call");
    assert.equal(msg.tool_calls[0].type, "function");
    assert.equal(msg.tool_calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: "北京" });
    assert.equal(j.choices[0].finish_reason, "tool_calls", "finish_reason 应为 tool_calls");
    ok("① 非流式：原生 functionCall → OpenAI tool_calls");
  }

  /* ② 流式：functionCall → tool_calls delta + finish_reason=tool_calls */
  {
    const r = await chat({
      model: "gemini-2.0-flash",
      stream: true,
      messages: [{ role: "user", content: `北京天气怎么样？#stream-${Date.now()}` }],
      tools: TOOLS,
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    const lines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l && l !== "[DONE]")
      .map((l) => JSON.parse(l));
    const withCalls = lines.filter((l) => l.choices?.[0]?.delta?.tool_calls?.length);
    assert.ok(withCalls.length >= 1, "流式应至少有一帧带 tool_calls");
    const tc = withCalls[0].choices[0].delta.tool_calls[0];
    assert.equal(tc.type, "function");
    assert.equal(tc.function.name, "get_weather");
    assert.deepEqual(JSON.parse(tc.function.arguments), { city: "北京" });
    const last = lines[lines.length - 1];
    assert.equal(
      last.choices?.[0]?.finish_reason,
      "tool_calls",
      "流式 finish_reason 应为 tool_calls（functionCall 在前帧时不能误报 stop）",
    );
    ok("② 流式：functionCall → tool_calls delta，finish_reason=tool_calls");
  }

  /* ③ 只有 functionCall、无正文的响应不该被当成「空响应」重试
   *     ⚠️ 两个坑：
   *       a) 必须用【每次不同】的 prompt —— 主服务有 90s dedup 缓存，
   *          相同 prompt 会命中缓存直接重放上次结果 → 测不到真实调用次数。
   *       b) 只数 ProcessQuery —— 每次请求还会附带一次 GetUserStatus
   *          （拉档位表，mock 下不缓存），那是无关调用，不能算进重试次数。 */
  {
    const before = upstreamCalls;
    await chat({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: `北京天气怎么样？#${Date.now()}` }],
      tools: TOOLS,
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(upstreamCalls, before + 1, "有 functionCall 的响应不该触发空响应重试");
    ok("③ 只有 functionCall、无正文 → 不触发空响应重试");
  }

  /* ④ 请求侧：OpenAI tools 必须转成 Gemini functionDeclarations
   *     （对照原生链路发的 body 是否含 tools） */
  {
    const seen = [];
    const spy = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (raw) seen.push(JSON.parse(raw));
        const b = JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(b),
        });
        res.end(b);
      });
    });
    await new Promise((r) => spy.listen(0, "127.0.0.1", r));
    const spyPort = spy.address().port;

    const spyShimPort = shimPort + 1;
    const spyChild = spawn(process.execPath, [SHIM], {
      env: {
        ...process.env,
        SHIM_HOST: "127.0.0.1",
        SHIM_PORT: String(spyShimPort),
        UPSTREAM: `http://127.0.0.1:${spyPort}`,
        EMPTY_RETRY: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`http://127.0.0.1:${spyShimPort}/healthz`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await fetch(`http://127.0.0.1:${spyShimPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "北京天气" }],
        tools: TOOLS,
      }),
    });
    await new Promise((r) => setTimeout(r, 200));

    const body = seen[seen.length - 1];
    assert.ok(body?.tools, "桥发给上游的 body 应含 tools");
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].functionDeclarations[0].name, "get_weather");
    assert.equal(body.tools[0].functionDeclarations[0].description, "查询天气");
    assert.ok(body.tools[0].functionDeclarations[0].parameters, "应保留 parameters");
    ok("④ 请求侧：OpenAI tools → Gemini tools/functionDeclarations");

    /* ⑤ tool_choice 映射 */
    await fetch(`http://127.0.0.1:${spyShimPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: TOOLS,
        tool_choice: "none",
      }),
    });
    await new Promise((r) => setTimeout(r, 200));
    const b2 = seen[seen.length - 1];
    assert.equal(b2?.toolConfig?.functionCallingConfig?.mode, "NONE", "tool_choice=none → mode NONE");

    await fetch(`http://127.0.0.1:${spyShimPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "hi" }],
        tools: TOOLS,
        tool_choice: { type: "function", function: { name: "get_weather" } },
      }),
    });
    await new Promise((r) => setTimeout(r, 200));
    const b3 = seen[seen.length - 1];
    assert.equal(b3?.toolConfig?.functionCallingConfig?.mode, "ANY", "指定函数 → mode ANY");
    assert.deepEqual(
      b3?.toolConfig?.functionCallingConfig?.allowedFunctionNames,
      ["get_weather"],
      "指定函数 → 白名单",
    );
    ok("⑤ tool_choice 映射：none → NONE，指定函数 → ANY + 白名单");

    /* ⑥ 历史侧：assistant.tool_calls 与 role:tool */
    await fetch(`http://127.0.0.1:${spyShimPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.0-flash",
        messages: [
          { role: "user", content: "北京天气" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp":25}' },
        ],
        tools: TOOLS,
      }),
    });
    await new Promise((r) => setTimeout(r, 200));
    const b4 = seen[seen.length - 1];
    const modelMsg = b4?.contents?.find((c) => c.role === "model");
    assert.ok(modelMsg, "历史里应有 role=model 的 assistant 回合");
    assert.equal(modelMsg.parts[0]?.functionCall?.name, "get_weather", "assistant.tool_calls → functionCall part");
    assert.deepEqual(modelMsg.parts[0].functionCall.args, { city: "北京" });
    const toolMsg = b4?.contents?.find((c) =>
      c.parts?.some((p) => typeof p.text === "string" && p.text.includes("[Tool result for")),
    );
    assert.ok(toolMsg, "role:tool 应转成 [Tool result for ...] 文本标记");
    assert.ok(
      toolMsg.parts[0].text.includes("get_weather") && toolMsg.parts[0].text.includes("25"),
      "工具结果应含工具名与内容",
    );
    ok("⑥ 历史侧：assistant.tool_calls → functionCall part；role:tool → 工具结果标记");

    spyChild.kill();
    spy.close();
  }
} finally {
  child.kill();
  upstream.close();
  app.close();
}

console.log(`\n全部通过：${n} 组断言`);
process.exit(0);
