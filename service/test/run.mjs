// 自测：wire 编解码 + gRPC 拆帧 + HTTP 路由冒烟（零依赖，node test/run.mjs）
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  Writer,
  decodeFields,
  fieldOne,
  writeVarint,
  readVarint,
  asInt32,
  asUint,
  asString,
  decodePackedVarint,
  grpcFrame,
  GrpcFrameDecoder,
} from "../lib/wire.js";
import { handle, readJsonBody } from "../lib/app.js";
import { geminiToRobin, encodeFileUri } from "../lib/gemini.js";
import { toolPartToText, toolChoiceConstraint } from "../lib/toolcall.js";
import {
  noteResponse, guardStatus,
  __resetGuardForTest,
} from "../lib/degrade-guard.js";
import {
  toPlaceholderVideo, applyMediaShim, shimStatus,
  __resetShimForTest, __setConverterForTest, __setShimEnabledForTest, __setShimCacheLimitForTest,
  placeholderVideoInfo,
} from "../lib/mediashim.js";
import {
  estimatePromptTokens, withEstimatedUsage, USAGE_RATES,
} from "../lib/usage-estimate.js";
import {
  credentialHealth, tokenStatus,
  __setGsaForTest, __setMintedForTest, __resetAuthForTest,
} from "../lib/auth.js";
import {
  dedupKey, dedupEnabled, dedupStatus,
  beginDedup, lookupDedup, isInflight, waitDedup,
  completeDedup, failDedup, resetDedup,
} from "../lib/dedup.js";
import {
  inflightStatus, resetInflight,
  enterRequest, exitRequest,
} from "../lib/inflight.js";
import { extractResponse } from "../lib/pq.js";
import { idleLimitFor } from "../lib/robin.js";

let n = 0;
const ok = (m) => {
  n++;
  console.log(`  [pass] ${m}`);
};

/* 1. varint 往返 */
{
  const cases = [0n, 1n, 127n, 128n, 300n, 16383n, 16384n, 2147483647n, 4294967295n];
  for (const v of cases) {
    const b = writeVarint(v);
    const [r, p] = readVarint(b, 0);
    assert.equal(r, v, `varint ${v} 往返失败`);
    assert.equal(p, b.length);
  }
  ok("varint 往返（含 127/128/16383/16384 边界）");

  const neg = writeVarint(-1);
  assert.equal(neg.length, 10, "int32 负数应为 10 字节");
  assert.equal(asInt32(readVarint(neg, 0)[0]), -1);
  ok("int32 负数 = 10 字节 varint 且还原为 -1");
}

/* 2. 扩展字段号（wire 上等同普通字段） */
{
  const b = new Writer().varint(1001, 1).finish();
  assert.deepEqual([...b], [0xc8, 0x3e, 0x01], "字段 1001 的 tag 应为 C8 3E");
  const f = decodeFields(b)[0];
  assert.equal(f.no, 1001);
  assert.equal(asUint(f.value), 1);
  ok("扩展字段号 1001 编解码（tag = 1001<<3|0）");
}

/* 3. 嵌套消息 + 字符串（模拟 Lgcvp[ext1000]→Lgcvm.#1→Lgauy 结构） */
{
  const lgauy = new Writer().string(6, "hello world").varint(19, 42);
  const lgcvm = new Writer().message(1, lgauy);
  const lgcvmExt = new Writer().message(1000, lgcvm);
  const bytes = lgcvmExt.finish();

  const ext = fieldOne(bytes, 1000);
  assert.ok(ext, "ext 1000 应存在");
  const inner1 = fieldOne(ext.value, 1);
  assert.ok(inner1, "Lgcvm.#1 应存在");
  assert.equal(asString(fieldOne(inner1.value, 6).value), "hello world");
  assert.equal(asUint(fieldOne(inner1.value, 19).value), 42);
  ok("嵌套消息 3 层（ext1000 → #1 → #6/#19）编解码");
}

/* 4. packed varint（Lgavd int 列表） */
{
  const b = new Writer().packedVarint(6, [1, 2, 300]).finish();
  const f = decodeFields(b)[0];
  assert.equal(f.no, 6);
  assert.equal(f.wt, 2, "packed 应为 LEN");
  assert.deepEqual(decodePackedVarint(f.value).map(Number), [1, 2, 300]);
  ok("packed varint [1,2,300] 编解码");

  const empty = new Writer().packedVarint(6, []).finish();
  assert.equal(empty.length, 0, "空 packed 不应落盘");
  ok("空 packed 不落盘（proto3 语义）");
}

/* 5. sint（zigzag） */
{
  const b = new Writer().sint(1, -2).finish();
  const f = decodeFields(b)[0];
  assert.equal(asInt32(f.value), 3, "zigzag(-2) 应为 3");
  ok("sint32 zigzag(-2) = 3");
}

/* 6. gRPC 帧：跨 chunk 拆分重组 */
{
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const frame = grpcFrame(payload);
  assert.equal(frame.length, 10);
  assert.equal(frame[0], 0);
  assert.deepEqual([...frame.subarray(1, 5)], [0, 0, 0, 5], "长度大端 5");

  const dec = new GrpcFrameDecoder();
  assert.equal(dec.push(frame.subarray(0, 3)).length, 0, "半帧不应输出");
  const frames = dec.push(frame.subarray(3));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0].payload], [1, 2, 3, 4, 5]);
  ok("gRPC 5 字节帧跨 chunk 拆分重组");

  // 单 chunk 多帧
  const two = new Uint8Array([...frame, ...grpcFrame(new Uint8Array([9]))]);
  const dec2 = new GrpcFrameDecoder();
  assert.equal(dec2.push(two).length, 2, "一个 chunk 内两帧");
  ok("单 chunk 多帧解析");
}

/* 7. HTTP 路由冒烟 */
{
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const h = await fetch(`${base}/healthz`);
  assert.equal(h.status, 200);
  const hj = await h.json();
  assert.equal(hj.ok, true);
  ok("GET /healthz → 200 {ok:true}");

  const pre = await fetch(`${base}/v1beta/models`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  ok("OPTIONS 预检 → 204 + CORS");

  const m = await fetch(`${base}/v1beta/models`);
  assert.equal(m.status, 200);
  const mj = await m.json();
  assert.ok(Array.isArray(mj.models) && mj.models.length >= 1);
  ok("GET /v1beta/models → 200 {models:[...]}");

  // 413 保护：直测 readJsonBody（不触碰上游）
  {
    const fakeReq = {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.alloc(5 * 1024 * 1024);
      },
    };
    let threw = null;
    try {
      await readJsonBody(fakeReq);
    } catch (e) {
      threw = e;
    }
    assert.ok(threw && threw.statusCode === 413, "超限应抛 413");
    ok("请求体超限 → 413（Vercel 4.5MB 硬限前置保护）");
  }

  const ct = await fetch(`${base}/v1beta/models/gemini-2.0-flash:countTokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "12345678" }] }] }),
  });
  assert.equal(ct.status, 200);
  const ctj = await ct.json();
  assert.equal(ctj.totalTokens, 2);
  ok("countTokens → 200 {totalTokens:2}");

  const nf = await fetch(`${base}/nope`);
  assert.equal(nf.status, 404);
  ok("未知路由 → 404");

  server.close();
}

/* 8. gpsoauth 协议契约（纯函数，不发网络请求） */
{
  const {
    parseAuthResponse,
    buildExchangeData,
    buildOauthData,
    extractOauthToken,
    buildLoginUrl,
    normalizeAndroidId,
    randomAndroidId,
    CLIENT_SIG,
    AGSA_PKG,
    ASSISTANT_SERVICE,
    GPS_VERSION,
  } = await import("../lib/gpsoauth.js");

  // 响应解析：一行一个 key=value，空行忽略，值里可含 '='
  const parsed = parseAuthResponse("Auth=ya29.abc==\r\n\r\nError=BadAuth\nEmail=a@b.c\n");
  assert.deepEqual(parsed, { Auth: "ya29.abc==", Error: "BadAuth", Email: "a@b.c" });
  ok("parseAuthResponse：逐行 key=value、忽略空行、值含 = 不错切");

  // exchange_token 载荷契约（与 gpsoauth/__init__.py:191-209 逐字段对齐）
  const ex = buildExchangeData({ email: "a@b.c", oauthToken: "TOK", androidId: "0123456789abcdef" });
  assert.deepEqual(Object.keys(ex).sort(), [
    "ACCESS_TOKEN",
    "Email",
    "Token",
    "accountType",
    "add_account",
    "androidId",
    "callerSig",
    "client_sig",
    "device_country",
    "droidguard_results",
    "google_play_services_version",
    "has_permission",
    "lang",
    "operatorCountry",
    "sdk_version",
    "service",
    "source",
  ]);
  assert.equal(ex.Token, "TOK", "网页 oauth_token 必须放在 Token 字段");
  assert.equal(ex.ACCESS_TOKEN, 1);
  assert.equal(ex.service, "ac2dm");
  assert.equal(ex.has_permission, 1);
  assert.equal(ex.client_sig, CLIENT_SIG);
  assert.equal(ex.callerSig, CLIENT_SIG, "callerSig 必须与 client_sig 同值");
  assert.equal(ex.google_play_services_version, GPS_VERSION);
  ok("exchange_token 载荷契约（Token=oauth_token / ACCESS_TOKEN=1 / service=ac2dm）");

  // perform_oauth 载荷契约（与 gpsoauth/__init__.py:244-259 对齐）
  const oa = buildOauthData({ email: "a@b.c", masterToken: "oauth2rt_1/x", androidId: "0123456789abcdef" });
  assert.equal(oa.EncryptedPasswd, "oauth2rt_1/x", "master token 必须放在 EncryptedPasswd 字段");
  assert.equal(oa.service, ASSISTANT_SERVICE, "默认服务 = oauth2:.../auth/assistant");
  assert.equal(oa.app, AGSA_PKG, "默认 app = AGSA");
  assert.equal(oa.client_sig, CLIENT_SIG);
  assert.equal("Token" in oa, false, "perform_oauth 不带 Token 字段");
  assert.equal("droidguard_results" in oa, false, "perform_oauth 不带 droidguard_results");
  assert.ok(ASSISTANT_SERVICE.endsWith("/auth/assistant"));
  ok("perform_oauth 载荷契约（EncryptedPasswd=master / app=AGSA / oauth2:assistant）");

  // oauth_token 提取：cookie 串 / Netscape cookies.txt
  assert.equal(extractOauthToken("SID=x; oauth_token=AbC-1_2.3~x; HSID=y"), "AbC-1_2.3~x");
  assert.equal(extractOauthToken("# Netscape\naccounts.google.com\tFALSE\t/\tTRUE\t0\toauth_token\tZz9\n"), "Zz9");
  assert.equal(extractOauthToken("nothing here"), null);
  ok("extractOauthToken：兼容 cookie 串与 Netscape cookies.txt");

  // 网页登录 URL
  const u = new URL(buildLoginUrl());
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/EmbeddedSetup");
  assert.equal(u.searchParams.get("source"), "android");
  assert.equal(u.searchParams.get("tmpl"), "new_account");
  assert.equal(u.searchParams.get("xoauth_display_name"), "Android Device");
  ok("buildLoginUrl：EmbeddedSetup + source=android + tmpl=new_account");

  // androidId 规范化 / 生成
  assert.equal(normalizeAndroidId("0123456789ABCDEF"), "0123456789abcdef");
  assert.equal(normalizeAndroidId("01-23 45 67 89 ab cd ef"), "0123456789abcdef");
  assert.equal(normalizeAndroidId("too-short"), null);
  assert.match(randomAndroidId(), /^[0-9a-f]{16}$/);
  ok("androidId 规范化（去分隔符/小写/16 位校验）与随机生成");
}

/* 9. /login 绑定页渲染 */
{
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const r = await fetch(`${base}/login`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const html = await r.text();
  for (const marker of [
    "accounts.google.com/EmbeddedSetup",
    "oauth_token",
    "/admin/gpsoauth",
    "x-admin-key",
    "com.google.android.googlequicksearchbox",
  ]) {
    assert.ok(html.includes(marker), `/login 页面应包含 ${marker}`);
  }
  assert.ok(!html.includes("<script src="), "绑定页必须自包含（无外部资源）");
  ok("GET /login → 200 自包含 HTML（含登录入口 / 表单 / 端点说明）");

  // 未配置 ADMIN_KEY 时应给出提示而非静默失败
  assert.ok(html.includes("ADMIN_KEY"), "未配 ADMIN_KEY 时页面应提示");
  ok("未配置 ADMIN_KEY → 页面显式提示，不静默失败");

  // 未配 ADMIN_KEY 时 /admin/gpsoauth 应 404（端点整体禁用）
  const g = await fetch(`${base}/admin/gpsoauth`);
  assert.equal(g.status, 404);
  ok("未配置 ADMIN_KEY → /admin/gpsoauth 404（端点禁用）");

  server.close();
}

/* 10. function calling 兼容层（lib/toolcall.js 纯函数） */
{
  const {
    hasToolDeclarations,
    extractToolDefs,
    toolChoiceConstraint,
    buildToolPrompt,
    formatFunctionCallHistory,
    formatFunctionResponseHistory,
    parseFunctionCalls,
    toolPartToText,
  } = await import("../lib/toolcall.js");

  // 10.1 探测与提取
  assert.equal(hasToolDeclarations({}), false);
  assert.equal(hasToolDeclarations({ tools: [] }), false, "空 tools 数组不算声明");
  assert.equal(hasToolDeclarations({ tools: [{ functionDeclarations: [] }] }), true);
  const defs = extractToolDefs({
    tools: [
      { functionDeclarations: [{ name: "get_weather", description: "查天气", parameters: { type: "object" } }] },
      { functionDeclarations: [{ name: "", description: "无名工具应被跳过" }] },
      { functionDeclarations: [{ name: "no_params", description: "无参数" }] },
    ],
  });
  assert.equal(defs.length, 2, "无名工具应被剔除");
  assert.deepEqual(defs[0], { name: "get_weather", description: "查天气", parameters: { type: "object" } });
  assert.deepEqual(defs[1], { name: "no_params", description: "无参数" });
  ok("hasToolDeclarations / extractToolDefs（空数组/无名工具边界）");

  // 10.2 提示词构造与 toolConfig 约束
  const prompt = buildToolPrompt(defs, {});
  assert.ok(prompt.includes("# Tool Use"));
  assert.ok(prompt.includes('"name": "<tool_name>"'), "应约定 name 字段格式");
  assert.ok(prompt.includes("get_weather"));
  assert.ok(prompt.includes("Output ONLY the function_call block"));
  assert.equal(
    toolChoiceConstraint({ toolConfig: { functionCallingConfig: { mode: "NONE" } } }, defs),
    "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.",
  );
  assert.match(
    toolChoiceConstraint({ toolConfig: { functionCallingConfig: { mode: "ANY" } } }, defs),
    /MUST call at least one tool/,
  );
  assert.match(
    toolChoiceConstraint(
      { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] } } },
      defs,
    ),
    /MUST call one of these tools: "get_weather"/,
  );
  assert.equal(toolChoiceConstraint({}, defs), "", "AUTO 且无白名单 → 无约束");
  ok("buildToolPrompt + toolChoiceConstraint（NONE/ANY/白名单/AUTO）");

  // 10.3 历史序列化
  assert.equal(
    formatFunctionCallHistory({ name: "get_weather", args: { city: "北京" } }),
    '```function_call\n{"name":"get_weather","args":{"city":"北京"}}\n```',
  );
  assert.equal(
    formatFunctionResponseHistory({ name: "get_weather", response: { temp: 15 } }),
    '[Tool result for get_weather]: {"temp":15}',
  );
  assert.equal(
    formatFunctionResponseHistory({ name: "x", response: "raw string" }),
    "[Tool result for x]: raw string",
  );
  assert.equal(toolPartToText({ text: "hi" }), null, "普通 part 不走工具分支");
  ok("functionCall/functionResponse 历史标记序列化");

  // 10.4 响应解析：三种形态 + 白名单 + 清洗
  {
    const fenced = '好的，我来查一下。\n```function_call\n{"name": "get_weather", "args": {"city": "北京"}}\n```';
    const r1 = parseFunctionCalls(fenced);
    assert.equal(r1.calls.length, 1);
    assert.equal(r1.calls[0].name, "get_weather");
    assert.deepEqual(r1.calls[0].args, { city: "北京" });
    assert.equal(r1.cleanText, "好的，我来查一下。", "围栏应从清洗文本中移除");
  }
  {
    // 多个围栏 → 多个调用（并行工具）
    const multi =
      '```function_call\n{"name": "a", "args": {}}\n```\n中间文本\n```function_call\n{"name": "b", "args": {"x": 1}}\n```';
    const r = parseFunctionCalls(multi);
    assert.deepEqual(r.calls.map((c) => c.name), ["a", "b"]);
    assert.equal(r.cleanText, "中间文本");
  }
  {
    // 无围栏形态
    const bare = 'function_call\n{"name": "get_weather", "args": {"city": "上海"}}';
    const r = parseFunctionCalls(bare);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].name, "get_weather");
    assert.equal(r.cleanText, "");
  }
  {
    // 整段 raw JSON 兜底
    const r = parseFunctionCalls('{"name": "get_weather", "args": {"city": "广州"}}');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].args.city, "广州");
  }
  {
    // 白名单过滤：幻觉工具名应被拒绝
    const r = parseFunctionCalls('```function_call\n{"name": "ghost_tool", "args": {}}\n```', ["get_weather"]);
    assert.equal(r.calls.length, 0, "名单外工具应被拒绝");
    assert.ok(r.cleanText.includes("ghost_tool"), "拒绝后原文保留在清洗文本里（不静默吞掉）");
  }
  {
    // 普通文本不应误报
    const r = parseFunctionCalls("北京今天多云，气温 15 到 22 度。");
    assert.equal(r.calls.length, 0);
    assert.equal(r.cleanText, "北京今天多云，气温 15 到 22 度。");
  }
  {
    // 坏 JSON 围栏：跳过该块、不崩溃、其余文本保留
    const r = parseFunctionCalls('前奏\n```function_call\n{broken json\n```\n尾声');
    assert.equal(r.calls.length, 0);
    assert.ok(r.cleanText.includes("前奏") && r.cleanText.includes("尾声"));
  }
  {
    // arguments 别名 + 非对象参数归一化
    const r = parseFunctionCalls('```function_call\n{"name": "t", "arguments": {"a": 1}}\n```');
    assert.deepEqual(r.calls[0].args, { a: 1 });
    const r2 = parseFunctionCalls('```function_call\n{"name": "t", "args": "raw"}\n```');
    assert.deepEqual(r2.calls[0].args, { value: "raw" });
  }
  ok("parseFunctionCalls（围栏/无围栏/raw JSON/白名单/坏 JSON/参数归一化）");
}

/* 11. 附件数量截断（lib/gemini.js truncateAttachments，多轮压单轮防护） */
{
  const { truncateAttachments, geminiToRobin } = await import("../lib/gemini.js");

  const mk = (mime) => ({ mime, bytes: Buffer.from("x") });

  // 11.1 不超限：原样返回、无注记
  {
    const list = [mk("image/png"), mk("audio/wav")];
    const r = truncateAttachments(list, 30);
    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.note, "");
    assert.equal(r.kept, list, "不超限应返回原数组（无拷贝）");
  }
  // 11.2 恰好等于上限：不截断
  {
    const r = truncateAttachments([mk("image/png"), mk("image/png")], 2);
    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 0);
  }
  // 11.3 超限：丢最旧、保最新（末尾优先）
  {
    const list = [
      { mime: "image/png", tag: "old1" },
      { mime: "image/png", tag: "old2" },
      { mime: "audio/wav", tag: "mid" },
      { mime: "image/png", tag: "new1" },
      { mime: "video/mp4", tag: "new2" },
    ];
    const r = truncateAttachments(list, 2);
    assert.deepEqual(
      r.kept.map((a) => a.tag),
      ["new1", "new2"],
      "应保留时间上最新的 2 个"
    );
    assert.deepEqual(
      r.dropped.map((a) => a.tag),
      ["old1", "old2", "mid"],
      "应丢弃时间上最旧的 3 个"
    );
    assert.ok(r.note.includes("共 5 个"), "注记应说明总数");
    assert.ok(r.note.includes("上限 2"), "注记应说明上限");
    assert.ok(r.note.includes("图片1、视频1"), "保留统计应为 图片1、视频1");
    assert.ok(r.note.includes("图片2、音频1"), "丢弃统计应为 图片2、音频1");
    assert.ok(r.note.includes("未提交"), "注记应明确丢弃媒体不可见");
  }
  // 11.4 cap<=0 = 不限制
  {
    const r = truncateAttachments([mk("image/png"), mk("image/png"), mk("image/png")], 0);
    assert.equal(r.kept.length, 3);
    assert.equal(r.note, "");
  }
  // 11.5 端到端：geminiToRobin 超限时保留末尾附件 + 文本带注记
  {
    const { geminiToRobin } = await import("../lib/gemini.js");
    const { config } = await import("../lib/config.js");
    const b64 = Buffer.from("fake").toString("base64");
    const contents = [];
    for (let i = 0; i < 5; i++) {
      contents.push({ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: b64 } }] });
      contents.push({ role: "model", parts: [{ text: `第${i}轮回复` }] });
    }
    contents.push({ role: "user", parts: [{ text: "最后一轮的问题" }] });
    const orig = config.maxAttachments;
    config.maxAttachments = 2;
    try {
      const out = geminiToRobin({ contents });
      assert.equal(out.attachments.length, 2, "应只保留最新 2 个附件");
      assert.ok(out.text.includes("媒体附件截断提示"), "文本应含截断注记");
      assert.ok(out.text.includes("最后一轮的问题"), "最新文本不应被丢");
    } finally {
      config.maxAttachments = orig;
    }
  }
  // 11.6 不超限时附件原样保留（防 kept/attachments 别名误清）
  {
    const { geminiToRobin } = await import("../lib/gemini.js");
    const { config } = await import("../lib/config.js");
    const b64 = Buffer.from("fake").toString("base64");
    const out = geminiToRobin({
      contents: [
        { role: "user", parts: [{ text: "看图" }, { inlineData: { mimeType: "image/png", data: b64 } }] },
      ],
    });
    assert.equal(out.attachments.length, 1, "不超限时附件应原样保留（1 个）");
    assert.ok(!out.text.includes("截断提示"), "不超限时不应出现截断注记");
    assert.ok(out.text.includes("看图"));
    assert.ok(Number.isFinite(config.maxAttachments) && config.maxAttachments > 0, "默认 cap 应为正数");
  }
  ok("truncateAttachments（不超限/恰好/丢旧保新/类型统计/注记/geminiToRobin 接线）");
}

/* 12. 会话隔离（DeleteConversation 请求构造） */
{
  const { buildDeleteConversationRequest, robinServicePrefix } = await import("../lib/pq.js");
  const { decodeFields, asString, Writer } = await import("../lib/wire.js");

  // 12.1 字段布局：#1 会话 ID 字符串 + #2 Lgauy（内含 #4 ClientType=ANDROID(2)）
  {
    const bytes = buildDeleteConversationRequest("c_885fc1a278b48b82");
    const f = decodeFields(bytes);
    const cid = f.find((x) => x.no === 1);
    const ctx = f.find((x) => x.no === 2);
    assert.ok(cid, "应有 #1 字段");
    assert.equal(asString(cid.value), "c_885fc1a278b48b82", "#1 应为会话 ID");
    assert.ok(ctx && ctx.wt === 2, "#2 应为 length-delimited 的 Lgauy");
    const inner = decodeFields(ctx.value).find((x) => x.no === 4);
    assert.ok(inner, "Lgauy 内应含 #4 ClientType");
    assert.equal(inner.value, 2n, "ClientType 默认应为 ANDROID(2)");
  }
  // 12.2 空会话 ID 应显式报错（不静默构造空请求）
  {
    assert.throws(() => buildDeleteConversationRequest(""), /conversationId 必填/);
    assert.throws(() => buildDeleteConversationRequest(null), /conversationId 必填/);
  }
  // 12.3 服务名前缀提取（拼 DeleteConversation 路径用）
  {
    assert.equal(
      robinServicePrefix("/assistant.mobile.robin.RobinService/ProcessQuery"),
      "/assistant.mobile.robin.RobinService/"
    );
    assert.equal(robinServicePrefix("no-slash"), "no-slash");
  }
  // 12.4 clientType 可覆盖
  {
    const bytes = buildDeleteConversationRequest("c_1", { clientType: 3 });
    const ctx = decodeFields(bytes).find((x) => x.no === 2);
    const ct = decodeFields(ctx.value).find((x) => x.no === 4);
    assert.equal(ct.value, 3n, "clientType 应可覆盖为 OMNIENT(3)");
  }
  ok("buildDeleteConversationRequest（字段布局/空值报错/服务前缀/clientType 覆盖）");
}

/* ── 13. 请求字段别名兼容（SDK 版本差异）── */
{
  const b64 = Buffer.from("data").toString("base64");
  // ⚠️ 回归防护：google-genai 2.28.0 会把 Blob.mimeType 序列化成 snake_case 的
  //   mime_type（2.6.0 输出 camelCase）。代理若只认一种，附件会静默退化成
  //   application/octet-stream ⇒ 服务端解码失败 ⇒ 模型看不到媒体（无报错）。
  const camel = geminiToRobin({
    contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: b64 } }] }],
  });
  const snake = geminiToRobin({
    contents: [{ role: "user", parts: [{ inlineData: { mime_type: "image/png", data: b64 } }] }],
  });
  assert.equal(camel.attachments.length, 1, "camelCase 应解析出 1 个附件");
  assert.equal(snake.attachments.length, 1, "snake_case 也应解析出 1 个附件");
  assert.equal(camel.attachments[0].mime, "image/png", "camelCase mime 应保留");
  assert.equal(snake.attachments[0].mime, "image/png", "⚠️ snake_case mime 必须保留（否则服务端解码失败）");

  // 外层键名同样兼容（inlineData / inline_data）
  const outerSnake = geminiToRobin({
    contents: [{ role: "user", parts: [{ inline_data: { mimeType: "audio/wav", data: b64 } }] }],
  });
  assert.equal(outerSnake.attachments.length, 1, "inline_data 外层键也应识别");
  assert.equal(outerSnake.attachments[0].mime, "audio/wav");

  // fileData 的 fileUri / file_uri 兼容
  // ⚠️ blobId 必须是真实形态（以 "/" 开头，如 /contrib_service/ttl_1d/...），
  //   decodeFileUri 以此做合法性校验，随便编一个 "b1" 会被判为无法解析。
  const REAL_BLOB = "/contrib_service/ttl_1d/vhoo7q5ua2tgjjabcdef1234567890";
  const uri = encodeFileUri({ blobId: REAL_BLOB, mime: "image/png", name: "n.png" });
  for (const [k, m] of [
    ["fileData", "fileUri"],
    ["file_data", "file_uri"],
  ]) {
    const r = geminiToRobin({ contents: [{ role: "user", parts: [{ [k]: { [m]: uri } }] }] });
    assert.equal(r.attachments.length, 1, `${k}.${m} 应解析出附件`);
    assert.equal(r.attachments[0].blobId, REAL_BLOB);
  }

  // ★ 同 part 内 text + inlineData 共存：两者都必须提取
  //   （旧实现 else-if 链 ⇒ text 命中后附件被静默丢弃；2026-10-17 生产实测踩到）
  {
    const mixed = geminiToRobin({
      contents: [{ role: "user", parts: [{ text: "听一下", inlineData: { mimeType: "audio/webm", data: b64 } }] }],
    });
    assert.equal(mixed.attachments.length, 1, "⚠️ text+inlineData 同 part ⇒ 附件不得被静默丢弃");
    assert.equal(mixed.attachments[0].mime, "audio/webm");
    assert.ok(mixed.text.includes("听一下"), "同一 part 的文本也必须保留");
  }

  // 工具历史 part 键名兼容
  for (const p of [
    { functionCall: { name: "f", args: { a: 1 } } },
    { function_call: { name: "f", args: { a: 1 } } },
    { functionResponse: { name: "f", response: { r: 2 } } },
    { function_response: { name: "f", response: { r: 2 } } },
  ]) {
    assert.ok(toolPartToText(p), `${Object.keys(p)[0]} 应被识别为工具历史`);
  }

  // toolConfig 嵌套键名兼容（工具约束被静默忽略 = 危险失败）
  {
    const defs = [{ name: "f", description: "d" }];
    const variants = [
      { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } } },
      { tool_config: { function_calling_config: { mode: "ANY", allowed_function_names: ["f"] } } },
    ];
    for (const v of variants) {
      const c = toolChoiceConstraint(v, defs);
      assert.ok(/MUST call/.test(c), `toolConfig 变体应产出约束指令: ${JSON.stringify(v)}`);
      assert.ok(/f/.test(c), "约束指令应含白名单工具名");
    }
    const none = toolChoiceConstraint(
      { tool_config: { function_calling_config: { mode: "NONE" } } },
      defs,
    );
    assert.ok(/Do NOT call/.test(none), "snake_case NONE 也应生效");
  }

  ok("请求字段别名兼容（inlineData/inline_data · mimeType/mime_type · fileUri/file_uri · text+附件同 part 共存 · 工具历史/toolConfig）");
}

/* ── 14. ★ 思考强度（Lfzqy.#48 / #67）──
 * 逆向取证见 lib/modes.js「思考强度」章节；线上实证（2026-10-16，Argon）：
 *   不发 #48 → Lfzrc.#42=1；#48=1→1；#48=4→4 + "Used 4 Argon Medium model"；#48=2→2 + "Used 4 Argon High model"
 * 本组只断言【请求构造】与【参数解析】两端（真机行为由 out/_think-envelope.mjs 实测覆盖）。
 */
{
  const { buildProcessQueryRequest, buildLfzqy, buildLgcvb, buildAttachmentEnvelope } = await import("../lib/pq.js");
  const { decodeFields, asUint, asString } = await import("../lib/wire.js");
  const { parseThinkingLevel, splitThinkingSuffix, THINKING_LEVELS, THINKING_LEVEL_NAMES, thinkingSummary } =
    await import("../lib/modes.js");

  /** 从 Lgcvp 字节里取出信封里的 Lfzqy 字段表 */
  function lfzqyFieldsOf(lgcvpBytes) {
    const lgcvm = decodeFields(lgcvpBytes).find((f) => f.no === 1000);
    assert.ok(lgcvm, "Lgcvp 应含 [ext1000] Lgcvm");
    const ext = decodeFields(lgcvm.value).find((f) => f.no === 1001);
    assert.ok(ext, "Lgcvm 应含 [ext1001] Lgcvb（信封）");
    const lfzqy = decodeFields(ext.value).find((f) => f.no === 1);
    assert.ok(lfzqy, "Lgcvb 应含 #1 Lfzqy");
    return decodeFields(lfzqy.value);
  }

  // 14.1 档位值/名称表（协议值来自 Lgbdp.#4 实测）
  {
    assert.equal(THINKING_LEVELS.low, 1);
    assert.equal(THINKING_LEVELS.medium, 4);
    assert.equal(THINKING_LEVELS.high, 2);
    assert.equal(THINKING_LEVEL_NAMES[2], "high", "2 必须是 high 而非中位序");
  }

  // 14.2 parseThinkingLevel：名/大写/数字/数字串；非法值必须返回 null（不静默取默认）
  {
    assert.deepEqual(parseThinkingLevel("high"), { value: 2, name: "high" });
    assert.deepEqual(parseThinkingLevel("MEDIUM"), { value: 4, name: "medium" });
    assert.deepEqual(parseThinkingLevel(1), { value: 1, name: "low" });
    assert.deepEqual(parseThinkingLevel("4"), { value: 4, name: "medium" });
    // 别名：minimal 是 Gemini 公开 API 的最低档枚举，映射到 low（Eidolon 取值域含 minimal）
    assert.deepEqual(parseThinkingLevel("minimal"), { value: 1, name: "low" });
    for (const bad of [undefined, null, "", "  ", "ultra", 3, 0, "99", {}]) {
      assert.equal(parseThinkingLevel(bad), null, `非法档位 ${JSON.stringify(bad)} 应返回 null`);
    }
  }

  // 14.3 splitThinkingSuffix：后缀剥离；无后缀 level=null；不误伤含 lite/flash 的名字
  {
    assert.deepEqual(splitThinkingSuffix("4-argon-high"), { base: "4-argon", level: "high" });
    // gemini- 前缀由别名表覆盖（aliasesOf 会生成 gemini-<slug>），剥后缀后保留前缀仍可解析
    assert.deepEqual(splitThinkingSuffix("models/gemini-4-argon-low"), { base: "gemini-4-argon", level: "low" });
    assert.equal(splitThinkingSuffix("4-argon").level, null);
    assert.equal(splitThinkingSuffix("3.5-flash-lite").level, null, "lite 不是档位后缀");
    assert.equal(splitThinkingSuffix("4-argon").base, "4-argon", "无后缀时 base = 归一化后的原名");
  }

  // 14.4 ★ 无附件 + 带档位 → 必须挂信封，且 #48 = 协议值
  {
    const bytes = buildProcessQueryRequest({ text: "hi", thinkingLevel: 2 });
    const f = lfzqyFieldsOf(bytes);
    const lvl = f.find((x) => x.no === 48);
    assert.ok(lvl, "带档位时必须挂 Lgcvb 信封并写 #48");
    assert.equal(asUint(lvl.value), 2, `#48 应为 high=2`);
    assert.ok(!f.find((x) => x.no === 67), "#67（routingVariantId）默认留空——填错会让上游路由到 Legacy 并断流");
    assert.ok(!f.find((x) => x.no === 1), "无附件时信封不应含 Lgbkn");
  }

  // 14.5 不发档位 → 不挂信封（与 probe7 R0 最小形态逐字节一致）
  {
    const bytes = buildProcessQueryRequest({ text: "hi" });
    const lgcvm = decodeFields(bytes).find((f) => f.no === 1000);
    assert.ok(!decodeFields(lgcvm.value).find((f) => f.no === 1001), "不指定档位时不应有信封");
  }

  // 14.6 ★ 附件 + 档位必须共存于【同一个】信封（singular extension 重复设置会互相覆盖）
  {
    const bytes = buildProcessQueryRequest({
      text: "看图",
      thinkingLevel: 4,
      attachments: [{ blobId: "/contrib_service/ttl_1d/x", mime: "image/png", name: "a.png" }],
    });
    const lgcvm = decodeFields(bytes).find((f) => f.no === 1000);
    const exts = decodeFields(lgcvm.value).filter((f) => f.no === 1001);
    assert.equal(exts.length, 1, "信封必须只有一个（否则 protobuf singular 扩展互相覆盖）");
    const f = lfzqyFieldsOf(bytes);
    assert.ok(f.find((x) => x.no === 1), "应含 #1 Lgbkn（附件）");
    assert.equal(asUint(f.find((x) => x.no === 48).value), 4, "应含 #48=medium(4)");
  }

  // 14.7 多附件 + 档位同样共存
  {
    const bytes = buildProcessQueryRequest({
      text: "x",
      thinkingLevel: 1,
      attachments: [
        { blobId: "/b/1", mime: "image/png" },
        { blobId: "/b/2", mime: "video/mp4" },
      ],
    });
    const f = lfzqyFieldsOf(bytes);
    const lgbkn = f.find((x) => x.no === 1);
    assert.ok(lgbkn, "应含 #1 Lgbkn");
    assert.equal(decodeFields(lgbkn.value).filter((x) => x.no === 3).length, 2, "Lgbkn.#3 应有 2 个 Lgbku");
    assert.equal(asUint(f.find((x) => x.no === 48).value), 1, "#48 应为 low=1");
  }

  // 14.8 buildLfzqy 字段号契约（#47 rank / #48 档位 / #66 名称 / #67 routingVariantId）
  {
    const f = decodeFields(buildLfzqy({ thinkingLevel: 2, routingVariantId: "rv1", rank: 8, displayName: "4 Argon" }));
    assert.equal(asUint(f.find((x) => x.no === 47).value), 8);
    assert.equal(asUint(f.find((x) => x.no === 48).value), 2);
    assert.equal(asString(f.find((x) => x.no === 66).value), "4 Argon");
    assert.equal(asString(f.find((x) => x.no === 67).value), "rv1");
    // 全空 → 空字节（不落任何字段）
    assert.equal(buildLfzqy({}).length, 0);
  }

  // 14.9 buildAttachmentEnvelope 透传档位（单附件路径不走统一分支）
  {
    const f = decodeFields(
      decodeFields(buildAttachmentEnvelope({ blobId: "/b/1", thinkingLevel: 2 })).find((x) => x.no === 1).value
    );
    assert.equal(asUint(f.find((x) => x.no === 48).value), 2, "单附件信封也应能带 #48");
  }

  // 14.10 thinkingSummary 契约（对外能力声明）
  {
    const s = thinkingSummary();
    assert.equal(s.supported, true);
    assert.equal(s.defaultWhenOmitted, "low", "不发 #48 时服务端按 Low 处理（实测 #42=1）");
    assert.equal(s.levels.length, 3);
    assert.ok(s.requestWays.some((w) => /thinkingConfig\.thinkingLevel/.test(w)));
  }

  // 14.11 ★★ 档位承载位契约（2026-10-17 实测修正，推翻旧 §5.14 结论）
  //   判据只看响应面：`Lfzrc.#30` 上游自述模型名 + `#41` rank + `#25` 实际生效档位 id。
  //   ① `#16` 放 `Lfzqy.#13` ⇒ 服务端整包忽略该 Lgauy，档位回落账号默认（实测恒为
  //      3.5 Flash-Lite / rank 6 / `#25` 缺席）—— "满血 Argon 静默变笨"的真凶。
  //      移到 `Lgcvm.#1` 后立刻 `Used 4 Argon High model` / rank 8 / `#25=95a4…`。
  //   ② ⚠️ 唯一例外：**音频附件**。Argon 路径读不到音频，只有退让到 `#13`
  //      （降级 Flash-Lite）模型才听得到。图片不受限（`#16` 在 `#1` 时图片照常被采纳）。
  //   ⇒ 契约：无音频 ⇒ `#16` 在 `#1`；含音频 ⇒ `#16` 在 `#13`；`#13` 恒随附。
  {
    const MODE = "95a4c0abcba24364";
    const f16 = (fields) => fields.find((x) => x.no === 16);
    const lgauyOf = (bytes) => {
      const lgcvm = decodeFields(bytes).find((f) => f.no === 1000);
      return decodeFields(decodeFields(lgcvm.value).find((f) => f.no === 1).value);
    };
    const f13Of = (bytes) => lfzqyFieldsOf(bytes).find((x) => x.no === 13);

    // (a) 纯文本 + 思考：档位必须在 #1（唯一生效位），#13 不得抢
    const textOnly = buildProcessQueryRequest({ text: "x", thinkingLevel: 2, lgauy: { s16: MODE } });
    assert.equal(asString(f16(lgauyOf(textOnly)).value), MODE,
      "无音频时 #16 必须由 Lgcvm.#1 承载（放 #13 会被整包忽略 ⇒ 静默降级）");
    const t13 = f13Of(textOnly);
    assert.ok(t13, "信封必须含 #13 Lgauy（缺失会让服务端冷落整个信封）");
    assert.equal(f16(decodeFields(t13.value)), undefined, "#13 不得重复携带档位");

    // (b) 无信封：档位仍由 #1 承载，且不发信封
    const noEnv = buildProcessQueryRequest({ text: "x", lgauy: { s16: MODE } });
    const noEnvCvm = decodeFields(decodeFields(noEnv).find((f) => f.no === 1000).value);
    assert.equal(noEnvCvm.filter((f) => f.no === 1001).length, 0, "无档位且无附件时不应发信封");
    assert.equal(asString(f16(decodeFields(noEnvCvm.find((f) => f.no === 1).value)).value), MODE,
      "无信封时档位仍由 #1 承载");

    // (c) 图片附件：档位仍在 #1（图片与 Argon 兼容，实测答出颜色），#13 随附但不带档位
    const imgAtt = buildProcessQueryRequest({
      text: "x", attachments: [{ blobId: "/b/1", mime: "image/png" }], lgauy: { s16: MODE },
    });
    assert.equal(asString(f16(lgauyOf(imgAtt)).value), MODE, "图片附件不得把档位挤出 #1");
    assert.ok(f13Of(imgAtt), "单附件信封也必须含 #13 Lgauy");
    assert.equal(f16(decodeFields(f13Of(imgAtt).value)), undefined, "图片场景 #13 不应带档位");

    // (d) ★ 音频附件：档位必须退让到 #13（代价=本轮降级），换取模型能听到音频
    const audAtt = buildProcessQueryRequest({
      text: "x", attachments: [{ blobId: "/b/2", mime: "audio/webm;codecs=opus" }], lgauy: { s16: MODE },
    });
    assert.equal(f16(lgauyOf(audAtt)), undefined,
      "音频场景 #1 不得带 #16（会让 Argon 路径吞掉音频，模型答\"没收到录音\"）");
    assert.equal(asString(f16(decodeFields(f13Of(audAtt).value)).value), MODE,
      "音频场景档位必须退到 #13，否则本轮听不到声音");

    // (e) 音频 + 图片混合：音频优先退让
    const mixed = buildProcessQueryRequest({
      text: "x",
      attachments: [{ blobId: "/b/1", mime: "image/png" }, { blobId: "/b/2", mime: "audio/ogg" }],
      lgauy: { s16: MODE },
    });
    assert.equal(f16(lgauyOf(mixed)), undefined, "含音频的混合请求同样必须退让");
    assert.equal(asString(f16(decodeFields(f13Of(mixed).value)).value), MODE, "混合请求档位退到 #13");

    // (f) 音频判定必须容忍 mime 参数（audio/webm;codecs=opus 是 MediaRecorder 常态）
    const paramMime = buildProcessQueryRequest({
      text: "x", attachments: [{ blobId: "/b/3", mime: "AUDIO/WEBM;CODECS=OPUS" }], lgauy: { s16: MODE },
    });
    assert.equal(f16(lgauyOf(paramMime)), undefined, "带参数/大写的 audio mime 也必须触发退让");
  }

  ok("★ 档位承载位（无音频⇒Lgcvm.#1 生效 / 音频退让⇒Lfzqy.#13 / #13 恒随附 / mime 大小写与参数）");

  ok("★ 思考强度（#48 承载位 / 附件共存单信封 / 参数解析 / 非法值不静默）");
}

/* ── 15. ★ 档位静默降级「观测器」（degrade-guard，2026-10-17 起只判定+上报）
   上游会按账号静默把 argon 降为 3.5 Flash-Lite（HTTP 200、无报错，仅响应元数据可辨：
   #25 缺失/不符、#30 变 "Used 3.5 Flash-Lite …"）。
   处置（用户 2026-10-17 指定）：robin 与调用方解耦 —— 不换将、不跨档重试、不置窗，
   降级回显原样透出，由 Eidolon 侧跨通道回退（ag/gemini-3.8-flash）；robin 内唯一
   保留的重试是 empty-retry 的【同模型】重试（见 §17）。本组验证判定四态 + 上报面。 */
{
  const ARGON = "95a4c0abcba24364";

  // (a) 判定·满血（#25 = 请求 id）⇒ ok；无窗口概念（结构性：healthz 无 argonDown）
  __resetGuardForTest();
  const vOk = noteResponse({
    requestedModeId: ARGON,
    result: { effectiveMode: ARGON, model: "Used 4 Argon model" },
    hasAudioAttachment: false,
  });
  assert.equal(vOk.state, "ok");
  assert.equal(guardStatus().argonDown, undefined, "窗口概念已移除：healthz 不应再有 argonDown");
  assert.equal(guardStatus().policy, "observe-only");
  assert.equal(guardStatus().lastEvent.state, "ok", "判定应记入 lastEvent（healthz 可见）");

  // (b) 判定·降级（#25 缺席 + #30 = Flash-Lite）⇒ degraded；不换将不重试（无对应 API），
  //     只记录 lastEvent 供上报
  __resetGuardForTest();
  const vDeg = noteResponse({
    requestedModeId: ARGON,
    result: { effectiveMode: null, model: "Used 3.5 Flash-Lite model" },
    hasAudioAttachment: false,
  });
  assert.equal(vDeg.state, "degraded");
  assert.equal(guardStatus().lastEvent.state, "degraded");
  assert.equal(guardStatus().lastEvent.model, "Used 3.5 Flash-Lite model");
  assert.equal(vDeg.exempt, undefined, "非音频降级不应标 exempt");

  // (c) 判定·无法判定（有文本但无 #25/#30）⇒ unknown，不动作（防误报）
  __resetGuardForTest();
  const vUnk = noteResponse({
    requestedModeId: ARGON,
    result: { effectiveMode: null, model: null, texts: ["有内容但无元数据"] },
    hasAudioAttachment: false,
  });
  assert.equal(vUnk.state, "unknown");
  assert.equal(guardStatus().lastEvent.state, "unknown");

  // (d) 音频退让：降级但标 exempt（预期行为，仅上报标注）
  __resetGuardForTest();
  const vAud = noteResponse({
    requestedModeId: ARGON,
    result: { effectiveMode: null, model: "Used 3.5 Flash-Lite model" },
    hasAudioAttachment: true,
  });
  assert.equal(vAud.state, "degraded");
  assert.equal(vAud.exempt, "audio-deference");

  // (e) ★ 空响应（静默拒答或解析失败）：无 #30 + 无正文 ⇒ "empty"，计数 + 插桩字段入 lastEmpty
  //     （重试由 empty-retry 同模型进行，不在本模块）
  __resetGuardForTest();
  const vEmpty = noteResponse({
    requestedModeId: ARGON,
    result: {
      effectiveMode: null, model: null, texts: [], cumulative: null,
      frames: 3, unknownFrames: 2, extCounts: { 1003: 1 }, endedBy: "server-end",
    },
    hasAudioAttachment: false,
  });
  assert.equal(vEmpty.state, "empty");
  assert.equal(guardStatus().emptyReplies, 1, "空响应应计数（healthz 可见）");
  assert.equal(guardStatus().lastEmpty.frames, 3, "插桩字段应随空响应上报（frames）");
  assert.equal(guardStatus().lastEmpty.unknownFrames, 2, "unknown>0 = 帧被丢在分类层（解析失败证据）");
  assert.deepEqual(guardStatus().lastEmpty.extCounts, { 1003: 1 });
  assert.equal(guardStatus().lastEmpty.endedBy, "server-end");

  // (f) 空响应插桩语义对照：frames=0 ⇒ 真空（上游什么都没给）；
  //     frames>0 且 unknown>0 或 exts 有 1003 无文本 ⇒ 解析失败（需修 pq.js）
  __resetGuardForTest();
  noteResponse({
    requestedModeId: ARGON,
    result: { effectiveMode: null, model: null, texts: [], frames: 0, unknownFrames: 0, extCounts: {}, endedBy: "server-end" },
    hasAudioAttachment: false,
  });
  assert.equal(guardStatus().lastEmpty.frames, 0, "frames=0 = 真空响应");
  __resetGuardForTest();
}
ok("★ 档位降级观测器（判定四态 / 无窗口无换将无重试 / 音频 exempt / 空响应计数+插桩上报）");

/* ── 15b. ★ 凭证失效型失败（auth-failure，2026-10-17 实测新增）
   真实案例：master token 被服务端拒（HTTP 403 BadAuthentication）⇒ 无 ya29 令牌
   ⇒ 请求根本没发到推理层 ⇒ **零额度消耗**（用户观察「用量没涨」）。
   ★ 与 §15(e) 的 "empty" 额度影响截然相反（empty 大概率已计费），必须分流：
   - 历史上此类落进 "unknown"（no-token 短路带 error 字段，被 empty 的 !error 条件排除），
     healthz 完全看不见 ⇒ 现在独立计数 + 显式告警。 */
{
  const ARGON = "95a4c0abcba24364";

  // (a) no-token 短路（robin.js 无凭证分支的真实形状）⇒ auth-failure，
  //     且【不进 empty 计数】——这是与 empty 分流的核心断言
  __resetGuardForTest();
  const vNoTok = noteResponse({
    requestedModeId: ARGON,
    result: {
      status: 0, grpcStatus: "UNAUTHENTICATED",
      grpcMessage: "无可用 Robin 凭证。推荐：访问服务根路径下的 /login 完成一次性网页登录绑定",
      frames: 0, texts: [], endedBy: "no-token", error: "no credential",
    },
    hasAudioAttachment: false,
  });
  assert.equal(vNoTok.state, "auth-failure", "无令牌必须是 auth-failure，不能落 unknown/empty");
  assert.equal(guardStatus().authFailures, 1, "auth 失败应独立计数（healthz 可见）");
  assert.equal(guardStatus().emptyReplies, 0, "★ 关键：不得被计入 emptyReplies（额度语义不同）");
  assert.equal(guardStatus().lastEmpty, null, "★ 关键：不得写进 lastEmpty（否则误导为已计费）");
  assert.equal(guardStatus().lastAuthFailure.endedBy, "no-token");
  assert.equal(guardStatus().lastAuthFailure.grpcStatus, "UNAUTHENTICATED");

  // (b) 令牌过期被上游拒（grpcStatus=16 / http 401，零帧）⇒ auth-failure
  __resetGuardForTest();
  const vG16 = noteResponse({
    requestedModeId: ARGON,
    result: { status: 0, grpcStatus: "16", frames: 0, texts: [], endedBy: "trailers" },
    hasAudioAttachment: false,
  });
  assert.equal(vG16.state, "auth-failure", "gRPC 16 = UNAUTHENTICATED");
  assert.equal(guardStatus().authFailures, 1);

  // (c) http 403（零帧）⇒ auth-failure
  __resetGuardForTest();
  const v403 = noteResponse({
    requestedModeId: ARGON,
    result: { status: 403, grpcStatus: null, frames: 0, texts: [], endedBy: "end" },
    hasAudioAttachment: false,
  });
  assert.equal(v403.state, "auth-failure");
  assert.equal(guardStatus().emptyReplies, 0);

  // (d) ★ 有帧就不算 auth-failure（帧到达说明请求被接受并开始应答 ⇒ 属 empty 域）
  //     防止把「解析失败」误判成凭证问题
  __resetGuardForTest();
  const vFramed = noteResponse({
    requestedModeId: ARGON,
    result: {
      status: 403, grpcStatus: null, frames: 3, texts: [], endedBy: "end",
      unknownFrames: 1, extCounts: { 1003: 1 },
    },
    hasAudioAttachment: false,
  });
  assert.equal(vFramed.state, "empty", "有帧 ⇒ 不是凭证问题（帧已到达 = 推理已开始）");
  assert.equal(guardStatus().authFailures, 0, "有帧不得计入 authFailures");
  assert.equal(guardStatus().emptyReplies, 1);

  // (e) auth-failure 不触发 empty-retry（无令牌重发仍会被拒，重试纯浪费额度）
  __resetGuardForTest();
  const vForRetry = noteResponse({
    requestedModeId: ARGON,
    result: { status: 0, grpcStatus: "UNAUTHENTICATED", frames: 0, texts: [], endedBy: "no-token" },
    hasAudioAttachment: false,
  });
  assert.notEqual(vForRetry.state, "empty", "empty-retry 只认 state==='empty' ⇒ auth-failure 天然不重试");

  // (f) healthz 上报面：authFailures 与 emptyReplies 互斥可见
  __resetGuardForTest();
  assert.equal(guardStatus().authFailures, 0);
  assert.equal(guardStatus().lastAuthFailure, null);
  noteResponse({
    requestedModeId: ARGON,
    result: { status: 0, grpcStatus: "UNAUTHENTICATED", frames: 0, texts: [], endedBy: "no-token" },
    hasAudioAttachment: false,
  });
  assert.equal(guardStatus().authFailures, 1);
  assert.equal(guardStatus().policy, "observe-only", "策略仍是纯观测（不因新分支而动作）");
  __resetGuardForTest();
}
ok("★ 凭证失效型失败（auth-failure 独立计数 / 与 empty 严格分流 / 有帧不误判 / 不触发重试）");

/* ── 16. ★ 媒体占位视频转封装（media shim，2026-10-17）
   音频附件 × Argon 互斥（上游硬限）⇒ 音频包成 16×16 视频走视频通道（满血档位 + 听觉）。
   本组用注入转换器（不依赖本机 ffmpeg）验证：转换/缓存/并发去重/失败回退/LRU/接线。 */
{
  const A1 = Buffer.from("fake-audio-1");
  const A2 = Buffer.from("fake-audio-2");
  const asVideo = (bytes) => Buffer.concat([Buffer.from("V:"), bytes]);

  // (a) 转换成功 → video/webm + 计数
  __resetShimForTest();
  let calls = 0;
  __setConverterForTest(async (b) => { calls++; return asVideo(b); });
  const r1 = await toPlaceholderVideo(A1, "audio/webm");
  assert.equal(calls, 1);
  assert.equal(r1.mime, "video/webm");
  assert.equal(r1.cached, false);
  assert.deepEqual([...r1.buffer], [...asVideo(A1)]);
  assert.equal(shimStatus().stats.converted, 1);
  ok("§16 (a) 音频 → video/webm（注入转换器；产物与计数正确）");

  // (b) 同内容命中缓存（转换器不再被调用）
  const r2 = await toPlaceholderVideo(A1, "audio/webm");
  assert.equal(calls, 1, "同内容必须命中缓存");
  assert.equal(r2.cached, true);
  assert.equal(shimStatus().stats.cacheHits, 1);
  ok("§16 (b) 同内容第二次命中缓存（转换器只调一次）");

  // (c) 并发去重：同内容并发两次 → 只转换一次，第二个标记 deduped
  __resetShimForTest();
  calls = 0;
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  __setConverterForTest(async (b) => { calls++; await gate; return asVideo(b); });
  const p1 = toPlaceholderVideo(A2, "audio/ogg");
  const p2 = toPlaceholderVideo(A2, "audio/ogg");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, "并发同内容只应触发一次转换");
  releaseGate();
  const [c1, c2] = await Promise.all([p1, p2]);
  assert.ok(c1 && c2);
  assert.equal(shimStatus().stats.deduped, 1);
  ok("§16 (c) 并发同内容去重（in-flight 复用，deduped=1）");

  // (d) 失败（返回 null）→ 不缓存、计数；下次仍尝试转换
  __resetShimForTest();
  calls = 0;
  __setConverterForTest(async () => { calls++; return null; });
  assert.equal(await toPlaceholderVideo(A1, "audio/webm"), null);
  assert.equal(await toPlaceholderVideo(A1, "audio/webm"), null);
  assert.equal(calls, 2, "失败不得缓存（下次应重试转换）");
  assert.equal(shimStatus().stats.failed, 2);
  ok("§16 (d) 转换失败 → null 且不缓存（下次重试；保持原音频）");

  // (e) 异常（throw）→ 捕获为 null（绝不冒泡打断请求）
  __resetShimForTest();
  __setConverterForTest(async () => { throw new Error("boom"); });
  assert.equal(await toPlaceholderVideo(A1, "audio/webm"), null);
  assert.equal(shimStatus().stats.failed, 1);
  ok("§16 (e) 转换异常 → 捕获（保持原音频，不打断请求）");

  // (f) 未启用 → 直接 null（不触碰转换器）
  __resetShimForTest();
  calls = 0;
  __setConverterForTest(async (b) => { calls++; return asVideo(b); });
  __setShimEnabledForTest(false);
  assert.equal(await toPlaceholderVideo(A1, "audio/webm"), null);
  assert.equal(calls, 0);
  ok("§16 (f) ROBIN_MEDIA_SHIM=0 → 全链直通（不转换）");

  // (g) LRU 淘汰：超字节上限先淘汰最旧
  __resetShimForTest();
  __setShimCacheLimitForTest(20, 100);
  __setConverterForTest(async () => Buffer.alloc(8, 1));
  await toPlaceholderVideo(Buffer.from("aaaaaaaa"), "audio/webm");
  await toPlaceholderVideo(Buffer.from("bbbbbbbb"), "audio/webm");
  assert.equal(shimStatus().cache.items, 2);
  await toPlaceholderVideo(Buffer.from("cccccccc"), "audio/webm"); // 累计 24B > 20B 上限 → 淘汰最旧
  const s7 = shimStatus();
  assert.equal(s7.cache.items, 2, "超限应淘汰最旧（保 2 条）");
  assert.ok(s7.cache.bytes <= 20, `缓存字节应受上限约束，实际 ${s7.cache.bytes}`);
  assert.equal(s7.stats.evictedItems, 1);
  ok("§16 (g) LRU 淘汰（字节上限生效，最旧先出）");

  // (h) applyMediaShim：音频替换 / 图片视频不动 / blobId 引用跳过
  __resetShimForTest();
  __setConverterForTest(async (b) => asVideo(b));
  const atts = [
    { mime: "audio/webm", bytes: Buffer.from("aaa"), name: "v1.webm" },
    { mime: "image/png", bytes: Buffer.from("img") },
    { mime: "audio/ogg", blobId: "/b/ref" },
    { mime: "video/mp4", bytes: Buffer.from("vid") },
  ];
  const st = await applyMediaShim(atts);
  assert.equal(st.converted, 1);
  assert.equal(st.skippedRefs, 1);
  assert.equal(atts[0].mime, "video/webm", "音频须被替换为占位视频");
  assert.equal(atts[0].name, "v1.webm", "其余字段不动");
  assert.equal(atts[1].mime, "image/png", "图片不得被动");
  assert.ok(atts[2].blobId && !atts[2].bytes, "blobId 引用保持原样（无内联字节无法转封装）");
  assert.equal(atts[3].mime, "video/mp4", "视频不得被动");
  // 注：blobId 引用（无内联字节）无法转封装 ⇒ 保持 audio/*（该请求的承载位仍会退让，行为同旧版）
  const stillAudio = atts.filter((a) => String(a.mime).toLowerCase().startsWith("audio/"));
  assert.equal(stillAudio.length, 1, "仅无法转封装的 blobId 引用保持音频");
  assert.equal(stillAudio[0].blobId, "/b/ref");
  ok("§16 (h) applyMediaShim 接线（音频替换 / 其它不动 / blobId 跳过）");

  __resetShimForTest();
}
ok("★ 媒体占位视频转封装（转换 / 缓存 / 并发去重 / 失败回退 / LRU / 接线）");

/* 17. 空响应自动重试（偶发故障 vs 资源型 甄别；lib/empty-retry.js） */
{
  const {
    withEmptyRetry, decideEmptyRetry, emptyRetryStatus, __resetEmptyRetryForTest,
  } = await import("../lib/empty-retry.js");

  const mkEmpty = () => ({ __modeVerdict: { state: "empty" } });
  const mkOk = () => ({ __modeVerdict: { state: "ok" }, texts: ["hi"] });
  const mkDegraded = () => ({ __modeVerdict: { state: "degraded" }, texts: ["lite"] });
  const silent = () => {};

  // (a) 空 → 自动重试一次后成功（判偶发；返回成功结果，stats 记账）
  __resetEmptyRetryForTest();
  {
    let calls = 0;
    const r = await withEmptyRetry(async () => (++calls === 1 ? mkEmpty() : mkOk()), { log: silent });
    const s = emptyRetryStatus();
    assert.equal(calls, 2, "应为 2 次尝试");
    assert.equal(r.texts[0], "hi", "应返回成功者");
    assert.equal(s.retries, 1);
    assert.equal(s.successes, 1);
    assert.equal(s.exhausted, 0);
    assert.equal(s.emptyEvents, 1);
    ok("§17 (a) 空响应 → 自动重试一次后成功（偶发自愈，robin 质量保留）");
  }

  // (b) 连续空响应 → 重试耗尽（默认 maxRetries=1 ⇒ 共 2 次尝试），返回最后的空结果交上层
  //     （2026-10-16 修订：默认从 2 降为 1 —— 3 次尝试会突破调用方 120s 硬超时）
  __resetEmptyRetryForTest();
  {
    let calls = 0;
    const r = await withEmptyRetry(async () => { calls++; return mkEmpty(); }, { log: silent });
    const s = emptyRetryStatus();
    assert.equal(calls, 2, "1 原发 + 1 重试 = 2 次尝试（新默认）");
    assert.equal(r.__modeVerdict.state, "empty");
    assert.equal(s.retries, 1);
    assert.equal(s.exhausted, 1);
    assert.equal(s.emptyEvents, 2);
    ok("§17 (b) 连续空响应 → 重试耗尽（默认 2 次尝试后交上层，判资源型）");
  }

  // (b2) 显式 maxRetries=2 仍可（旧语义保留，供调参）；确认与默认值的区分
  __resetEmptyRetryForTest();
  {
    let calls = 0;
    await withEmptyRetry(async () => { calls++; return mkEmpty(); }, { maxRetries: 2, log: silent });
    assert.equal(calls, 3, "显式 2 次重试 ⇒ 3 次尝试");
    ok("§17 (b2) 显式 maxRetries=2 → 3 次尝试（参数覆盖仍生效）");
  }

  // (c) 正常 / 降级响应不触发重试（降级 ≠ 空；降级按 2026-10-17 策略原样透出，
  //     由上层跨通道处理，robin 内不动作）
  __resetEmptyRetryForTest();
  {
    let calls = 0;
    await withEmptyRetry(async () => { calls++; return mkOk(); }, { log: silent });
    await withEmptyRetry(async () => { calls++; return mkDegraded(); }, { log: silent });
    assert.equal(calls, 2, "两类响应各只尝试 1 次");
    assert.equal(emptyRetryStatus().retries, 0);
    ok("§17 (c) 正常 / 降级响应不触发重试（两类失败分流）");
  }

  // (d) 超预算 → 不发起重试（预算护栏；保证不拖穿调用方超时）
  __resetEmptyRetryForTest();
  {
    let calls = 0;
    const r = await withEmptyRetry(async () => { calls++; return mkEmpty(); }, { deadline: Date.now() - 1, log: silent });
    assert.equal(calls, 1);
    assert.equal(r.__modeVerdict.state, "empty");
    assert.equal(emptyRetryStatus().budgetStopped, 1);
    ok("§17 (d) 超预算 → 不发起重试（护栏生效）");
  }

  // (d2) 预留护栏：剩余预算 < reserve（60s）→ 不重试（「已用 + 预留 ≥ 预算」判停）
  //     —— 本组即 2026-10-16 实战教训的回归：绝不把总时长拖过调用方 120s。
  __resetEmptyRetryForTest();
  {
    let calls = 0;
    await withEmptyRetry(async () => { calls++; return mkEmpty(); },
      { deadline: Date.now() + 30_000, log: silent });  // 剩 30s < reserve 60s
    assert.equal(calls, 1, "剩余预算不足以覆盖一次尝试的最坏耗时 ⇒ 不重试");
    assert.equal(emptyRetryStatus().budgetStopped, 1);

    __resetEmptyRetryForTest();
    let calls2 = 0;
    await withEmptyRetry(async () => { calls2++; return mkEmpty(); },
      { deadline: Date.now() + 120_000, log: silent }); // 剩 120s > reserve 60s → 允许一次
    assert.equal(calls2, 2, "剩余预算充足 ⇒ 正常重试一次");
    ok("§17 (d2) 预留护栏（剩余 < reserve 不重试 / 充足则重试）");
  }

  // (e) 关闭（maxRetries=0）→ 直通单次尝试
  __resetEmptyRetryForTest();
  {
    let calls = 0;
    await withEmptyRetry(async () => { calls++; return mkEmpty(); }, { maxRetries: 0, log: silent });
    assert.equal(calls, 1);
    ok("§17 (e) ROBIN_EMPTY_RETRY=0 → 直通（不做重试）");
  }

  // (f) decideEmptyRetry 判定优先级（纯函数；reserve 参与预算判定）
  {
    assert.equal(
      decideEmptyRetry({ attempt: 1, deadline: Date.now() + 120_000, maxRetries: 2, reserveMs: 60_000 }).retry,
      true
    );
    assert.equal(decideEmptyRetry({ attempt: 1, deadline: Date.now() + 1000, maxRetries: 0 }).reason, "disabled");
    assert.equal(
      decideEmptyRetry({ attempt: 3, deadline: Date.now() + 120_000, maxRetries: 2, reserveMs: 60_000 }).reason,
      "exhausted"
    );
    // 截止已过 ⇒ budget
    assert.equal(decideEmptyRetry({ attempt: 1, deadline: Date.now() - 1, maxRetries: 2 }).reason, "budget");
    // 剩余不足 reserve ⇒ budget（即便截止未到）
    assert.equal(
      decideEmptyRetry({ attempt: 1, deadline: Date.now() + 30_000, maxRetries: 2, reserveMs: 60_000 }).reason,
      "budget"
    );
    ok("§17 (f) decideEmptyRetry 判定（ok / disabled / exhausted / budget×2）");
  }
}
ok("★ 空响应自动重试（偶发重试自愈 / 耗尽交上层 / 降级不重试 / 预算护栏）");

// ── §18 token 用量估算（上游不回传 usage，本地按公开计费口径估）────────────
{
  const b64 = (buf) => Buffer.from(buf).toString("base64");

  // 33.45s 语音按 24 kbps ≈ 100 KB —— 与生产实测的 179 KB webm 同量级
  const audio = b64(Buffer.alloc(100 * 1024));

  // §18 (a) 纯文本：按 chars/3
  {
    const est = estimatePromptTokens({
      contents: [{ role: "user", parts: [{ text: "x".repeat(300) }] }],
    });
    assert.equal(est.breakdown.text, 100);
    assert.equal(est.estimated, true);
    ok("§18 (a) 文本按 chars/3 估算");
  }

  // §18 (b) 音频：32 token/s
  {
    const est = estimatePromptTokens({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/webm", data: audio } }] }],
    });
    // 100 KB × 8 / 24000 ≈ 34.1s → ~1091 tok
    assert.ok(est.breakdown.audio > 1000 && est.breakdown.audio < 1200, `audio=${est.breakdown.audio}`);
    assert.equal(est.breakdown.videoFrames, 0);
    ok("§18 (b) 音频按 32 token/s 估算");
  }

  // §18 (c) ★ 占位视频：帧率是成本主因，0.25fps 必须是 1fps 的 1/4
  {
    const mk = () => ({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/webm", data: audio } }] }],
    });
    const a = estimatePromptTokens(mk());
    const R = USAGE_RATES;
    const sec = a.inputs.videoSeconds;
    assert.equal(a.breakdown.videoAudio, Math.round(sec * R.audioTokensPerSecond));
    // 帧率未知 ⇒ 按 1fps 保守估；这正是 shim 存在意义的对照基线。
    assert.equal(a.breakdown.videoFrames, Math.round(sec * R.videoTokensPerFrame));
    ok("§18 (c) 占位视频：帧 token + 音频轨分开计（1fps 保守基线）");
  }

  // §18 (d) 帧率对照：0.25 vs 1 的省幅（media shim 降帧率的收益量化）
  {
    const R = USAGE_RATES;
    const sec = 33.45;
    const oneFps = sec * R.videoTokensPerFrame + sec * R.audioTokensPerSecond;
    const quarter = sec * 0.25 * R.videoTokensPerFrame + sec * R.audioTokensPerSecond;
    assert.ok(quarter < oneFps, "降帧率必须更便宜");
    // 省幅上限由「音频那一半省不掉」决定：(258−64.5)/(258+32) ≈ 66.7%。
    // 视觉部分本身省 75%，但总账单只省 ~2/3 —— 这个数是如实反映，不是缺陷。
    const saved = 1 - quarter / oneFps;
    assert.ok(saved > 0.6, `省幅应 >60%，实得 ${(saved * 100).toFixed(1)}%`);
    const visualSaved = 1 - 0.25;
    assert.ok(Math.abs(visualSaved - 0.75) < 1e-9, "视觉部分省 75%");
    // 而走原音（不 shim）只要 32 tok/s
    const rawAudio = sec * R.audioTokensPerSecond;
    assert.ok(rawAudio < quarter, "占位视频仍比原音贵（这是 shim 的已知代价）");
    ok(`§18 (d) 降帧率省幅量化（视觉省 75%，总账单省 ${(saved * 100).toFixed(1)}%）`);
  }

  // §18 (e) 图片：≤384px 走 258 flat 档
  {
    // 构造一个 2x2 PNG（真实可解析尺寸）
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAf6O8b8AAAAASUVORK5CYII=",
      "base64"
    );
    const est = estimatePromptTokens({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: b64(png) } }] }],
    });
    assert.equal(est.breakdown.images, USAGE_RATES.imageFlatTokens);
    ok("§18 (e) 小图走 258 flat 档");
  }

  // §18 (f) withEstimatedUsage：必须诚实标注估算，且不篡改正文
  {
    const resp = { candidates: [{ content: { role: "model", parts: [{ text: "abc" }] } }] };
    const est = estimatePromptTokens({ contents: [{ role: "user", parts: [{ text: "hello" }] }] });
    const out = withEstimatedUsage(resp, est);
    assert.equal(out.usageEstimated, true, "必须标注为估算");
    assert.ok(out.usageMetadata.promptTokenCount > 0, "prompt 应被填上估算值");
    assert.equal(out.candidates[0].content.parts[0].text, "abc", "正文不得受影响");
    assert.ok(out.usageBreakdown, "应带 breakdown");
    ok("§18 (f) withEstimatedUsage 标注估算且不污染正文");
  }

  // §18 (g) 空/畸形请求不炸
  {
    for (const bad of [undefined, null, {}, { contents: null }, { contents: [{}] },
      { contents: [{ parts: [{ inlineData: { data: "!!!not-base64" } }] }] }]) {
      const est = estimatePromptTokens(bad);
      assert.ok(Number.isFinite(est.promptTokens), "必须是有限数");
    }
    ok("§18 (g) 畸形输入不抛异常（估算器不可成为故障源）");
  }

  // §18 (h) shim 帧率已降到 0.25 且观测面暴露
  {
    const info = placeholderVideoInfo();
    assert.equal(info.fps, 0.25, `帧率应为 0.25，实得 ${info.fps}`);
    assert.equal(info.tokensPerFrame, 258);
    assert.ok(
      info.tokensPerSecondVideo < USAGE_RATES.videoTokensPerFrame / 3,
      `视觉开销应降到 1fps 的 1/3 以下，实得 ${info.tokensPerSecondVideo} tok/s`
    );
    // 已知代价：占位视频整体仍比原音贵（视觉 + 音频两笔都在账上）。
    assert.ok(info.ratioVsRawAudio > 1, "占位视频仍比原音贵（已知代价，需在 healthz 可见）");
    ok("§18 (h) shim 帧率 0.25（视觉 token 降到 1/4）且 healthz 可观测");
  }
}
ok("★ token 用量估算（上游不回传 ⇒ 本地按公开口径估；诚实标注 + 省幅量化）");

/* §19 凭证可用性判定（healthz.credential.verdict）
 *
 * 动机：2026-10-17 实测——`.env` 里配了 GSA_MASTER_TOKEN，healthz 一路显示
 * `auth: "configured (gpsoauth)"`，但那个 token 早已被 Google 撤销
 * （perform_oauth 403 BadAuthentication），请求全部 auth-failure 零额度返回。
 * 「配了」≠「还能用」——这个判定把两者分开，且纯被动、不发网络请求。
 */
console.log("\n§19 凭证可用性判定（区分『配了』与『还能用』）");
{
  const NOW = Date.now();

  // (a) 完全没配→ unbound
  __resetAuthForTest();
  {
    const c = credentialHealth();
    assert.equal(c.verdict, "unbound", `无凭证应为 unbound，实得 ${c.verdict}`);
    assert.equal(c.usable, false);
    assert.ok(c.reason, "unbound 必须给出原因");
  }
  ok("§19 (a) 无任何凭证 → unbound");

  // (b) 配了但从未铸造 → unverified（关键：不是 valid 也不是 stale）
  __resetAuthForTest();
  __setGsaForTest({ masterToken: "aas_et/test", email: "x@y.z", origin: "env" });
  {
    const c = credentialHealth();
    assert.equal(c.verdict, "unverified", `未验证应为 unverified，实得 ${c.verdict}`);
    assert.equal(c.checked, false, "unverified 必须标明『尚未验证过』");
  }
  ok("§19 (b) 已配 master token 但本进程未验证 → unverified（不谎报正常）");

  // (c) 铸造成功且令牌在有效期内 → valid
  __resetAuthForTest();
  __setGsaForTest({ masterToken: "aas_et/test", email: "x@y.z", origin: "env", mintOk: 1 });
  __setMintedForTest({ token: "ya29.abc", expiresAt: NOW + 3_600_000 });
  {
    const c = credentialHealth();
    assert.equal(c.verdict, "valid", `有效令牌应为 valid，实得 ${c.verdict}`);
    assert.equal(c.usable, true);
  }
  ok("§19 (c) 铸造成功 + 令牌有效 → valid");

  // (d) 铸造成功过、只是访问令牌到期 → expired（正常态，不该报警）
  __resetAuthForTest();
  __setGsaForTest({
    masterToken: "aas_et/test", email: "x@y.z", origin: "env",
    mintOk: 1, lastMintOkAt: NOW - 7_200_000,
  });
  __setMintedForTest({ token: "ya29.old", expiresAt: NOW - 60_000 });
  {
    const c = credentialHealth();
    assert.equal(c.verdict, "expired", `到期待续期应为 expired，实得 ${c.verdict}`);
    assert.equal(c.usable, true, "expired 仍可用（master token 有效，会自动续期）");
  }
  ok("§19 (d) 访问令牌到期但 master 有效 → expired（正常待续期，非故障）");

  // (e) ★ 核心用例：配置齐全但token 已被撤销 → stale（这是曾经的假信号）
  __resetAuthForTest();
  __setGsaForTest({
    masterToken: "aas_et/dead", email: "x@y.z", origin: "env",
    mintFail: 3, lastMintFailAt: NOW - 60_000,
    lastMintError: "perform_oauth 未返回 ya29 令牌（HTTP 403）：BadAuthentication",
  });
  {
    const c = credentialHealth();
    assert.equal(c.verdict, "stale", `铸造失败应为 stale，实得 ${c.verdict}`);
    assert.equal(c.usable, false, "stale 必须标为不可用");
    assert.match(c.reason, /403|BadAuthentication/, "stale 必须带出真实原因");
    // 反向验证：旧的 auth 字段此刻仍然只说 "configured"（这正是问题所在）
    assert.equal(tokenStatus().gpsoauth.bound, true, "旧字段只看『有没有配』，故仍报 bound");
  }
  ok("§19 (e) ★ 配置齐全但凭证已失效 → stale + 带出 403 原因（旧auth 字段此时仍在说谎）");

  // (f) stale 之后又成功 → 必须回到 valid（latest-wins，不能被历史失败钉死）
  __resetAuthForTest();
  __setGsaForTest({
    masterToken: "aas_et/renewed", email: "x@y.z", origin: "runtime",
    mintOk: 1, mintFail: 3, lastMintOkAt: NOW, lastMintFailAt: NOW - 600_000,
  });
  __setMintedForTest({ token: "ya29.new", expiresAt: NOW + 3_600_000 });
  {
    const c = credentialHealth();
    assert.equal(c.verdict, "valid", `重新绑定成功后应回到 valid，实得 ${c.verdict}`);
  }
  ok("§19 (f) 失败历史不钉死判定：重新绑定成功后 → valid（latest-wins）");

  // (g) healthz 上报面：tokenStatus 必须带上铸造统计
  __resetAuthForTest();
  __setGsaForTest({
    masterToken: "aas_et/t", email: "x@y.z", origin: "env",
    mintOk: 2, mintFail: 1, lastMintFailAt: NOW - 5_000, lastMintError: "boom",
  });
  {
    const g = tokenStatus().gpsoauth;
    assert.equal(g.mintOk, 2);
    assert.equal(g.mintFail, 1);
    assert.equal(g.lastMintError, "boom");
    assert.ok(g.lastMintFailAt, "失败时间戳应可观测");
    assert.ok(g.masterTokenTail.endsWith("/t".slice(-1)) || g.masterTokenTail.includes("t"), "尾部应可见");
  }
  ok("§19 (g) healthz.gpsoauth 暴露 mintOk/mintFail/lastMintError（可直接读，不解析日志）");

  // (h) 判定必须纯被动：不碰网络、不改状态
  __resetAuthForTest();
  __setGsaForTest({ masterToken: "aas_et/x", email: "x@y.z", origin: "env", mintFail: 1, lastMintFailAt: NOW });
  {
    const before = JSON.stringify(tokenStatus().gpsoauth);
    credentialHealth();
    credentialHealth();
    const after = JSON.stringify(tokenStatus().gpsoauth);
    assert.equal(after, before, "credentialHealth必须是纯读函数（重复调用不改状态）");
  }
  ok("§19 (h) credentialHealth 纯被动（重复调用零副作用、零网络）");

  __resetAuthForTest();
}
ok("★ 凭证可用性判定（healthz.credential.verdict：unbound/unverified/valid/expired/stale）");

/* ── §20 幂等去重（防重复计费，见 lib/dedup.js）─────────────────────────
 * 事故背景：重启掐断在途请求 ⇒ 上游已计费但应答丢失 ⇒ 调用方重发 ⇒ 重复计费。
 * 本组验证「同 payload 重发 → 零上游调用」以及几条不能越界的边界。
 */
{
  resetDedup();
  const body = (t) => ({ contents: [{ role: "user", parts: [{ text: t }] }] });

  // (a) 同 payload 同 verb ⇒ 同键
  const k1 = dedupKey(body("你好"), "generateContent", "m1", 2);
  const k2 = dedupKey(body("你好"), "generateContent", "m1", 2);
  assert.equal(k1, k2, "相同 payload 必须同键");
  ok("§20 (a) 相同 payload 同 verb ⇒ 同键");

  // (b) 键序无关（stableStringify）
  const a = { contents: [{ role: "user", parts: [{ text: "x" }] }], tools: { a: 1, b: 2 } };
  const b = { tools: { b: 2, a: 1 }, contents: [{ parts: [{ text: "x" }], role: "user" }] };
  assert.equal(dedupKey(a, "generateContent"), dedupKey(b, "generateContent"), "键序不同应同键");
  assert.equal(
    dedupKey({ contents: [{ role: "user", parts: [{ text: "x" }] }] }, "generateContent"),
    dedupKey({ contents: [{ role: "user", parts: [{ text: "x" }] }] }, "generateContent"),
    "同构对象应同键"
  );
  // 语义真的不同时必须异键（防「键序无关」被实现成「内容无关」）
  assert.notEqual(
    dedupKey({ tools: { a: 1 } }, "generateContent"),
    dedupKey({ tools: [{ a: 1 }] }, "generateContent"),
    "对象与数组语义不同，必须异键"
  );
  ok("§20 (b) 稳定字符串化：键序无关但语义敏感");

  // (c) 任一维度不同 ⇒ 不同键
  assert.notEqual(dedupKey(body("a"), "generateContent"), dedupKey(body("b"), "generateContent"), "文本不同应异键");
  assert.notEqual(
    dedupKey(body("a"), "generateContent"),
    dedupKey(body("a"), "streamGenerateContent"),
    "verb 不同应异键（响应形态不同，不可互相当重放源）"
  );
  assert.notEqual(dedupKey(body("a"), "generateContent", "m1"), dedupKey(body("a"), "generateContent", "m2"), "档位不同应异键");
  assert.notEqual(dedupKey(body("a"), "generateContent", "m1", 1), dedupKey(body("a"), "generateContent", "m1", 2), "思考强度不同应异键");
  ok("§20 (c) 文本/verb/档位/思考强度任一不同 ⇒ 异键");

  // (d) 命中重放：写入后 lookup 拿到结果，且不产生第二次上游调用
  const key = dedupKey(body("骑行"), "generateContent", "m1", 2);
  assert.equal(lookupDedup(key), null, "未写入前不得命中");
  const { owns } = beginDedup(key);
  assert.ok(owns, "首个调用方应拥有租约");
  assert.ok(isInflight(key), "登记后应处于在途态");
  const fakeResult = { texts: ["转录结果"], cumulative: "转录结果", model: "Used 4 Argon High model" };
  completeDedup(key, fakeResult, ["转录", "结果"]);
  assert.ok(!isInflight(key), "写回后应离开在途态");
  const hit = lookupDedup(key);
  assert.ok(hit, "写回后应可命中");
  assert.equal(hit.result.model, "Used 4 Argon High model", "重放结果应与原始一致");
  assert.deepEqual(hit.deltas, ["转录", "结果"], "流式增量应原样重放");
  ok("§20 (d) 写回后可命中，且流式增量原样重放（零上游调用）");

  // (e) 空响应不进缓存（必须继续走 empty-retry 的修复路径）
  const ek = dedupKey(body("空"), "generateContent");
  beginDedup(ek);
  completeDedup(ek, { texts: [], cumulative: "", model: null }, []);
  assert.equal(lookupDedup(ek), null, "空响应不得进入可重放态");
  ok("§20 (e) 空响应不缓存（否则把可恢复故障固化成假成功）");

  // (f) 错误不进缓存（必须继续透出让上层跨通道回退）
  const xk = dedupKey(body("错"), "generateContent");
  beginDedup(xk);
  failDedup(xk, new Error("上游 503"));
  assert.equal(lookupDedup(xk), null, "错误不得进入可重放态");
  assert.equal(isInflight(xk), false, "失败后应摘掉在途项");
  ok("§20 (f) 错误不缓存（让上层照常跨通道回退）");

  // (g) 在途等待：第二个同键调用方 owns=false，且能等到结果重放
  const wk = dedupKey(body("并发"), "generateContent");
  beginDedup(wk);
  const second = beginDedup(wk);
  assert.equal(second.owns, false, "在途时后来的调用方不得拥有租约（避免覆盖）");
  const p = waitDedup(wk, 2000);
  completeDedup(wk, { texts: ["ok"], cumulative: "ok", model: "M" }, ["ok"]);
  const waited = await p;
  assert.ok(waited, "等待应拿到结果");
  assert.equal(waited.result.model, "M");
  ok("§20 (g) 同键在途：后来者 owns=false 且等待后重放（不重复打上游）");

  // (h) 等待超时 ⇒ 返回 null（调用方自行打上游，不永久卡住）
  const tk = dedupKey(body("超时"), "generateContent");
  beginDedup(tk);
  const t0 = Date.now();
  const none = await waitDedup(tk, 120);
  assert.equal(none, null, "超时应返回 null 让调用方自行打上游");
  assert.ok(Date.now() - t0 >= 100, "应真实等待到超时");
  failDedup(tk, new Error("cleanup"));
  ok("§20 (h) 等待超时返回 null（不永久阻塞；超时方 owns=false 不覆盖在途项）");

  // (i) 关开关后完全不介入
  const prev = process.env.ROBIN_DEDUP;
  process.env.ROBIN_DEDUP = "0";
  assert.equal(dedupEnabled(), false, "ROBIN_DEDUP=0 应关闭");
  const dk = dedupKey(body("关"), "generateContent");
  assert.equal(lookupDedup(dk), null, "关闭时 lookup 恒 null");
  if (prev === undefined) delete process.env.ROBIN_DEDUP;
  else process.env.ROBIN_DEDUP = prev;
  assert.equal(dedupEnabled(), true, "恢复后应重新启用");
  ok("§20 (i) ROBIN_DEDUP=0 可完全关闭（降级路径不依赖去重）");

  // (j) healthz 可见
  const st = dedupStatus();
  assert.equal(typeof st.enabled, "boolean");
  assert.equal(typeof st.ttlMs, "number");
  assert.ok("hits" in st && "stores" in st, "命中/写入计数应可观测");
  ok("§20 (j) dedupStatus 暴露 enabled/ttlMs/hits/stores（healthz 可直接读）");

  resetDedup();
}
ok("★ 幂等去重（同 payload 重发 ⇒ 零上游调用；空响应/错误不缓存）");

/* ── §21 在途请求计数（优雅停机 + 部署前检查，见 lib/inflight.js）──────── */
{
  resetInflight();
  assert.deepEqual(inflightStatus(), { inflight: 0, peak: 0, totalStarted: 0 }, "初始应为全 0");

  enterRequest();
  enterRequest();
  assert.equal(inflightStatus().inflight, 2, "两次进入应为 2");
  assert.equal(inflightStatus().peak, 2, "峰值应记录到 2");

  exitRequest();
  assert.equal(inflightStatus().inflight, 1, "退出一次应剩 1");
  assert.equal(inflightStatus().peak, 2, "峰值不回退（历史最大）");

  exitRequest();
  exitRequest(); // 多余退出不得变负
  assert.equal(inflightStatus().inflight, 0, "不得为负");
  assert.equal(inflightStatus().totalStarted, 2, "累计进入数应保持");

  resetInflight();
  assert.deepEqual(inflightStatus(), { inflight: 0, peak: 0, totalStarted: 0 });
  ok("§21 在途请求计数（inflight/peak/totalStarted；防负、峰值不回退）");
}

/* ── §22 流结束标记（EOS）+ 空闲宽限三态（2026-10-20）────────────────────
 *
 * 背景：空回复的**头号自造来源**是本端 idle 定时器把「上游慢」掐成「上游拒答」。
 *   根因：旧实现对「还没出正文」与「正文已结束」用同一个 10s idle。
 *   修法两件套：
 *     ① 空闲宽限分三态（正文前耐心等）；
 *     ② 认上游的**流结束标记** ext1003{Lgcvc.#2 空} ⇒ 确定性收尾，
 *        既不误截断，也不再靠超时猜「答完了没」。
 * ─────────────────────────────────────────────────────────────────────── */
{
  // (a) EOS 帧：ext1003 → Lgcvc{ #2 = <空 godw> } ⇒ eos=true
  const eosFrame = new Writer().message(1003, new Writer().bytes(2, new Uint8Array(0)).finish()).finish();
  const exEos = extractResponse(eosFrame);
  assert.equal(exEos.eos, true, "Lgcvc.#2 空应识别为流结束标记");
  assert.equal(exEos.texts.length, 0, "EOS 帧不含文本");

  // (b) 开始帧：ext1003 → Lgcvc{}（3 字节，oneof 未设）⇒ **不是** EOS
  const startFrame = new Writer().message(1003, new Uint8Array(0)).finish();
  const exStart = extractResponse(startFrame);
  assert.equal(exStart.eos, false, "空的 Lgcvc（开始帧）不得被当成 EOS");

  // (c) 内容帧 ⇒ 不是 EOS
  //    结构：Lgcvq[ext1003] Lgcvc{ #1 Lfzrc{ #1 Lgapu{ #2 Lgace{ #1 文本 } } } }
  const lgapu = new Writer().message(2, new Writer().string(1, "你好").finish()).finish();
  const lfzrc = new Writer().message(1, lgapu).finish();
  const lgcvc = new Writer().message(1, lfzrc).finish();
  const contentFrame = new Writer().message(1003, lgcvc).finish();
  const exContent = extractResponse(contentFrame);
  assert.equal(exContent.eos, false, "内容帧不得被当成 EOS");
  assert.equal(exContent.texts[0], "你好", "内容帧应解析出文本");

  ok("§22 (a-c) 流结束标记识别（EOS=Lgcvc.#2 空；开始帧/内容帧不误判）");

  // (d) 空闲宽限三态
  assert.equal(idleLimitFor({ sawText: false, frames: 0, idleMs: 10_000, firstIdleMs: 60_000 }), 10_000,
    "frames=0（上游没接单）应快速失败（短 idle）");
  assert.equal(idleLimitFor({ sawText: false, frames: 4, idleMs: 10_000, firstIdleMs: 60_000 }), 60_000,
    "已收到 ACK/握手帧但正文未出 ⇒ 用长宽限（不得掐流）");
  assert.equal(idleLimitFor({ sawText: true, frames: 9, idleMs: 10_000, firstIdleMs: 60_000 }), 10_000,
    "正文已开始 ⇒ 未给兜底宽限时退回常规 idle");
  assert.equal(idleLimitFor({ sawText: false, frames: 4, idleMs: 30_000, firstIdleMs: 10_000 }), 30_000,
    "长宽限不得短于常规 idle");
  ok("§22 (d) 空闲宽限三态（真空快速失败 / 正文前耐心 / 正文后收尾）");

  // (d2) 2026-10-20 二改：首正文前的等待上限 = 总时限（300s）；正文后用兜底宽限
  assert.equal(idleLimitFor({ sawText: false, frames: 4, idleMs: 10_000, firstIdleMs: 300_000 }), 300_000,
    "已受理的请求应一路等到 300s 上限（不再被静默定时器掐断）");
  assert.equal(idleLimitFor({ sawText: true, frames: 9, idleMs: 10_000, firstIdleMs: 300_000, idleAfterTextMs: 30_000 }), 30_000,
    "正文已开始 ⇒ 用兜底宽限（正常路径由完成标记/EOS 收尾）");
  ok("§22 (d2) 等待上限 300s（首正文前）/ 正文后兜底宽限");

  // (d3) 「正文已完整」标记：Lgapu.#19 == 2
  const gapuDone = new Writer()
    .message(2, new Writer().string(1, "答完了").finish())
    .varint(19, 2)
    .finish();
  const frameDone = new Writer()
    .message(1003, new Writer().message(1, new Writer().message(1, gapuDone).finish()).finish())
    .finish();
  assert.equal(extractResponse(frameDone).complete, true, "Lgapu.#19=2 应判定正文已完整");

  const gapuBusy = new Writer()
    .message(2, new Writer().string(1, "还在写").finish())
    .varint(19, 1)
    .finish();
  const frameBusy = new Writer()
    .message(1003, new Writer().message(1, new Writer().message(1, gapuBusy).finish()).finish())
    .finish();
  assert.equal(extractResponse(frameBusy).complete, false, "Lgapu.#19=1 不得判定正文已完整");
  assert.equal(extractResponse(frameBusy).eos, false, "内容帧也不是 EOS");

  // 帧里一个 Lgapu 都没有（只有 Lfzrc 外壳）⇒ 不得判定完成（否则提前收尾）
  const frameNoShard = new Writer()
    .message(1003, new Writer().message(1, new Writer().finish()).finish())
    .finish();
  assert.equal(extractResponse(frameNoShard).complete, false, "无分片的帧不得判定正文已完整");
  ok("§22 (d3) 「正文已完整」标记（Lgapu.#19=2）识别 —— 确定性收尾依据");

  // (e) 空回复分流：idle 截断必须被单独标出，且不得误报「文本在未解明扩展里」
  __resetGuardForTest();
  const vCut = noteResponse({
    requestedModeId: "8c46e95b1a07cecc",
    result: {
      frames: 4, unknownFrames: 0, controlFrames: 0,
      extCounts: { 1000: 1, 1003: 1, 1014: 2 },
      endedBy: "idle", idleCutBeforeText: true, sawText: false,
      texts: [],
    },
    hasAudioAttachment: false,
  });
  assert.equal(vCut.state, "empty", "空闲截断仍属 empty 类");
  const le = guardStatus().lastEmpty;
  assert.equal(le.idleCutBeforeText, true, "lastEmpty 应记录 idleCutBeforeText");
  assert.equal(le.diagnosis, "A2", "诊断代号应为 A2（空闲截断）");
  assert.ok(le.diagnosisText.includes("空闲截断"), "诊断全文应说明是「空闲截断」");
  assert.ok(!le.diagnosisText.includes("盲区扩展"),
    "ext1000/1014 是握手帧（ACK/会话 id），不得再被报成「文本落在未解明的数据包里」");
  ok("§22 (e) 空回复分流：空闲截断独立成类；握手帧不再误报为盲区扩展");

  // (f) 握手帧但未被本地超时掐断 ⇒ 【E 上游未出正文】（真·静默拒答）
  __resetGuardForTest();
  noteResponse({
    requestedModeId: "8c46e95b1a07cecc",
    result: {
      frames: 4, unknownFrames: 0, controlFrames: 0,
      extCounts: { 1000: 1, 1003: 1, 1014: 2 },
      endedBy: "idle", idleCutBeforeText: false, sawText: false,
      texts: [],
    },
    hasAudioAttachment: false,
  });
  const le2 = guardStatus().lastEmpty;
  assert.equal(le2.diagnosis, "E", "非本地超时的无正文 ⇒ E（上游未出正文）");
  assert.ok(!le2.diagnosisText.includes("盲区扩展"), "握手帧不得被报成盲区扩展");
  ok("§22 (f) 真·静默拒答（E）与本地超时截断（A2）严格分流");

  // (g) 达到总时限（300s）仍未出正文 ⇒ 独立计数（timeout），不混入 empty
  __resetGuardForTest();
  const vTmo = noteResponse({
    requestedModeId: "8c46e95b1a07cecc",
    result: {
      frames: 4, unknownFrames: 0, controlFrames: 0,
      extCounts: { 1000: 1, 1003: 1, 1014: 2 },
      endedBy: "timeout", idleCutBeforeText: false, sawText: false,
      error: "总超时（300000ms）",
      texts: [],
    },
    hasAudioAttachment: false,
  });
  assert.equal(vTmo.state, "timeout", "总时限耗尽应判为 timeout 而非 empty");
  assert.equal(guardStatus().timeouts, 1, "timeout 应独立计数");
  assert.equal(guardStatus().emptyReplies, 0, "timeout 不得计入 emptyReplies");
  ok("§22 (g) 总时限（300s）耗尽独立计数（timeout），与空回复分流");

  // (h) 瞬时可重试的上游业务错误（如「地域不可用 ZZ」）⇒ transient
  __resetGuardForTest();
  const vTr = noteResponse({
    requestedModeId: "8c46e95b1a07cecc",
    result: {
      frames: 0, unknownFrames: 0, controlFrames: 0, extCounts: {},
      endedBy: "end", grpcStatus: "9",
      error: "gRPC 状态 9: com.google.assistant.boq.bard.application.utils.BardStatusException: " +
             "This service is not yet available in your location ZZ.",
      texts: [],
    },
    hasAudioAttachment: false,
  });
  assert.equal(vTr.state, "transient", "地域不可用应判为 transient（可重试）");
  assert.equal(guardStatus().transients, 1, "transient 应独立计数");
  assert.equal(guardStatus().emptyReplies, 0, "transient 不得计入 emptyReplies");
  assert.equal(guardStatus().authFailures, 0, "transient 不是鉴权失败");

  // (h2) 同类的「上游过载」错误（memory-protection / throttled）也算 transient
  __resetGuardForTest();
  const vTr2 = noteResponse({
    requestedModeId: "8c46e95b1a07cecc",
    result: {
      frames: 0, unknownFrames: 0, controlFrames: 0, extCounts: {},
      endedBy: "end", grpcStatus: "13",
      error: "gRPC 状态 13: BardStatusException: Agency connection failed: " +
             "Request '/AgentDispatcherService.Connect' from role 'bard-agents-server' throttled: " +
             "Service is overloaded (memory-protection)",
      texts: [],
    },
    hasAudioAttachment: false,
  });
  assert.equal(vTr2.state, "transient", "上游过载（memory-protection）应判为 transient");
  assert.equal(guardStatus().transients, 1, "transient 计数应累加");
  ok("§22 (h2) 上游过载（Agency connection failed / memory-protection）同样归为 transient");

  // (h3) 真正的业务错误（不可重试）不得被误判成 transient
  __resetGuardForTest();
  const vHard = noteResponse({
    requestedModeId: "8c46e95b1a07cecc",
    result: {
      frames: 0, unknownFrames: 0, controlFrames: 0, extCounts: {},
      endedBy: "end", grpcStatus: "3",
      error: "gRPC 状态 3: BardStatusException: Unsupported file source.",
      texts: [],
    },
    hasAudioAttachment: false,
  });
  assert.notEqual(vHard.state, "transient", "参数类业务错误不得被当成可重试的 transient");
  assert.equal(guardStatus().transients, 0, "非 transient 不得计入 transients");
  ok("§22 (h3) 判定要窄：真业务错误（参数非法）不被当成 transient");
}
ok("★ 流结束标记 + 空闲宽限三态（根治自造空回复 / 确定性收尾）");

console.log(`\n全部通过：${n} 组断言`);
