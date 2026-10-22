// service/lib/robin.js — Robin 主对话 gRPC 客户端（node:http2，零依赖）
//
// 一次 generateContent = 一条 ProcessQuery 双向流：
//   1. HTTP/2 连接（模块级单例；Vercel Fluid compute 热实例间可复用，省 TLS 握手）
//   2. POST {robinUrl}{robinPath}
//   3. 写 N 个 gRPC 帧（首帧 = Lgcvp 本身【协议更正 1：无 Lgcxj 包装】，随后 prefetch/commit）
//   4. 读服务端帧（Lgcxk{ #1 Lgcvq }）→ 逐帧回调
//   5. 结束条件（三者取先）：服务端 END_STREAM / 数据静止 idleMs / 总超时 timeoutMs
//      （真实会话是长连接，服务端不一定主动关流 → idle 静止判定是主力机制）
//
// 参考先例：APNs 推送在 Vercel serverless 用 node:http2（Apple 强制 HTTP/2）。

import http2 from "node:http2";
import { grpcFrame, GrpcFrameDecoder } from "./wire.js";
import { parseServerFrame, extractResponse, maybeGunzip, buildDeleteConversationRequest, buildGetUserStatusRequest, parseUserStatus, robinServicePrefix } from "./pq.js";
import { config } from "./config.js";
import { getRobinToken, invalidateMintedToken, canRemint } from "./auth.js";

let session = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 extractResponse 结果里挑出非空的元信息字段（供 onFrame 透传） */
const META_KEYS = ["cumulative", "language", "conversationId", "responseId", "title", "model",
  "rank", "thinking", "effectiveMode"];
function pick(ex) {
  const o = {};
  for (const k of META_KEYS) if (ex[k]) o[k] = ex[k];
  return o;
}

function getSession() {
  if (session && !session.closed && !session.destroyed) return session;
  session = http2.connect(config.robinUrl, { settings: { enablePush: false } });
  session.on("error", (err) => {
    console.error("[robin] session error:", err?.message);
    session = null;
  });
  session.on("goaway", () => {
    session = null;
  });
  session.on("close", () => {
    session = null;
  });
  return session;
}

export function closeRobinSession() {
  if (session && !session.closed) session.close();
  session = null;
}

/**
 * ★ unary RPC：删除会话（会话隔离的根治手段，2026-10-16）
 *
 * 为什么需要它：Robin 服务端按【账号】维持 active 会话，请求不带会话 ID 时会落入
 *   同一个持续累积的会话 → 本代理多路复用同一账号时，不同调用方的上下文会互相串扰
 *   （实测：不带历史直接问上轮的暗号，模型仍能答出）。
 *   处理完就删掉本次请求产生的会话 ⇒ 下次请求自然开启全新会话。
 *
 * 消息形态（protoreach 反推）：Lgaaz { #1 string conversationId, #2 Lgauy }
 *
 * @param {string} conversationId 来自 ProcessQuery 响应（result.conversationId）
 * @param {object} [opts] { timeoutMs }
 * @returns {Promise<{ok: boolean, grpcStatus: string|null, grpcMessage: string|null, error?: string}>}
 */
export async function deleteConversation(conversationId, opts = {}) {
  if (!conversationId) return { ok: false, error: "no conversationId" };
  let payload;
  try {
    payload = buildDeleteConversationRequest(conversationId);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  return unaryRpc("DeleteConversation", payload, opts);
}

/**
 * ★ 通用 unary RPC（Robin 服务上绝大多数非流式方法都是 unary）
 *
 * 与 processQuery 的区别：单请求单响应，无 bidi 剧本、无 idle 判定。
 * 收尾规则（踩坑记录，见 out/_delete-rpc-bench.mjs）：**收到 trailers 即判定完成**——
 * Robin 服务端发完 trailers 后不会立刻触发本端 'end'/'close'，等那些事件会白等整个超时窗。
 *
 * @param {string} methodName  方法名（拼在 robinPath 的服务前缀后），如 "GetUserStatus"
 * @param {Uint8Array} payload 已编码的请求消息
 * @param {object} [opts] { timeoutMs }
 * @returns {Promise<{ok, grpcStatus, grpcMessage, body: Uint8Array|null, error?}>}
 */
export async function unaryRpc(methodName, payload, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const localUpstream = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(config.robinUrl);
  let token = null;
  if (!localUpstream) {
    token = await getRobinToken();
    if (!token) return { ok: false, grpcStatus: null, grpcMessage: null, body: null, error: "no credential" };
  }

  const path = `${robinServicePrefix(config.robinPath)}${methodName}`;

  return new Promise((resolve) => {
    const result = { ok: false, grpcStatus: null, grpcMessage: null, body: null };
    let settled = false;
    let timer = null;
    let decoder = null;
    let grpcEncoding = null;

    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) result.error = error;
      resolve(result);
    };

    let stream;
    try {
      stream = getSession().request({
        ":method": "POST",
        ":path": path,
        "content-type": "application/grpc",
        te: "trailers",
        "grpc-accept-encoding": "gzip, identity",
        "user-agent": config.robinUserAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...config.robinExtraHeaders,
      });
    } catch (err) {
      done(`连接失败: ${err?.message}`);
      return;
    }

    timer = setTimeout(() => {
      try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
      done(`${methodName} 超时`);
    }, timeoutMs);

    stream.on("response", (h) => {
      grpcEncoding = h["grpc-encoding"] ?? null;
    });

    stream.on("data", (chunk) => {
      decoder ??= new GrpcFrameDecoder();
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        result.error = `拆帧失败: ${err?.message}`;
        return;
      }
      for (const f of frames) {
        result.body = f.compressed || grpcEncoding === "gzip" ? maybeGunzip(f.payload) : f.payload;
      }
    });

    stream.on("trailers", (t) => {
      result.grpcStatus = t["grpc-status"] ?? null;
      result.grpcMessage = t["grpc-message"] ?? null;
      result.ok = result.grpcStatus === "0";
      try { stream.close(); } catch {}
      done();
    });

    stream.on("error", (err) => done(`流错误: ${err?.message}`));
    stream.on("end", () => done());
    stream.on("close", () => done());

    try {
      stream.write(grpcFrame(payload));
      stream.end(); // unary：写完就半关
    } catch (err) {
      done(`写入失败: ${err?.message}`);
    }
  });
}

/**
 * ★ GetUserStatus（RPC 槽位 "aI"）：取回账号的「模型档位」全貌
 *
 * 这是唯一能拿到 mode id 的途径（2026-10-16 取证）：
 *   - 无任何 GetModeConfig/GetBardModeConfig RPC（rpc-msg-map.txt 全 162 条已核）
 *   - Lalqh.C(Lgaic;Lhcuk;) 是模式配置的唯一入口，Lgaic 即本 RPC 的响应
 *   - 响应 #17 = Lgavr[]（模式配置：id/名称/分类）
 *     响应 #18 = Lgahy[]（allowlist：账号实际允许的 mode id）
 *
 * 用途：服务端从不硬编码 mode id（APK 里搜不到 "argon"），必须实时向账号要。
 *
 * @param {object} [opts] { clientType, timeoutMs }
 * @returns {Promise<{ok, modes, allowlists, grpcStatus, grpcMessage, error?}>}
 */
export async function getUserStatus(opts = {}) {
  let payload;
  try {
    payload = buildGetUserStatusRequest(opts);
  } catch (err) {
    return { ok: false, modes: [], allowlists: [], error: err?.message ?? String(err) };
  }
  const r = await unaryRpc("GetUserStatus", payload, opts);
  const out = { ok: r.ok, modes: [], allowlists: [], grpcStatus: r.grpcStatus, grpcMessage: r.grpcMessage };
  if (r.error) out.error = r.error;
  if (r.ok && r.body) {
    try {
      const parsed = parseUserStatus(r.body);
      out.modes = parsed.modes;
      out.allowlists = parsed.allowlists;
    } catch (err) {
      out.parseError = err?.message ?? String(err);
    }
  }
  return out;
}

/**
 * 发起一次 ProcessQuery。
 *
 * 凭证自愈：首轮若因鉴权失败（gRPC 16 UNAUTHENTICATED / HTTP 401|403）且未收到任何数据，
 * 且当前配了 GSA_MASTER_TOKEN，则丢弃缓存令牌重取一次后重试。这样访问令牌在
 * 边界时刻失效不会直接暴露成用户可见的错误。
 *
 * @param {object} opts
 * @param {Uint8Array} opts.payload      buildProcessQueryRequest() 的产物（Lgcvp 字节，无外层包装）
 * @param {(evt) => void} [opts.onFrame] 每帧回调：{kind:'response', body, texts[], ops[]} | {kind:'control', code}
 * @param {number} [opts.timeoutMs]      总超时（默认 240s，Vercel Hobby 上限 300s）
 * @param {number} [opts.idleMs]         数据静止超时（默认 10s）——流式"结束"的主力判定
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{status, grpcStatus, grpcMessage, frames, texts, ops, endedBy, error?}>}
 */
export async function processQuery(opts = {}) {
  const first = await processQueryOnce(opts);
  if (!isAuthFailure(first) || !canRemint()) return first;

  console.warn("[robin] 上游返回 UNAUTHENTICATED，丢弃缓存令牌并用 master token 重取后重试一次");
  invalidateMintedToken();
  const second = await processQueryOnce(opts);
  second.retriedAuth = true;
  return second;
}

/** 鉴权失败特征：没有任何数据帧 + UNAUTHENTICATED / 401 / 403 */
function isAuthFailure(r) {
  if (!r || r.frames > 0 || r.texts.length > 0) return false;
  if (r.grpcStatus === "16") return true;
  return r.status === 401 || r.status === 403;
}

/**
 * ★ 空闲宽限的判定（纯函数，便于单测）。
 *
 * 三态（2026-10-20 二改，见 processQueryOnce 的 armIdle 注释）：
 *   ① frames=0            → 短 idle（上游没接单，快速失败 = 真正的空响应）
 *   ② frames>0 且无正文   → 长宽限 firstIdleMs（默认 = 总时限 300s）**耐心等**
 *   ③ 已有正文            → 兜底宽限 idleAfterTextMs（正常路径由完成标记收尾）
 *
 * @param {{sawText:boolean, frames:number, idleMs:number, firstIdleMs:number, idleAfterTextMs?:number}} p
 * @returns {number} 本次空闲定时器的毫秒数
 */
export function idleLimitFor({ sawText, frames, idleMs, firstIdleMs, idleAfterTextMs }) {
  if (sawText) return idleAfterTextMs ?? idleMs;
  if (frames > 0) return Math.max(idleMs, firstIdleMs);
  return idleMs;
}

async function processQueryOnce({
  payload,
  frames,
  onFrame,
  // ★ 2026-10-20 二改：总时限上限 300s（用户要求），且不再由静默定时器
  //   提前掐断「上游慢」的请求 —— 结束只由上游终止 / 真空 / 完成标记驱动。
  timeoutMs = config.robinTimeoutMs,
  idleMs = config.robinIdleMs,
  // ★ 首正文前的「空闲」宽限（默认 = 总时限 300s）：只在「上游一个字节都没回」
  //   时才用短 idle；已受理（收到 ACK）就耐心等到总时限。
  firstIdleMs = config.robinIdleFirstMs,
  // ★ 正文已开始后的兜底静默宽限（正常路径由「正文完成标记 / EOS」收尾，
  //   这里只兜底「上游既不给完成标记也不结束会话」的少数情况）。
  idleAfterTextMs = config.robinIdleAfterTextMs,
  signal,
  headers: extraHeaders,
} = {}) {
  // 凭证在流建立前解析（来源优先级：注入缓存 > TOKEN_PROVIDER_URL > 环境变量）
  const token = await getRobinToken();
  const localUpstream = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(config.robinUrl);
  if (!token && !localUpstream) {
    return {
      status: 0,
      grpcStatus: "UNAUTHENTICATED",
      grpcMessage:
        "无可用 Robin 凭证。推荐：访问服务根路径下的 /login 完成一次性网页登录绑定" +
        "（配置 GSA_EMAIL + GSA_MASTER_TOKEN）；也可用 tools/frida/extract-robin-token.js " +
        "提取后 POST /admin/token 注入，或配置 ROBIN_AUTH_TOKEN / TOKEN_PROVIDER_URL" +
        "（见 docs/credential-acquisition.md）",
      frames: 0,
      texts: [],
      ops: [],
      endedBy: "no-token",
      error: "no credential",
    };
  }

  return new Promise((resolve) => {
    const result = {
      status: 0,
      grpcStatus: null,
      grpcMessage: null,
      frames: 0,
      texts: [],
      ops: [],
      ackCapabilities: null,
      cumulative: null,
      language: null,
      conversationId: null,
      responseId: null,
      title: null,
      model: null,
      sentFrames: 0,
      endedBy: null,
      // ★ 空响应自诊断插桩（2026-10-17）：frames 只总数，无法区分「真空」与
      //   「帧到了但没解析出东西」。unknownFrames/extCounts 让每次空响应事件
      //   在日志里自证成因（见 degrade-guard 的 empty 分支）。
      unknownFrames: 0,
      controlFrames: 0,
      extCounts: {},
      // ★ 是否已产出正文（首个正文帧到达即置位）——armIdle 用它区分
      //   「还没出正文（慢）」与「正文已结束（idle 收尾）」。
      sawText: false,
      // ★ 上游的「流结束」标记（ext1003{Lgcvc.#2 空}）是否收到
      eos: false,
      // ★ 「正文已完整」标记（Lgapu.#19 == 2）是否收到 —— 确定性收尾信号
      complete: false,
      // ★ 收到过「内容容器」帧（ext1003 带 Lfzrc）的次数 —— 空回复分流用：
      //   >0 却没解出文本 ⇒ 我方解析问题；=0 ⇒ 上游根本没出正文。
      contentFrames: 0,
      // ★ 因空闲超时而在**正文出现前**被掐断（我方超时，非上游拒答）
      idleCutBeforeText: false,
      // ★ 取证缓冲：仅 capture 开启时填充，空响应时由 degrade-guard 落盘
      rawFrames: null,
    };
    // 取证缓冲（总长上限 64KB，单帧截断见 config.robinEmptyCaptureBytes）
    const cap = config.robinEmptyCapture
      ? { log: [], total: 0, maxBytes: 64 * 1024, perFrame: config.robinEmptyCaptureBytes }
      : null;
    let settled = false;
    let totalTimer = null;
    let idleTimer = null;

    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      if (error) result.error = error;
      // 取证缓冲挂载：仅 capture 开启且确有帧时携带（空响应时由 degrade-guard 落盘）
      if (cap && cap.log.length) result.rawFrames = cap.log;
      resolve(result);
    };

    const armIdle = () => {
      clearTimeout(idleTimer);
      // ★★ 空闲判定**分三态**（2026-10-20 二改：等待上限 300s）
      //
      //   ① frames=0（一个字节都没回来）→ 短 idle（idleMs，默认 10s）
      //      上游根本没接单（未受理 / 鉴权 / 真空）⇒ 快速失败，别浪费调用方预算。
      //   ② frames>0 但**正文还没出** → 长宽限（firstIdleMs，默认 300s = 总时限）
      //      ACK（ext1000）到达即说明 initial **已被受理**；此后的静默是
      //      「模型在思考 / 在拉媒体」，不是拒答。**绝不能在这里掐流。**
      //   ③ 正文已开始 → 兜底宽限（idleAfterTextMs，默认 30s）
      //      正常路径由「正文完成标记（Lgapu.#19=2）」或「EOS 标记」**确定性**
      //      收尾（见下方 data 处理），这里只兜底上游既不给完成标记也不结束
      //      会话的少数情况。
      //
      //   为什么必须这样（实测证据，out/_ev-exp3/exp4 + _prod-payload-probe）：
      //     · 同一载荷只改「正文前宽限」：统一 1.5s ⇒ 4/4 空回复；60s ⇒ 0/4。
      //     · 生产载荷首正文 10.8~30.1s（最大帧间隙 26.4s）⇒ 统一 10s 必杀。
      //     · 空回复时的帧序列与健康响应**完全同构**（1000/1003/1014）⇒ 旧的
      //       分流逻辑把它误判成「文本落在未解明的数据包里」。
      const limit = idleLimitFor({
        sawText: result.sawText,
        frames: result.frames,
        idleMs,
        firstIdleMs,
        idleAfterTextMs,
      });
      idleTimer = setTimeout(() => {
        result.endedBy ??= "idle"; // 数据静止 = 正常结束（长连接场景）
        if (!result.sawText) result.idleCutBeforeText = true;
        try {
          stream.close();
        } catch {}
        done();
      }, limit);
    };

    let stream;
    try {
      const sessionRef = getSession();
      const headers = {
        ":method": "POST",
        ":path": config.robinPath,
        "content-type": "application/grpc",
        te: "trailers",
        "grpc-accept-encoding": "gzip, identity",
        "user-agent": config.robinUserAgent,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...config.robinExtraHeaders,
        ...(extraHeaders ?? {}),
      };
      stream = sessionRef.request(headers);
    } catch (err) {
      done(`连接失败: ${err?.message}`);
      return;
    }

    const decoder = new GrpcFrameDecoder();

    totalTimer = setTimeout(() => {
      result.endedBy = "timeout";
      result.error = `总超时（${timeoutMs}ms）`;
      try {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      } catch {}
      done(result.error);
    }, timeoutMs);

    if (signal) {
      signal.addEventListener("abort", () => {
        result.endedBy = "abort";
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {}
        done("客户端断开");
      });
    }

    stream.on("response", (h) => {
      result.status = Number(h[":status"] ?? 0);
    });

    stream.on("data", (chunk) => {
      // ★ 结算后不再累积（2026-10-20）：idle 定时器掐流时 done() 已 resolve，
      //   但底层流可能还吐几帧。若继续累积，调用方读到的 result 会随时间变化
      //   （同一请求有时读到"空"、有时读到"有内容"）⇒ 判定不确定。
      //   结算即冻结：掐流那一刻看到什么，就是什么。
      if (settled) return;
      armIdle();
      let chunkFrames;
      try {
        chunkFrames = decoder.push(chunk);
      } catch (err) {
        result.error = `拆帧失败: ${err?.message}`;
        return;
      }
      for (const f of chunkFrames) {
        // 服务端响应可能是 gzip 压缩的（响应头 grpc-encoding: gzip，帧压缩位=1）
        const payload = maybeGunzip(f.payload);
        const parsed = parseServerFrame(payload);
        result.frames++;
        // ★ 取证缓冲（2026-10-17）：保留每帧的原始字节摘要，供空响应时离线复核
        //   「解析失败 vs 上游真空」。仅在 capture 开启时记录，且总长有上限，
        //   避免长回答时无界增长。raw 存 hex 前 N 字节 + 实际长度。
        if (cap && cap.total < cap.maxBytes) {
          const slice = payload.subarray(0, cap.perFrame);
          cap.log.push({
            i: result.frames,
            len: payload.length,
            kind: parsed.kind,
            hex: Buffer.from(slice).toString("hex"),
          });
          cap.total += payload.length;
        }
        if (parsed.kind === "response") {
          const ex = extractResponse(parsed.body);
          result.texts.push(...ex.texts);
          result.ops.push(...ex.ops);
          if (ex.texts.length || ex.cumulative) result.sawText = true;
          if (ex.eos) result.eos = true;
          if (ex.complete) result.complete = true;
          if (ex.lfzrcSeen) result.contentFrames++;
          if (ex.ackCapabilities) result.ackCapabilities = ex.ackCapabilities;
          // 元信息（后到覆盖：末帧带完整值）
          for (const k of ["cumulative", "language", "conversationId", "responseId", "title", "model",
            "rank", "thinking", "effectiveMode"]) {
            if (ex[k]) result[k] = ex[k];
          }
          // 插桩：累计本请求各扩展号的字段出现次数（空响应时分流「真空/解析失败」用）
          for (const [k, v] of Object.entries(ex.hasExt ?? {})) {
            result.extCounts[k] = (result.extCounts[k] ?? 0) + v;
          }
          onFrame?.({ kind: "response", body: parsed.body, texts: ex.texts, ops: ex.ops, byExt: ex.byExt, ...pick(ex) });
        } else {
          // 插桩：未识别/控制帧计数（>0 且无文本 ⇒ 响应被丢在分类层，解析失败的直接证据）
          if (parsed.kind === "unknown") result.unknownFrames++;
          else if (parsed.kind === "control") result.controlFrames++;
          onFrame?.(parsed);
        }
      }
      // ★ 流结束标记（2026-10-20）：上游用 ext1003{Lgcvc.#2 空} 明确宣告「答完了」。
      //   收到即**立即收尾** —— 不再等 idle 静默超时。
      //   收益：① 每请求省掉一整段 idle 空等尾巴（旧实现固定多花 idleMs）
      //        ② 收尾变成**确定性**的，不再依赖超时猜测 ⇒ 不会误截断答案，
      //           也不会把「上游答完了」误判成「上游静默拒答」。
      //
      // ★★ 另一条确定性信号：**正文完成标记**（Lgapu.#19 == 2）
      //   实测 141 个响应 810 帧：每帧恒为单分片；首个 #19=2 的帧即含全部文本
      //   （139/141），其后 0 例再增长 ⇒ 见到即可收尾，不必等 EOS（EOS 只在
      //   136/141 出现）。这让「首正文前的等待」可以放心拉到 300s：
      //   因为**结束不再依赖静默超时**。
      if (result.eos || result.complete) {
        result.endedBy ??= result.eos ? "eos" : "complete";
        try { stream.close(); } catch {}
        done();
      }
    });

    stream.on("trailers", (t) => {
      result.grpcStatus = t["grpc-status"] ?? null;
      result.grpcMessage = t["grpc-message"] ?? null;
    });

    stream.on("end", () => {
      // 服务端 END_STREAM：半关本方流并收尾
      result.endedBy ??= "server-end";
      try {
        stream.end();
      } catch {}
      if (result.grpcStatus && result.grpcStatus !== "0") {
        result.error ??= `gRPC 状态 ${result.grpcStatus}: ${result.grpcMessage ?? ""}`;
      }
      done();
    });

    stream.on("error", (err) => {
      result.endedBy ??= "error";
      done(`流错误: ${err?.message} (code=${err?.code ?? "?"})`);
    });

    stream.on("close", () => {
      result.endedBy ??= "close";
      if (result.grpcStatus && result.grpcStatus !== "0") {
        result.error ??= `gRPC 状态 ${result.grpcStatus}: ${result.grpcMessage ?? ""}`;
      }
      done();
    });

    // ★ 发送剧本（bidi：不 end()，保持流打开等响应；idle 机制负责收尾）
    //   一次完整文本查询 = initial → prefetch → 单帧 commit（Lgcvl{#2}，见 pq.js 头部说明）
    const script = frames?.length
      ? frames
      : [{ bytes: payload, delayMs: 0 }];

    armIdle();
    (async () => {
      try {
        for (const step of script) {
          if (settled) return;
          stream.write(grpcFrame(step.bytes));
          result.sentFrames++;
          armIdle();
          if (step.delayMs > 0) await sleep(step.delayMs);
        }
        armIdle();
      } catch (err) {
        done(`写入失败: ${err?.message}`);
      }
    })();
  });
}

