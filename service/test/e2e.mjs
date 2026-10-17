// service/test/e2e.mjs — 端到端离线测试：mock Robin（h2c）+ 真实 HTTP 服务
//
// 链路：Gemini 请求 → geminiToRobin → buildProcessQueryRequest → node:http2 gRPC
//       → mock 服务端 → Lgcxk 响应帧 → 解析 → Gemini 响应/SSE
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMockRobin } from "./mock-robin.mjs";
import { fieldOne, fieldAll, asString, asUint } from "../lib/wire.js";

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  [pass] ${m}`);
};

// ① 起 mock Robin（h2c）
const { server: mockServer, port: mockPort, seen } = await startMockRobin({});
ok(`mock Robin 已启动 :${mockPort}`);

// ② 设置环境（必须在 import app 之前）
process.env.ROBIN_URL = `http://127.0.0.1:${mockPort}`;
process.env.PROXY_API_KEY = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "e2e-admin-key";
// 限流是防扫薅的 best-effort 机制，e2e 不测它（整套跑下来请求数本就逼近 30/min 默认值，
// 会把正常用例误判成 429）。这里显式放开，专注验证去重/重试/降级等逻辑本身。
process.env.RATE_LIMIT_MAX = "100000";

const { handle } = await import("../lib/app.js");
const { guardStatus, __resetGuardForTest } = await import("../lib/degrade-guard.js");
const { ffmpegAvailable } = await import("../lib/mediashim.js");
const app = createServer((req, res) => {
  handle(req, res).catch(() => {});
});
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.address().port}`;
ok(`服务已启动 ${base}`);

/* ── 1. 非流式 generateContent ── */
{
  const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "你好世界" }] }] }),
  });
  assert.equal(r.status, 200, `期望 200，实际 ${r.status}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  assert.ok(text.includes("你好世界"), `响应应回显请求文本，实际：${text}`);
  assert.equal(j.candidates[0].finishReason, "STOP");
  ok("非流式 generateContent：200 + 回显文本 + STOP");
  assert.equal(seen.lastText, "你好世界", "mock 收到的请求文本应正确");
  ok("mock 服务端正确解析 Lgcww.#1 用户文本");
}

/* ── 2. 流式 streamGenerateContent（SSE）─ */
{
  const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "流式测试" }] }] }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const body = await r.text();
  const deltaText = body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6))?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      } catch {
        return "";
      }
    })
    .join("");
  assert.ok(deltaText.includes("流式测试"), `SSE 拼接文本应含请求文本，实际：${deltaText}`);
  ok("流式 SSE：多 chunk 拼出完整回复");
}

/* ── 3. inlineData（附件）不崩 ── */
{
  const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: "看图" },
            { inlineData: { mimeType: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") } },
          ],
        },
      ],
    }),
  });
  assert.equal(r.status, 200, "带附件请求应成功（附件字段结构见 pq.js）");
  ok("inlineData 附件路径：请求成功构造并送达 mock");
  // ★ 2026-10-15：mock 模式用占位 blobId，信封结构（Lgbkn.#3 Lgbku）应到达 mock
  assert.equal(seen.lastAttachments.length, 1, "mock 应收到 1 个 Lgbku 附件");
  const kuBytes = seen.lastAttachments[0];
  const kr = kuBytes && fieldOne(kuBytes, 1);
  assert.ok(kr, "Lgbku.#1 Lgbkr 应存在");
  const blobIdF = kr && fieldOne(kr.value, 1);
  assert.ok(blobIdF && String(asString(blobIdF.value)).startsWith("/contrib_service/ttl_1d/mock_"),
    `Lgbkr.#1 应为占位 blobId，实际：${blobIdF && asString(blobIdF.value)}`);
  ok("附件信封结构到达 mock：Lgbkn.#3 Lgbku{#1 Lgbkr{#1 blobId}}");
}

/* ── 3b. ★ 思考强度：Lfzqy.#48 送达上游（2026-10-16 逆向+实测打通）──
 * 承载位取证见 lib/modes.js「思考强度」章节；真机值 Low=1/Medium=4/High=2。
 * 本组验证三种传参写法都能落到 [ext1001].Lgcvb.#1 Lfzqy.#48。 */
const levelOf = () => {
  const f = seen.lastEnvelope && seen.lastEnvelope.find((x) => x.no === 48);
  return f ? Number(asUint(f.value)) : null;
};
{
  const post = (model, body) =>
    fetch(`${base}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // 3b.1 显式 thinkingConfig（无附件 → 纯档位信封）
  const r1 = await post("gemini-2.0-flash", {
    contents: [{ role: "user", parts: [{ text: "A" }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: "high" } },
  });
  assert.equal(r1.status, 200);
  assert.equal(levelOf(), 2, `thinkingConfig.thinkingLevel=high 应产出 #48=2，实际 ${levelOf()}`);
  ok("★ thinkingConfig.thinkingLevel=high → Lfzqy.#48=2 送达上游");

  // 3b.2 snake_case / 简写形式
  const r2 = await post("gemini-2.0-flash", {
    contents: [{ role: "user", parts: [{ text: "A" }] }],
    generation_config: { thinking_config: { thinking_level: "medium" } },
  });
  assert.equal(r2.status, 200);
  assert.equal(levelOf(), 4, `snake_case medium 应产出 #48=4，实际 ${levelOf()}`);
  ok("★ snake_case thinking_config.thinking_level=medium → #48=4");

  // 3b.3 模型名后缀写法（无需任何 generationConfig）
  //   ⚠️ 回归护栏：曾因 suffix 分支漏 await 导致「档位对了、模型档位静默丢失」
  //      （Promise truthy 让 modeInfo.modeId 变 undefined）→ 这里必须同时断言两个维度。
  const r3 = await post("4-argon-low", { contents: [{ role: "user", parts: [{ text: "A" }] }] });
  assert.equal(r3.status, 200);
  assert.equal(levelOf(), 1, `模型名 4-argon-low 应产出 #48=1，实际 ${levelOf()}`);
  assert.equal(seen.lastModeId, "95a4c0abcba24364",
    `后缀写法必须【同时】保住模型档位 Lgauy.#16，实际 ${seen.lastModeId}`);
  // ★ 承载位不变式（2026-10-17 实测修正，推翻旧 §5.14）：无音频时档位必须由
  //   `Lgcvm.#1` 承载才生效 —— 放 `Lfzqy.#13` 会被服务端整包忽略，
  //   表现为静默降级（实测恒回 `Used 3.5 Flash-Lite model`、rank 6）。
  assert.deepEqual(
    seen.lastModeCarriers,
    { field1: "95a4c0abcba24364", envelope: null },
    `无音频时档位必须由 Lgcvm.#1 承载（放 #13 会被整包忽略 ⇒ 静默降级），实际 ${JSON.stringify(seen.lastModeCarriers)}`,
  );
  ok("★ 模型名后缀 4-argon-low → #48=1 且档位由 Lgcvm.#1 承载（双维度）");

  // 3b.3b 无后缀模型名同样要写档位；此时无信封，应由 Lgcvm.#1 承载
  {
    const r = await post("4-argon", { contents: [{ role: "user", parts: [{ text: "A" }] }] });
    assert.equal(r.status, 200);
    assert.equal(seen.lastModeId, "95a4c0abcba24364", `4-argon 应写 Lgauy.#16，实际 ${seen.lastModeId}`);
    assert.equal(levelOf(), null, "无后缀且无参数时不应写 #48");
    assert.deepEqual(
      seen.lastModeCarriers,
      { field1: "95a4c0abcba24364", envelope: null },
      `无信封时档位应由 #1 承载，实际 ${JSON.stringify(seen.lastModeCarriers)}`,
    );
    ok("4-argon（无后缀）→ 无信封，#16 由 Lgcvm.#1 承载且不发 #48");
  }

  // 3b.3c 后缀 base 无法识别 → 回退完整名解析（不因后缀而丢档位）
  {
    const r = await post("4-argon-ultra-high", { contents: [{ role: "user", parts: [{ text: "A" }] }] });
    assert.equal(r.status, 200);
    // base = "4-argon-ultra" 不可识别 → 回退用完整名 "4-argon-ultra-high" 解析（也应 miss）
    // 关键断言：不能因为「后缀匹配成功」就误设档位而丢掉 base 解析
    assert.equal(levelOf(), null, "base 不可识别时不应设置档位");
    ok("后缀 base 不可识别 → 回退完整名解析（不误设档位）");
  }

  // 3b.4 未指定 → 不发信封（保持既有最小形态）
  const r4 = await post("gemini-2.0-flash", { contents: [{ role: "user", parts: [{ text: "A" }] }] });
  assert.equal(r4.status, 200);
  assert.equal(levelOf(), null, "未指定思考档位时不应写 #48");
  ok("未指定档位 → 不发 #48（服务端默认 Low）");

  // 3b.5 附件 + 档位共存【同一个】信封（singular 扩展重复设置会互相覆盖）
  const r5 = await post("4-argon-high", {
    contents: [
      {
        role: "user",
        parts: [
          { text: "看图" },
          { inlineData: { mimeType: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") } },
        ],
      },
    ],
  });
  assert.equal(r5.status, 200);
  assert.equal(levelOf(), 2, `附件+档位应共存，实际 ${levelOf()}`);
  assert.equal(seen.lastAttachments.length, 1, "同请求附件也应保留（未被档位挤掉）");
  assert.deepEqual(
    seen.lastModeCarriers,
    { field1: "95a4c0abcba24364", envelope: null },
    `图片附件不得把档位挤出 #1（图片与 Argon 兼容，实测答出颜色），实际 ${JSON.stringify(seen.lastModeCarriers)}`,
  );
  ok("★ 图片附件 + 思考档位共存于同一信封（#1 Lgbkn / #13 Lgauy / #48；档位留在 #1）");

  // 3b.5b ★ 音频附件 → 档位**必须**退让到 Lfzqy.#13
  //   原因：Argon 路径读不到音频附件（实测模型答"没有收到录音文件"），
  //   只有让本轮落到 Flash-Lite 才能"听得到"。退让是刻意的，不是回归。
  const r5b = await post("4-argon-high", {
    contents: [
      {
        role: "user",
        parts: [
          { text: "听声" },
          { inlineData: { mimeType: "audio/webm;codecs=opus", data: Buffer.from([1, 2, 3, 4]).toString("base64") } },
        ],
      },
    ],
  });
  assert.equal(r5b.status, 200);
  assert.equal(levelOf(), 2, `音频+档位应共存，实际 ${levelOf()}`);
  assert.equal(seen.lastAttachments.length, 1, "音频附件应保留（未被档位挤掉）");
  assert.deepEqual(
    seen.lastModeCarriers,
    { field1: null, envelope: "95a4c0abcba24364" },
    `音频场景档位必须退让到 Lfzqy.#13（换取听觉），实际 ${JSON.stringify(seen.lastModeCarriers)}`,
  );
  ok("★ 音频附件 → 档位退让至 Lfzqy.#13（Argon 读不到音频；本轮降级属预期）");

  // 3b.6 非法档位 → 忽略并回落默认（不静默变成其它档位）
  const r6 = await post("gemini-2.0-flash", {
    contents: [{ role: "user", parts: [{ text: "A" }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: "ultra" } },
  });
  assert.equal(r6.status, 200);
  assert.equal(levelOf(), null, "无法识别的档位应被忽略而非误取默认值");
  ok("非法档位 'ultra' → 忽略（不猜测、不误发）");
}

/* ── 4. 未知模型名照常透传 ── */
{
  const r = await fetch(`${base}/v1beta/models/custom-model-x:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "A" }] }] }),
  });
  assert.equal(r.status, 200);
  ok("任意模型名透传（模型选择字段在 Lgauy 待校准）");
}

/* ── 5. 上游 gRPC 错误 → 502 结构化错误 ── */
{
  const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "TRIGGER_ERROR" }] }] }),
  });
  assert.equal(r.status, 502, `上游错误应映射 502，实际 ${r.status}`);
  const j = await r.json();
  assert.equal(j.error?.status, "UNAVAILABLE");
  ok("上游 gRPC 13 → 502 UNAVAILABLE（错误链路）");
}

/* ── 6. countTokens stub ── */
{
  const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:countTokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "12345678" }] }] }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(typeof j.totalTokens === "number");
  ok("countTokens 返回估算值");
}

/* ── 6. 凭证管理端点 /admin/token ── */
{
  // 6.1 无 admin key → 401
  const r1 = await fetch(`${base}/admin/token`);
  assert.equal(r1.status, 401, `无 key 应 401，实际 ${r1.status}`);
  ok("GET /admin/token 无 key → 401");

  // 6.2 错误 admin key → 401
  const r2 = await fetch(`${base}/admin/token`, { headers: { "x-admin-key": "wrong" } });
  assert.equal(r2.status, 401);
  ok("GET /admin/token 错误 key → 401");

  // 6.3 非法 token（不以 ya29. 开头）→ 400
  const r3 = await fetch(`${base}/admin/token`, {
    method: "POST",
    headers: { "x-admin-key": "e2e-admin-key", "content-type": "application/json" },
    body: JSON.stringify({ token: "not-a-token" }),
  });
  assert.equal(r3.status, 400);
  ok("POST /admin/token 非法 token → 400");

  // 6.4 合法注入 → 200，且 status 反映来源/剩余时间
  const fakeTok = "ya29.e2e-fake-token-for-test-0123456789";
  const r4 = await fetch(`${base}/admin/token`, {
    method: "POST",
    headers: { "x-admin-key": "e2e-admin-key", "content-type": "application/json" },
    body: JSON.stringify({ token: fakeTok, expiresIn: 3600, account: "e2e@test" }),
  });
  assert.equal(r4.status, 200);
  const j4 = await r4.json();
  assert.equal(j4.source, "injected");
  assert.equal(j4.account, "e2e@test");
  assert.ok(j4.expiresInSec > 3500 && j4.expiresInSec <= 3600, `expiresInSec=${j4.expiresInSec}`);
  ok("POST /admin/token 合法注入 → 200 injected");

  // 6.5 GET 查询状态 + /healthz 反映已配置
  const g5 = await (await fetch(`${base}/admin/token`, { headers: { "x-admin-key": "e2e-admin-key" } })).json();
  assert.equal(g5.source, "injected");
  assert.ok(String(g5.tokenTail).endsWith("0123456789".slice(-8)));
  const h5 = await (await fetch(`${base}/healthz`)).json();
  assert.ok(String(h5.auth).startsWith("configured (injected"), `healthz.auth=${h5.auth}`);
  ok("GET /admin/token 状态一致 + /healthz 显示 configured(injected)");
}

/* ── 7. 网页登录方案端点 /login + /admin/gpsoauth ── */
{
  // 7.1 /login 页面（此环境已配 ADMIN_KEY → 不应出现"未启用"提示）
  const p = await fetch(`${base}/login`);
  assert.equal(p.status, 200);
  const html = await p.text();
  assert.ok(html.includes("accounts.google.com/EmbeddedSetup"), "/login 应含登录入口");
  assert.ok(!html.includes("绑定端点已禁用"), "已配 ADMIN_KEY 时不应显示禁用提示");
  ok("GET /login → 200 且绑定入口可用");

  // 7.2 无 key → 401
  const r1 = await fetch(`${base}/admin/gpsoauth`);
  assert.equal(r1.status, 401);
  ok("GET /admin/gpsoauth 无 key → 401");

  // 7.3 错误 key → 401
  const r2 = await fetch(`${base}/admin/gpsoauth`, { headers: { "x-admin-key": "wrong" } });
  assert.equal(r2.status, 401);
  ok("GET /admin/gpsoauth 错误 key → 401");

  // 7.4 缺 email / oauthToken → 400（在发网络请求之前就被拦下）
  const r3 = await fetch(`${base}/admin/gpsoauth`, {
    method: "POST",
    headers: { "x-admin-key": "e2e-admin-key", "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.c" }),
  });
  assert.equal(r3.status, 400);
  const j3 = await r3.json();
  assert.ok(String(j3.error?.message ?? "").includes("oauthToken"), JSON.stringify(j3).slice(0, 200));
  ok("POST /admin/gpsoauth 缺 oauthToken → 400（不发网络请求）");

  // 7.5 GET 状态：未被绑定时 bound=false，且字段结构完整
  const g = await (await fetch(`${base}/admin/gpsoauth`, { headers: { "x-admin-key": "e2e-admin-key" } })).json();
  assert.equal(g.gpsoauth.bound, false);
  assert.equal(g.gpsoauth.app, "com.google.android.googlequicksearchbox");
  assert.ok(String(g.gpsoauth.service).startsWith("oauth2:https://www.googleapis.com/auth/assistant"));
  ok("GET /admin/gpsoauth → gpsoauth.bound=false + 服务/app 契约正确");

  // 7.6 未配 master token 时强制 mint → ok:false（不抛异常、不打上游）
  const m = await fetch(`${base}/admin/gpsoauth?action=mint`, {
    method: "POST",
    headers: { "x-admin-key": "e2e-admin-key" },
  });
  assert.equal(m.status, 200);
  const mj = await m.json();
  assert.equal(mj.ok, false, `无 master token 时 mint 应失败，实际 ${JSON.stringify(mj).slice(0, 200)}`);
  assert.equal(mj.minted, false);
  assert.equal(mj.tokenTail, null, "mint 未产出令牌时 tokenTail 必须为 null");
  assert.equal(mj.gpsoauth.bound, false);
  ok("POST /admin/gpsoauth?action=mint 无 master token → 200 {ok:false}");
}

/* ── 8. function calling 兼容层（prompt 仿真，见 lib/toolcall.js）── */
{
  const tools = [
    {
      functionDeclarations: [
        {
          name: "get_weather",
          description: "查询指定城市的实时天气",
          parameters: {
            type: "object",
            properties: { city: { type: "string", description: "城市名" } },
            required: ["city"],
          },
        },
      ],
    },
  ];

  // 8.1 非流式：tools 声明 + mock 回放 function_call 围栏 → 回填 functionCall part
  {
    const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "TRIGGER_TOOLCALL 北京天气怎么样" }] }],
        tools,
      }),
    });
    assert.equal(r.status, 200, `工具请求应成功，实际 ${r.status}`);
    const j = await r.json();
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    const fc = parts.find((p) => p.functionCall);
    assert.ok(fc, `应回填 functionCall part，实际：${JSON.stringify(parts).slice(0, 300)}`);
    assert.equal(fc.functionCall.name, "get_weather");
    assert.equal(fc.functionCall.args?.city, "北京");
    // 围栏原文不得泄给调用方
    const text = parts.map((p) => p.text ?? "").join("");
    assert.ok(!text.includes("function_call") && !text.includes("```"), `围栏泄漏：${text}`);
    ok("非流式 tools：function_call 围栏 → functionCall part 回填（无围栏泄漏）");
    // 请求侧：工具提示词应到达 mock
    assert.ok(String(seen.lastText).includes("# Tool Use"), "工具提示词块应序列化进请求");
    assert.ok(String(seen.lastText).includes("get_weather"), "工具定义应序列化进请求");
    ok("请求侧：工具声明序列化为 # Tool Use 提示词块");
  }

  // 8.2 流式：工具模式下缓冲→解析→输出（SSE 里出现 functionCall chunk，无围栏泄漏）
  {
    const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:streamGenerateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "TRIGGER_TOOLCALL 上海天气" }] }],
        tools,
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.text();
    const chunks = body
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)));
    const fcChunks = chunks.filter((c) => c.candidates?.[0]?.content?.parts?.some((p) => p.functionCall));
    assert.equal(fcChunks.length, 1, `应恰好 1 个 functionCall chunk，实际 ${fcChunks.length}`);
    assert.equal(fcChunks[0].candidates[0].content.parts[0].functionCall.name, "get_weather");
    assert.ok(!body.includes("```function_call"), "SSE 不得泄漏围栏原文");
    ok("流式 tools：缓冲→解析→输出，functionCall chunk 正确且无围栏泄漏");
  }

  // 8.3 工具历史：functionResponse part → [Tool result for …] 文本标记
  {
    const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "HISTORY_MARKER 北京天气怎么样" }] },
          { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "北京" } } }] },
          { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { temp: 15 } } }] },
          { role: "user", parts: [{ text: "HISTORY_MARKER 那穿什么衣服合适" }] },
        ],
        tools,
      }),
    });
    assert.equal(r.status, 200);
    assert.ok(
      String(seen.lastText).includes("[Tool result for get_weather]"),
      "functionResponse 应序列化为 [Tool result for …] 标记",
    );
    assert.ok(
      String(seen.lastText).includes('```function_call\n{"name":"get_weather","args":{"city":"北京"}}'),
      "functionCall 历史应序列化为围栏标记",
    );
    ok("工具历史：functionCall/functionResponse part → 文本标记（保住多轮工具循环）");
  }

  // 8.4 toolConfig 约束：mode=NONE → 提示词含禁工具指令
  {
    const r = await fetch(`${base}/v1beta/models/gemini-2.0-flash:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "CONSTRAINT_MARKER 你好" }] }],
        tools,
        toolConfig: { functionCallingConfig: { mode: "NONE" } },
      }),
    });
    assert.equal(r.status, 200);
    assert.ok(
      String(seen.lastText).includes("Do NOT call any tools"),
      "mode=NONE 应注入禁工具指令",
    );
    ok("toolConfig NONE：注入「不得调用工具」约束指令");
  }
}

/* ── 9. ★ 档位静默降级「透出」（2026-10-17 起：robin 不换将/不跨档重试/不置窗）
   mock 侧：文本含 TRIGGER_DEGRADE 时，argon 请求得到「静默降级」元数据（无 #25、
   #30=Flash-Lite），其他档位得到正常元数据 —— 复现上游账号级降级的响应面。
   新语义（用户指定，robin 与调用方解耦）：降级响应【原样透出】——响应里的
   modelVersion（"Used 3.5 Flash-Lite model"）就是给上层的信号，由调用方（Eidolon）
   决定跨通道回退（ag/gemini-3.8-flash）；robin 内不产生第二次请求、不换档位。 */
{
  const ARGON = "95a4c0abcba24364";
  const post = (m, body) =>
    fetch(`${base}/v1beta/models/${m}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // 9.1 音频退让（预期降级）：音频 + argon + TRIGGER_DEGRADE ⇒ 只 1 次请求，
  //     降级回显透出；lastEvent 标 exempt（音频退让属预期，仅上报标注）
  {
    const before = seen.modeHistory.length;
    const r = await post("gemini-4-argon", {
      contents: [{ role: "user", parts: [
        { inlineData: { mimeType: "audio/webm", data: "QUJD" } },
        { text: "TRIGGER_DEGRADE 听一下这段音频" },
      ]}],
    });
    assert.equal(r.status, 200, `音频请求应成功，实际 ${r.status}`);
    assert.equal(seen.modeHistory.length, before + 1, "降级不得触发任何重试（应只 1 次请求）");
    assert.equal(seen.modeHistory.at(-1), ARGON, "音频请求本身应以 argon 发出（shim 后不退让）");
    assert.equal(guardStatus().lastEvent.state, "degraded", "降级判定应记入 lastEvent");
    assert.equal(guardStatus().lastEvent.exempt, "audio-deference", "音频退让应在 lastEvent 标注 exempt");
    ok("§9.1 音频退让：预期降级只上报、不重试（1 次请求）");
  }

  // 9.2 非流式降级透出：argon + TRIGGER_DEGRADE ⇒ 只发 1 次（ARGON），
  //     modelVersion=Flash-Lite 原样返回（上层据此跨通道回退）
  {
    __resetGuardForTest();
    const before = seen.modeHistory.length;
    const r = await post("gemini-4-argon", {
      contents: [{ role: "user", parts: [{ text: "TRIGGER_DEGRADE 你好" }] }],
    });
    assert.equal(r.status, 200);
    assert.equal(seen.modeHistory.length, before + 1, "降级不得触发重试（应只 1 次请求）");
    assert.equal(seen.modeHistory.at(-1), ARGON, "必须按请求的 argon 档位发出（不换将）");
    const j = await r.json();
    assert.ok(
      String(j.modelVersion).includes("Flash-Lite"),
      `降级回显应原样透出，实际 modelVersion=${j.modelVersion}`,
    );
    assert.equal(guardStatus().lastEvent.state, "degraded", "降级判定应记入 lastEvent（healthz 可见）");
    ok("§9.2 argon 降级 → 回显原样透出（不换将、不重试，单次请求）");
  }

  // 9.3 流式降级透出：argon + TRIGGER_DEGRADE（stream）⇒ 只发 1 次（ARGON），
  //     流式内容原样输出（真流式无法撤回，降级同样只透出不重试）
  {
    __resetGuardForTest();
    const before = seen.modeHistory.length;
    const r = await fetch(`${base}/v1beta/models/gemini-4-argon:streamGenerateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "TRIGGER_DEGRADE 流式" }] }] }),
    });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.equal(seen.modeHistory.length, before + 1, "流式降级也不得重试（应只 1 次请求）");
    assert.equal(seen.modeHistory.at(-1), ARGON, "流式请求同样按 argon 发出（不换将）");
    assert.ok(body.includes("流式"), "流式内容应原样输出");
    assert.equal(guardStatus().lastEvent.state, "degraded");
    ok("§9.3 流式降级透出：单次请求 + 内容原样输出");
  }

  // 9.4 无置窗替代：连续两个 argon 请求都以 ARGON 发出（不存在「窗口内自动换将」，
  //     账号恢复探测完全交由上层 600s 直连窗口负责）
  {
    __resetGuardForTest();
    const before = seen.modeHistory.length;
    await post("gemini-4-argon", {
      contents: [{ role: "user", parts: [{ text: "TRIGGER_DEGRADE 第一发" }] }],
    });
    await post("gemini-4-argon", {
      contents: [{ role: "user", parts: [{ text: "TRIGGER_DEGRADE 第二发" }] }],
    });
    assert.deepEqual(
      seen.modeHistory.slice(-2),
      [ARGON, ARGON],
      `两发都应按 argon 发出（无置窗替代），实际 ${JSON.stringify(seen.modeHistory.slice(-2))}`,
    );
    assert.equal(guardStatus().emptyReplies, 0, "降级不计入空响应");
    __resetGuardForTest(); // 清理状态，避免污染其他场景
    ok("§9.4 无置窗替代：连续请求均按原档位发出");
  }
}

/* ── 10. ★ 媒体占位视频（media shim）：音频 → 16×16 视频 ⇒ 满血 Argon + 听觉兼得 ──
   2026-10-16/17 实证：视频音轨可被 Argon 满血档位准确转录；独立音频附件则与 Argon 互斥。
   本组验证：音频附件经反代转封装后以 video/webm（source=VIDEO=6）发出、
   档位【不退让】（#16 留在 Lgcvm.#1），且同内容第二次请求命中缓存。
   依赖本机 ffmpeg（缺失则跳过本组；生产机与开发机均已安装）。 */
{
  const hasFfmpeg = await ffmpegAvailable();
  if (!hasFfmpeg) {
    console.log("  [skip] 本机无 ffmpeg —— 占位视频（media shim）链路测试跳过");
  } else {
    // 现场生成一段真实 opus 音频（0.4s 静音，~1KB）—— 自证输入有效，避免内嵌大 base64
    const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-shim-"));
    const audioPath = path.join(dir, "t.webm");
    try {
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.4",
        "-c:a", "libopus", "-b:a", "16k", audioPath,
      ], { stdio: "ignore" });
      const audioB64 = readFileSync(audioPath).toString("base64");
      const body = {
        contents: [{ role: "user", parts: [
          { text: "听一下这段音频" },
          { inlineData: { mimeType: "audio/webm;codecs=opus", data: audioB64 } },
        ]}],
      };
      const post = () =>
        fetch(`${base}/v1beta/models/gemini-4-argon:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // 10.1 首发：音频被转成 video/webm 发出；档位不退让（#16 留在 Lgcvm.#1 —— 满血）
      const r1 = await post();
      assert.equal(r1.status, 200, `占位视频请求应成功，实际 ${r1.status}`);
      assert.equal(seen.lastAttachments.length, 1, "应发出 1 个附件");
      const kr1 = fieldOne(seen.lastAttachments[0], 1);
      assert.ok(kr1, "Lgbku.#1 Lgbkr 应存在");
      assert.equal(asString(fieldOne(kr1.value, 3)?.value), "video/webm",
        "音频附件应被转封装为 video/webm");
      assert.equal(Number(asUint(fieldOne(kr1.value, 4)?.value)), 6,
        "Lgbkr.#4 应为 VIDEO=6（走视频通道）");
      assert.deepEqual(seen.lastModeCarriers, { field1: "95a4c0abcba24364", envelope: null },
        `占位视频后档位不得退让（#16 必须留在 Lgcvm.#1），实际 ${JSON.stringify(seen.lastModeCarriers)}`);
      ok("§10.1 音频 → 占位视频：以 video/webm(VIDEO=6) 发出 + 档位不退让（#16 在 Lgcvm.#1）");

      // 10.2 ★ 2026-10-17：同 payload 二次请求被**幂等去重**拦截（dedup 在 shim 之前），
      //   所以连媒体转封装都不会再跑 —— 这是比「shim 缓存命中」更强的结果：
      //   上游完全没被调用，零配额消耗。
      const h0 = await (await fetch(`${base}/healthz`)).json();
      const seenBefore = seen.requests;
      const r2 = await post();
      assert.equal(r2.status, 200);
      const h1 = await (await fetch(`${base}/healthz`)).json();
      assert.equal(seen.requests - seenBefore, 0,
        "去重命中时 mock 不应再收到任何请求（零上游调用）");
      assert.equal(h1.dedup.hits, h0.dedup.hits + 1,
        `dedup.hits 应 +1（${h0.dedup.hits} → ${h1.dedup.hits}）`);
      assert.equal(h1.mediaShim.stats.converted, h0.mediaShim.stats.converted,
        "去重命中时不得再发起转换（converted 不应增长）");
      assert.equal(h1.mediaShim.stats.cacheHits, h0.mediaShim.stats.cacheHits,
        "去重命中时 shim 缓存也不该被触碰（dedup 在 shim 上游拦截）");
      assert.equal(h1.mediaShim.enabled, true);
      assert.equal(h1.mediaShim.ffmpeg, true, "healthz 应报告 ffmpeg 可用");
      ok("§10.2 同 payload 二次请求：幂等去重命中（mock 零新增请求 / dedup.hits +1 / shim 未被触碰）");

      // 10.3 关掉去重后，shim 转换缓存路径必须仍然独立可用（防止去重层掩盖 shim 自身的回归）
      process.env.ROBIN_DEDUP = "0";
      try {
        const h2 = await (await fetch(`${base}/healthz`)).json();
        assert.equal(h2.dedup.enabled, false, "ROBIN_DEDUP=0 应生效");
        const r3 = await post();
        assert.equal(r3.status, 200);
        const h3 = await (await fetch(`${base}/healthz`)).json();
        assert.equal(seen.requests - seenBefore, 1,
          "去重关闭后应真的打到 mock（1 次）");
        assert.ok(h3.mediaShim.stats.cacheHits > h2.mediaShim.stats.cacheHits,
          `去重关闭后应命中 shim 转换缓存（${h2.mediaShim.stats.cacheHits} → ${h3.mediaShim.stats.cacheHits}）`);
        ok("§10.3 ROBIN_DEDUP=0 时 shim 转换缓存路径仍独立可用（防去重层掩盖 shim 回归）");
      } finally {
        delete process.env.ROBIN_DEDUP;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/* ── §18 幂等去重闭环（防重复计费；见 lib/dedup.js）──────────────────────
 * 事故背景：重启掐断在途请求 ⇒ 上游已计费但应答丢失 ⇒ 调用方重发 ⇒ 重复计费。
 * 本组用 mock 精确计数证明：相同 payload 的第 2、3 次请求**零上游调用**。
 */
{
  const payload = {
    contents: [{ role: "user", parts: [{ text: "DEDUP 幂等去重闭环验证" }] }],
  };
  const post = () =>
    fetch(`${base}/v1beta/models/gemini-4-argon:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  const h0 = await (await fetch(`${base}/healthz`)).json();
  const before = seen.requests;

  // 18.1 首发：正常打到 mock 并拿到内容
  const r1 = await post();
  assert.equal(r1.status, 200, `首发应成功，实际 ${r1.status}`);
  const j1 = await r1.json();
  const t1 = j1.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  assert.ok(t1.includes("的回复"), `首发应拿到 mock 回复，实际 ${JSON.stringify(t1)}`);
  assert.equal(seen.requests - before, 1, "首发应真的打到 mock（1 次）");

  // 18.2 第 2、3 次：逐字节相同的 payload ⇒ 零上游调用，但内容一致
  const r2 = await post();
  const r3 = await post();
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  const t2 = (await r2.json()).candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const t3 = (await r3.json()).candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  assert.equal(t2, t1, "重放内容应与首发逐字一致");
  assert.equal(t3, t1, "第三次重放内容也应逐字一致");
  assert.equal(seen.requests - before, 1,
    `三次相同请求，mock 只应收到 1 次（零重复计费），实际 ${seen.requests - before}`);

  const h1 = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h1.dedup.hits - h0.dedup.hits, 2, `dedup.hits 应 +2，实际 +${h1.dedup.hits - h0.dedup.hits}`);
  assert.equal(h1.dedup.stores - h0.dedup.stores, 1, "应写入 1 条可重放缓存");
  ok("§18.1 相同 payload 三次请求：mock 仅收到 1 次（后两次零上游调用 / 零配额）");

  // 18.3 内容稍变 ⇒ 必须重新打上游（去重不得把「新意图」当成重发）
  const r4 = await fetch(`${base}/v1beta/models/gemini-4-argon:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "DEDUP 幂等去重闭环验证（改一个字）" }] }] }),
  });
  assert.equal(r4.status, 200);
  assert.equal(seen.requests - before, 2, "内容变化后应重新打上游（+1）");
  ok("§18.2 payload 稍变即重新打上游（去重不吞噬新意图）");

  // 18.4 不同 verb 不可互相重放
  const s0 = seen.requests;
  const sr = await fetch(`${base}/v1beta/models/gemini-4-argon:streamGenerateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(sr.status, 200);
  await sr.text();
  assert.equal(seen.requests - s0, 1, "streamGenerateContent 与 generateContent 键不同，应重新打上游");
  ok("§18.3 verb 不同不可互相当重放源（响应形态不同）");

  // 18.5 healthz 暴露在途计数（部署前检查：>0 就别重启）
  const h2 = await (await fetch(`${base}/healthz`)).json();
  assert.equal(typeof h2.inflight.inflight, "number", "healthz 应暴露 inflight");
  assert.equal(h2.inflight.inflight, 0, "空闲时在途应为 0");
  assert.equal(h2.dedup.enabled, true, "healthz 应报告去重已启用");
  ok("§18.4 healthz 暴露 inflight / dedup 状态（部署前可据此判断能否安全重启）");
}
ok("★ 幂等去重闭环（同 payload 重发 ⇒ 零上游调用；新意图不被吞噬）");

/* 17. 空响应自动重试（偶发故障甄别闭环；见 lib/empty-retry.js）
 *   mock 侧 TRIGGER_EMPTY：第 1 次请求返回空响应（无帧），第 2 次起返回正常文本。
 *   预期：反代自动重试一次 → 客户端收到正常内容；mock 共收到 2 次请求；healthz 记账。 */
{
  const h0 = await (await fetch(`${base}/healthz`)).json();
  const before = seen.requests;
  const r = await fetch(`${base}/v1beta/models/gemini-4-argon:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "TRIGGER_EMPTY 空响应重试闭环" }] }] }),
  });
  assert.equal(r.status, 200, `重试后应成功，实际 ${r.status}`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  assert.ok(text.includes("的回复"), `应收到重试后的正常内容，实际 ${JSON.stringify(text)}`);
  assert.equal(seen.requests - before, 2, "mock 应收到 2 次请求（首次空 + 自动重试 1 次）");
  assert.equal(seen.modeHistory.at(-1), "95a4c0abcba24364", "重试应保持同档位（argon 不降级）");
  const h1 = await (await fetch(`${base}/healthz`)).json();
  assert.ok(h1.emptyRetry.enabled, "healthz 应报告空响应重试已启用");
  assert.equal(h1.emptyRetry.retries - h0.emptyRetry.retries, 1, "应记录 1 次重试");
  assert.equal(h1.emptyRetry.successes - h0.emptyRetry.successes, 1, "应记录 1 次重试成功");
  assert.equal(h1.emptyRetry.exhausted - h0.emptyRetry.exhausted, 0, "不应有耗尽");
  ok("§17 空响应 → 自动重试 → 成功（同档位重试，robin 质量保留；healthz 记账）");
}

/* 17.2 连续空响应 → 重试耗尽（回归：失败总时长不得拖过调用方 120s 硬超时）
 *   mock 侧 TRIGGER_EMPTY_ALWAYS：每次请求都返回空响应。
 *   预期：默认 maxRetries=1 ⇒ 共 2 次请求后返回空结果交上层（ag 回退）处置；
 *   healthz 记账 retries +1、exhausted +1、successes 不变。
 *   （2026-10-16 教训：旧默认 3 次尝试「空27s+空27s+成功69s=123s」超调用方 120s 4 秒，
 *    反代自愈成功但客户端已放弃 —— 本组锁定「最多 2 次尝试」的默认语义。） */
{
  const h0 = await (await fetch(`${base}/healthz`)).json();
  const before = seen.requests;
  const r = await fetch(`${base}/v1beta/models/gemini-4-argon:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "TRIGGER_EMPTY_ALWAYS 连续空响应" }] }] }),
  });
  assert.equal(r.status, 200, "耗尽后应返回（空）响应而不报错");
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  assert.equal(text, "", "耗尽后应为空正文（交上层 ag 回退处置）");
  assert.equal(seen.requests - before, 2, "默认 maxRetries=1 ⇒ 共 2 次请求（1 原发 + 1 重试）");
  assert.equal(seen.modeHistory.at(-1), "95a4c0abcba24364", "重试应保持同档位");
  const h1 = await (await fetch(`${base}/healthz`)).json();
  assert.equal(h1.emptyRetry.retries - h0.emptyRetry.retries, 1, "应记录 1 次重试");
  assert.equal(h1.emptyRetry.exhausted - h0.emptyRetry.exhausted, 1, "应记录 1 次耗尽");
  assert.equal(h1.emptyRetry.successes - h0.emptyRetry.successes, 0, "不应有成功");
  ok("§17.2 连续空响应 → 2 次尝试后放弃（不拖过预算；healthz 记账）");
}

app.close();
mockServer.close();
console.log(`\n全部通过：${n} 组断言`);
process.exit(0);
