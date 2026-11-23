// service/test/shim-auth.mjs — OpenAI 兼容桥的鉴权回归测试
//
// 覆盖三件事：
//   ① 上游开了 PROXY_API_KEY 时，桥必须自带 UPSTREAM_KEY 才能打通
//      （回归：桥原先把客户端的 key 透传给上游，客户端乱填就会被 401 打回）
//   ② 桥对客户端要求 CLIENT_KEY 时，缺 key / 错 key 必须 401
//   ③ 上游的 /v1beta/models 也受保护，桥拉模型列表必须带凭据
//
// 跑法：node test/shim-auth.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  [pass] ${m}`);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, "..", "openai-shim.mjs");

const UPSTREAM_KEY = "upstream-secret-key-for-test";
const CLIENT_KEY = "client-secret-key-for-test";

/* ── 假上游：模拟开了 PROXY_API_KEY 的主服务 ── */
const upstream = createServer((req, res) => {
  const key = req.headers["x-goog-api-key"] ?? "";
  if (key !== UPSTREAM_KEY) {
    const body = JSON.stringify({ error: { code: 401, message: "API key missing or invalid" } });
    res.writeHead(401, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
    return;
  }
  const body = JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: "PONG" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
  res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
  res.end(body);
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

/* ── 起桥 ── */
const shimPort = 19000 + (process.pid % 2000);
const child = spawn(process.execPath, [SHIM], {
  env: {
    ...process.env,
    SHIM_HOST: "127.0.0.1",
    SHIM_PORT: String(shimPort),
    UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    UPSTREAM_KEY,
    CLIENT_KEY,
    EMPTY_RETRY: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.on("data", (d) => process.stderr.write(`[shim] ${d}`));

// 等桥起来
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://127.0.0.1:${shimPort}/healthz`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
const base = `http://127.0.0.1:${shimPort}`;
ok(`桥已启动 ${base}（假上游 :${upstreamPort} 已开启鉴权）`);

const chat = (headers) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "ping" }] }),
  });

try {
  /* ① 客户端无 key → 401 */
  {
    const r = await chat({});
    assert.equal(r.status, 401, `桥应拒绝无 key 的客户端，实际 ${r.status}`);
    ok("① 客户端无 key → 401");
  }

  /* ② 客户端错 key → 401 */
  {
    const r = await chat({ "x-goog-api-key": "wrong-client-key" });
    assert.equal(r.status, 401, `桥应拒绝错误 key，实际 ${r.status}`);
    ok("② 客户端错 key → 401");
  }

  /* ③ 客户端 key 正确 → 桥用 UPSTREAM_KEY 打通上游 → 200 */
  {
    const r = await chat({ "x-goog-api-key": CLIENT_KEY });
    assert.equal(r.status, 200, `桥应凭 UPSTREAM_KEY 打通上游，实际 ${r.status}`);
    const j = await r.json();
    assert.equal(j.object, "chat.completion");
    assert.equal(j.choices?.[0]?.message?.content, "PONG");
    ok("③ 客户端 key 正确 → 桥用 UPSTREAM_KEY 打通上游 → 200");
  }

  /* ④ Authorization: Bearer 也接受 */
  {
    const r = await chat({ authorization: `Bearer ${CLIENT_KEY}` });
    assert.equal(r.status, 200, `Bearer 形式应被接受，实际 ${r.status}`);
    ok("④ Authorization: Bearer 形式同样被接受");
  }

  /* ⑤ /v1/models 也要 CLIENT_KEY */
  {
    const r0 = await fetch(`${base}/v1/models`);
    assert.equal(r0.status, 401, `/v1/models 无 key 应 401，实际 ${r0.status}`);
    const r1 = await fetch(`${base}/v1/models`, { headers: { "x-goog-api-key": CLIENT_KEY } });
    assert.equal(r1.status, 200, `/v1/models 带 key 应 200，实际 ${r1.status}`);
    ok("⑤ /v1/models 同样受 CLIENT_KEY 保护");
  }
} finally {
  child.kill();
  upstream.close();
  rmSync(mkdtempSync(path.join(os.tmpdir(), "shim-auth-")), { recursive: true, force: true });
}

console.log(`\n全部通过：${n} 组断言`);
process.exit(0);
