// service/test/mock-robin.mjs — 本地 HTTP/2 (h2c) mock：模拟 RobinService/ProcessQuery
//
// 用途：离线验证「Gemini HTTP 请求 → 协议装配 → gRPC 帧 → 响应解析 → Gemini 输出」全链路，
//       不需要真机 token/网络。
import http2 from "node:http2";
import { GrpcFrameDecoder, grpcFrame, Writer, fieldOne, fieldAll, decodeFields, asString } from "../lib/wire.js";

/**
 * 构造一个服务端帧（★2026-10-15 对齐真实响应结构，probe24/25 实证）：
 *   Lgcxk{ #1 Lgcvq{ [ext1003] Lgcvc{ #1 Lfzrc{ #1 Lgapu{
 *     #1 STRING 分片id, #2 Lgace{#1 STRING 累积文本}, #7 STRING 快照 } } } } }
 * @param {string} text 本条帧的【累积】文本（真实服务端每帧递增）
 * @param {{model?: string, effMode?: string, rank?: number, thinkEcho?: number}|null} [meta]
 *   响应元数据（真实响应同款字段，解析见 lib/pq.js extractResponse）：
 *     · #30 STRING = 上游自述模型名（"Used 4 Argon model"）
 *     · #25 STRING = 服务端实际生效的档位 id（降级时缺失 —— 静默降级的核心判据）
 *     · #41 varint = rank、#42 varint = 思考强度回显
 */
export function buildServerFrame(text, meta = null) {
  const gapu = new Writer()
    .string(1, `rc_${Math.random().toString(36).slice(2, 10)}`)
    .message(2, new Writer().string(1, text).finish()) // Lgace{#1 累积文本}
    .string(7, text)                                   // 末帧快照
    .finish();
  const lfzrcW = new Writer().message(1, gapu);
  if (meta) {
    if (meta.model) lfzrcW.string(30, meta.model);          // #30 模型名
    if (meta.effMode) lfzrcW.string(25, meta.effMode);      // #25 实际生效档位
    if (meta.rank != null) lfzrcW.varint(41, meta.rank);    // #41 rank
    if (meta.thinkEcho != null) lfzrcW.varint(42, meta.thinkEcho); // #42 思考回显
  }
  const lfzrc = lfzrcW.finish();
  const lgcvc = new Writer().message(1, lfzrc).finish();
  const lgcvq = new Writer().message(1003, lgcvc).finish();
  return new Writer().message(1, lgcvq).finish(); // Lgcxk
}

/** 从客户端帧里提取文本（裸 Lgcvp：[ext1000] → #2 Lgcww.#1 / #1 Lgauy.#25；兼容旧 Lgcxj{#1} 包装） */
export function extractRequestText(payload) {
  // ★ 2026-10-15 协议更正 1：请求就是 Lgcvp 本身，无 Lgcxj 外层包装
  let lgcvp = null;
  const f1 = fieldOne(payload, 1);
  if (f1 && fieldOne(f1.value, 1000)) lgcvp = f1.value; // 旧式 Lgcxj{#1 Lgcvp} 兼容
  else if (fieldOne(payload, 1000)) lgcvp = payload;    // 现行：裸 Lgcvp
  if (!lgcvp) return null;
  const lgcvm = fieldOne(lgcvp, 1000);
  if (!lgcvm) return null;
  const lgcww = fieldOne(lgcvm.value, 2);
  if (lgcww) {
    const t = fieldOne(lgcww.value, 1);
    if (t) return asString(t.value);
  }
  const lgauy = fieldOne(lgcvm.value, 1);
  if (lgauy) {
    const t = fieldOne(lgauy.value, 25);
    if (t) return asString(t.value);
  }
  return null;
}

/** 取出 Lgcvm（Lgcvp[ext1000]），两种帧形态都兼容 */
function lgcvmOf(payload) {
  let lgcvp = null;
  const f1 = fieldOne(payload, 1);
  if (f1 && fieldOne(f1.value, 1000)) lgcvp = f1.value;
  else if (fieldOne(payload, 1000)) lgcvp = payload;
  return (lgcvp && fieldOne(lgcvp, 1000)) || null;
}

/** 从客户端帧里统计附件（Lgcvm[ext1001].Lgcvb.#1.Lfzqy.#1.Lgbkn.#3[]） */
export function extractRequestAttachments(payload) {
  const lgcvm = lgcvmOf(payload);
  if (!lgcvm) return [];
  const lgcvb = fieldOne(lgcvm.value, 1001);
  const lfzqy = lgcvb && fieldOne(lgcvb.value, 1);
  const lgbkn = lfzqy && fieldOne(lfzqy.value, 1);
  if (!lgbkn) return [];
  return fieldAll(lgbkn.value, 3).map((f) => f.value);
}

/** 从客户端帧里取出信封 Lfzqy 的字段列表（Lgcvm[ext1001].Lgcvb.#1）；无信封返回 null */
export function extractRequestEnvelope(payload) {
  const lgcvm = lgcvmOf(payload);
  if (!lgcvm) return null;
  const lgcvb = fieldOne(lgcvm.value, 1001);
  const lfzqy = lgcvb && fieldOne(lgcvb.value, 1);
  return lfzqy ? decodeFields(lfzqy.value) : null;
}

/**
 * 分别取出两个候选承载位里的档位 id。
 *
 * 契约（2026-10-16 §5.14）：**有信封时档位必须在 Lfzqy.#13，且 Lgcvm.#1 不得携带**
 * —— 只要 #1 也带 #16，服务端就整包忽略信封（#48 一并失效）。无信封时才由 #1 承载。
 * 测试据此断言「承载位唯一」，而不是只看"有没有取到值"。
 */
export function extractRequestModeCarriers(payload) {
  const lgcvm = lgcvmOf(payload);
  if (!lgcvm) return { field1: null, envelope: null };
  const f1 = fieldOne(lgcvm.value, 1);
  const from1 = f1 && fieldOne(f1.value, 16);
  const lgcvb = fieldOne(lgcvm.value, 1001);
  const lfzqy = lgcvb && fieldOne(lgcvb.value, 1);
  const l13 = lfzqy && fieldOne(lfzqy.value, 13);
  const fromEnv = l13 && fieldOne(l13.value, 16);
  return {
    field1: from1 ? asString(from1.value) : null,
    envelope: fromEnv ? asString(fromEnv.value) : null,
  };
}

/** 取出模型档位 id（信封 #13 优先，其次 #1）；未指定返回 null */
export function extractRequestModeId(payload) {
  const c = extractRequestModeCarriers(payload);
  return c.envelope ?? c.field1 ?? null;
}

export function startMockRobin({ port = 0, chunks, delayMs = 5 } = {}) {
  const server = http2.createServer();
  const seen = { requests: 0, lastText: null, lastFrameCount: 0, lastAttachments: [], lastEnvelope: null,
    lastModeId: null, lastModeCarriers: { field1: null, envelope: null }, modeHistory: [] };
  /** TRIGGER_EMPTY 命中计数（第 1 次空、第 2 次起正常；见下方注入块） */
  const emptyProbe = { n: 0 };
  /** TRIGGER_EMPTY_ALWAYS 命中计数（恒空；供「重试耗尽」闭环测试） */
  const emptyAlwaysProbe = { n: 0 };

  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"] ?? "");
    if (!path.endsWith("/ProcessQuery")) {
      stream.respond({ ":status": 404 });
      stream.end();
      return;
    }
    const dec = new GrpcFrameDecoder();
    let replied = false;

    stream.on("data", (c) => {
      const frames = dec.push(c);
      if (!frames.length || replied) return;
      replied = true;

      seen.requests++;
      seen.lastText = extractRequestText(frames[0].payload);
      seen.lastAttachments = extractRequestAttachments(frames[0].payload);
      seen.lastEnvelope = extractRequestEnvelope(frames[0].payload);
      seen.lastModeCarriers = extractRequestModeCarriers(frames[0].payload);
      seen.lastModeId = seen.lastModeCarriers.envelope ?? seen.lastModeCarriers.field1 ?? null;
      seen.modeHistory.push(seen.lastModeId);

      // 空响应注入（2026-10-16）：文本含 TRIGGER_EMPTY 时，第 1 次请求返回「空响应」
      //   （无数据帧、无元数据；HTTP 200 + grpc-status 0 —— 对齐上游偶发空响应的响应面），
      //   第 2 次起返回正常文本 —— 供「空响应 → 自动重试 → 成功」闭环测试。
      //   TRIGGER_EMPTY_ALWAYS：每次都空 —— 供「重试耗尽 → 交上层」闭环测试
      //   （注意先判 ALWAYS：它包含 TRIGGER_EMPTY 子串）。
      const isEmptyAlways = String(seen.lastText ?? "").includes("TRIGGER_EMPTY_ALWAYS");
      if (isEmptyAlways) {
        emptyAlwaysProbe.n++;
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
        stream.end();
        return;
      }
      const isEmptyProbe = String(seen.lastText ?? "").includes("TRIGGER_EMPTY");
      if (isEmptyProbe) {
        emptyProbe.n++;
        if (emptyProbe.n === 1) {
          stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
          stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
          stream.end();
          return;
        }
      }

      // 错误注入：文本含 TRIGGER_ERROR 时直接返回 gRPC 13，用于测错误路径
      const isError = String(seen.lastText ?? "").includes("TRIGGER_ERROR");
      // 降级模拟注入（2026-10-17）：文本含 TRIGGER_DEGRADE 时，argon 请求得到
      //   「静默降级」元数据（无 #25、#30 回 Flash-Lite）—— 复现上游账号级降级的响应面；
      //   其他档位得到正常元数据（#25 = 请求档位）—— 供 degrade-guard 观测器的
      //   「判定 → 透出（不换将/不重试）」闭环测试（e2e §9）。
      const isDegradeProbe = String(seen.lastText ?? "").includes("TRIGGER_DEGRADE");
      const degradeMeta = isDegradeProbe && seen.lastModeId
        ? (seen.lastModeId === "95a4c0abcba24364"
          ? { model: "Used 3.5 Flash-Lite model", rank: 6 } // 静默降级：无 #25
          : { model: "Used Mock 3.8 Flash model", effMode: seen.lastModeId, rank: 1 })
        : null;
      // 工具仿真注入：文本含 TRIGGER_TOOLCALL 时回放一段 function_call 围栏块，
      //   用于离线验证「prompt 仿真 → 围栏解析 → functionCall 回填」全链路
      const isToolCall = String(seen.lastText ?? "").includes("TRIGGER_TOOLCALL");
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.on("wantTrailers", () =>
        stream.sendTrailers(
          isError ? { "grpc-status": "13", "grpc-message": "mock%20internal%20error" } : { "grpc-status": "0" }
        )
      );
      if (isError) {
        stream.end();
        return;
      }

      // 默认分片：逐帧累积（对齐真实服务端 Lgace.#1 每帧递增的语义）
      const deltas = isToolCall
        ? [
            "```function_call\n",
            '{"name": "get_weather", "args": {"city": "北京"}}\n',
            "```",
          ]
        : (chunks ?? ["收到", `「${seen.lastText ?? ""}」`, "的回复"]);
      let cum = "";
      let i = 0;
      const tick = () => {
        if (i < deltas.length) {
          cum += deltas[i++];
          stream.write(grpcFrame(buildServerFrame(cum, degradeMeta)));
          setTimeout(tick, delayMs);
        } else {
          stream.end();
        }
      };
      setTimeout(tick, delayMs);
    });
    stream.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}
