// service/lib/degrade-guard.js — 档位静默降级「观测器」（只判定 + 上报，不动作）
//
// ═══════════════════════════════════════════════════════════════════════════
// 背景：上游会按【账号】施加「档位静默降级」：请求指定 4 Argon / 3.1 Pro / 3.8 Flash，
//   实际一律以 3.5 Flash-Lite 应答 —— HTTP 200、内容正常、无任何报错，唯一痕迹
//   在响应元数据里（解析见 lib/pq.js extractResponse）：
//     · Lfzrc.#25（服务端实际生效的档位 id）≠ 请求的 #16 —— 降级时缺失或回不同 id
//     · Lfzrc.#30（上游自述模型名）变为 "Used 3.5 Flash-Lite …"、#41 rank 回 6
//
// 策略（用户 2026-10-17 指定 —— robin 是与调用方解耦的独立通道）：
//   · 本模块【不换将、不跨档重试、不置窗】。降级响应原样透出（响应里的
//     modelVersion = "Used 3.5 Flash-Lite model" 就是给上层的信号），由调用方
//     （Eidolon）决定跨通道回退（ag/gemini-3.8-flash）。
//   · 唯一保留的重试在 lib/empty-retry.js：仅【同模型同档位】重试（偶发空响应），
//     与降级正交（降级≠空）。
//   · 「音频退让」请求（含独立音频附件，档位被挤到 Lfzqy.#13）的降级是预期行为
//     （Argon 读不到独立音频，必须退让换听觉，见 docs §5.14）—— 只在上报里标注
//     exempt，不视为异常。
//
// 判定（唯一判据，与离线探测脚本 out/_voice-test/mode-recheck.mjs 同源）：
//   ① #25 存在：直接比对是否等于请求的档位 id；
//   ② #25 缺失：由 #30 名称兜底 —— 含 "flash-lite" 且请求的不是 Flash-Lite ⇒ 降级；
//   ③ 无 #30、空正文（HTTP 200 + STOP）⇒ "empty"：上游静默拒答 / 或我方未解析出
//     内容（两种可能目前无法从日志区分 —— 2026-10-17 已插桩 frames/unknown/exts，
//     下次自然空响应事件即可分流，见 robin.js 与 noteResponse 的 empty 分支）；
//   ④ 其余无法判定 ⇒ "unknown"，不动作（保守，防误报）。
//   ⑤ ★ auth-failure（2026-10-17 实测新增，**必须排在 ③ 之前**）：
//     无可用 ya29 令牌 ⇒ 请求根本没发到推理层 ⇒ **零额度消耗**（耗时 0~3s）。
//     与 ③ 的额度影响截然相反（③ 大概率已计费、25~35s），混为一谈会导致
//     「用量没涨」被误判成配额问题（真实案例：2026-10-16 17:13，master token
//     被服务端拒 HTTP 403 BadAuthentication）。指纹见下方 isAuthFailure()。
//     历史上此类落进 ④（no-token 短路带 error 字段而被 ③ 的 !error 条件排除），
//     healthz 完全看不见 ⇒ 现已独立计数 + 显式告警。
//
// 状态只在内存（进程重启清零，可接受；不落盘，避免状态残留）。
// ═══════════════════════════════════════════════════════════════════════════

import { config } from "./config.js";
import { modeById } from "./modes.js";

/** 观测状态（进程内；无窗口、无断路器 —— 只记最近事件供 /healthz 与排查） */
const state = {
  lastEvent: null,   // 最近一次判定详情
  emptyReplies: 0,   // 「空响应」累计（上游静默拒答或解析失败，见判定 ③）
  lastEmpty: null,   // 最近一次空响应详情（含插桩字段）
  authFailures: 0,   // ★「凭证失效型」空响应累计（2026-10-17 实测新增，见判定 ⑤）
  lastAuthFailure: null,
  timeouts: 0,       // ★ 达到总时限（300s）仍未出正文的次数（上游极慢，非拒答）
  lastTimeout: null,
  transients: 0,     // ★ 瞬时可重试的上游业务错误（如「地域不可用 ZZ」）
  lastTransient: null,
};

// ───────────────────────────── 对外接口 ─────────────────────────────

/**
 * 凭证失效型失败的判别（2026-10-17）。
 *
 * ★ 为什么必须与「空响应」分开：两者的【额度影响截然相反】——
 *   · 凭证失效型：没有令牌 ⇒ 请求根本没发到推理层 ⇒ **零额度消耗**（耗时 0~3s）
 *   · 上游真空型：请求已发出并被接受，上游跑完推理却没给内容 ⇒ **大概率已计费**（25~35s）
 * 混为一谈会导致「用量没涨」时被误判成配额问题（真实案例：2026-10-16 17:13）。
 *
 * 指纹（与 lib/robin.js 的两处 no-token 短路、lib/auth.js 的 mint 失败对应）：
 *   · endedBy === "no-token"        —— 无可用凭证，请求未发出
 *   · grpcStatus === "UNAUTHENTICATED" / "16"，或 status 401/403 且零帧 —— 令牌被拒
 */
function isAuthFailure(r) {
  if (!r) return false;
  if (r.endedBy === "no-token") return true;
  const noData = (r.frames ?? 0) === 0 && (r.texts?.length ?? 0) === 0;
  if (!noData) return false;
  if (r.grpcStatus === "UNAUTHENTICATED" || r.grpcStatus === "16") return true;
  return r.status === 401 || r.status === 403;
}

/**
 * 「瞬时可重试」的上游业务错误（2026-10-20 新增）。
 *
 * 实测到的两类（均为**明确拒答**、推理没跑 ⇒ **零额度消耗**，重试几乎无代价）：
 *   ① `BardStatusException: This service is not yet available in your location ZZ.`
 *      —— 上游按出口 IP 的**地理判定**偶发失败（ZZ = 未能判定所在区域）。
 *      实测约每 20 次请求命中 1 次，2~3s 内返回。
 *   ② `BardStatusException: Agency connection failed: ... throttled:
 *       Service is overloaded (memory-protection)`（grpc=13）
 *      —— 上游 agent 调度器过载（内存保护），实测 ~1.2s 内返回。
 *
 * 为什么要单独归类：
 *   · 它们**不是**空回复（HTTP 200/STOP/无正文），而是 gRPC 业务错误 ⇒ 原有
 *     「空回复重试」不会触发，调用方直接拿到 502（用户侧表现为「发送失败」）。
 *   · 但它们**明确拒答、推理根本没跑** ⇒ 零额度消耗，重试几乎无代价，
 *     且实测重试即可恢复（与空回复同属「偶发故障」性质）。
 *   ⇒ 归入 transient：让 empty-retry 一并重试（同模型同档位）。
 *
 * ⚠️ 判定要窄：只匹配明确的「过载 / 地域不可用」措辞，避免把真正的业务错误
 *   （如账号被封、参数非法）也拿去重试 —— 那些重试无用且会浪费额度。
 */
const TRANSIENT_UPSTREAM_PATTERNS = [
  /not yet available in your location/i,
  /location ZZ/i,
  /Service is overloaded/i,
  /memory-protection/i,
  /Agency connection failed/i,
  /\bthrottled\b/i,
];

function isTransientUpstream(r) {
  if (!r) return false;
  const text = `${r.error ?? ""} ${r.grpcMessage ?? ""}`;
  if (!text.trim()) return false;
  return TRANSIENT_UPSTREAM_PATTERNS.some((re) => re.test(text));
}

/**
 * 响应后调用（app.js 的 attemptRobin 尾部）：判定本次请求是否被静默降级 /
 * 空响应，只记录与上报，不做任何换将/重试/置窗动作。
 * 裁决挂在 result.__modeVerdict 上供 lib/empty-retry.js 触发【同模型】重试
 * （state === "empty" 或 "transient" 是会触发重试的两种形态；降级不透传重试）。
 * @returns {{state: 'ok'|'degraded'|'empty'|'transient'|'timeout'|'auth-failure'|'unknown'|'off', requestedId?: string,
 *            requestedLabel?: string|null, effectiveId?: string|null,
 *            model?: string|null, exempt?: string}}
 */
export function noteResponse({ requestedModeId, result, hasAudioAttachment }) {
  if (!config.robinDegradeGuard || !requestedModeId) return { state: "off" };
  const eff = result?.effectiveMode ? String(result.effectiveMode).toLowerCase() : null;
  const model = String(result?.model ?? "");
  const entry = modeById(requestedModeId);
  const reqId = String(requestedModeId).toLowerCase();
  const reqName = String(entry?.short ?? entry?.label ?? "");
  const hasText = (result?.texts?.length ?? 0) > 0 || Boolean(result?.cumulative);

  // ── 判定 ──
  let vState;
  // ★ ⑤ 达到总时限（2026-10-20）：等待上限 300s 用尽仍未出正文。
  //   与「上游真空 / 静默拒答」是**不同**的形态（我们等满了，不是上游先收手），
  //   故独立计数，方便判断「上游到底有多慢」。
  if (result?.endedBy === "timeout") {
    vState = "timeout";
  // ★ ⑤ 凭证失效型（2026-10-17 实测新增，必须排在 empty 之前）：
  //   no-token 短路 —— 无可用 ya29 令牌，请求根本没发出去（robin.js 的
  //   `endedBy:"no-token"` / `grpcStatus:"UNAUTHENTICATED"` 分支），或
  //   令牌过期后上游鉴权层拒绝。两种都【零额度消耗】——与 ③ 的「上游真空」
  //   性质完全不同（③ 大概率已计费），历史上曾被混为一谈导致误判为配额问题。
  } else if (isAuthFailure(result)) {
    vState = "auth-failure";
  } else if (isTransientUpstream(result)) {
    // ★ 瞬时可重试的上游业务错误（如「地域不可用 ZZ」）—— 明确拒答、零计费
    vState = "transient";
  } else if (eff) {
    vState = eff === reqId ? "ok" : "degraded";
  } else if (/flash-lite/i.test(model)) {
    vState = /flash-lite/i.test(reqName) ? "ok" : "degraded";
  } else if (!model && !hasText && !result?.error) {
    // ★ 空响应：无 #30、无正文、无传输错误。两种可能目前无法从旧日志区分：
    //   (a) 上游真的什么都没给（静默拒答）；(b) 上游给了帧但被我方丢弃/未解析。
    //   插桩字段（frames/unknownFrames/extCounts/endedBy）随日志一起打出来，
    //   下次自然发生的空响应即可分流 —— 零额外探针代价。
    vState = "empty";
  } else {
    vState = "unknown"; // 有文本但无元数据（或 gRPC 错误）⇒ 不动作（保守，防误报）
  }

  const verdict = {
    state: vState,
    requestedId: requestedModeId,
    requestedLabel: entry?.label ?? null,
    effectiveId: eff,
    model: model || null,
  };
  // 音频退让（预期降级）在快照前标注，保证 /healthz 的 lastEvent 能区分
  // 「预期退让」与「账号级静默降级」两种 degraded。
  if (vState === "degraded" && hasAudioAttachment) verdict.exempt = "audio-deference";
  state.lastEvent = { at: Date.now(), ...verdict };

  // ── 空响应：计数 + 自诊断日志（不动作；重试由 empty-retry 同模型进行）──
  if (vState === "empty") {
    state.emptyReplies++;
    const exts = result?.extCounts ? JSON.stringify(result.extCounts) : "{}";
    state.lastEmpty = {
      at: Date.now(),
      requestedId: requestedModeId,
      requestedLabel: entry?.label ?? null,
      frames: result?.frames ?? 0,
      unknownFrames: result?.unknownFrames ?? 0,
      extCounts: result?.extCounts ?? {},
      endedBy: result?.endedBy ?? null,
      // ★ 我方 idle 定时器在正文出现前掐断 ⇒ 「慢」被误报成「空」
      idleCutBeforeText: Boolean(result?.idleCutBeforeText),
      sawText: Boolean(result?.sawText),
    };
    // ── 分流判据（互斥，按可能性排序）──
    //  A. frames=0                      → 上游真空，一个字节都没给（非我方问题）
    //  A2. idleCutBeforeText            → ★ 我方空闲定时器在正文出现前掐断
    //     （2026-10-20 新增）：上游只是**慢**，不是拒答。修法：加大
    //     ROBIN_IDLE_FIRST_MS（首正文前的宽限），而不是加重试。
    //  B. unknown>0 或 controlFrames>0   → 帧到了但分类层就没认出来（需修 parseServerFrame）
    //  C. 有 1003 但 texts=0              → 1003 结构变了 / oneof 落在空分支（需修 extractResponse）
    //  D. exts 里出现 1003 以外的扩展且无文本 → ★ 文本可能落在未处理的扩展里
    //     （Lgcvq 注册 7 个扩展：1000/1002/1003/1004/1008/1012/1014，
    //      extractResponse 只处理 1000 与 1003；ext1004/1008=Lgcwv、1012=Lgcxe、
    //      1014=Lgcve、1002=Lgcwm 均为 oneof 容器，若上游把文本改走这些通道即静默丢失）
    const extKeys = Object.keys(result?.extCounts ?? {});
    // ★ 「收到过内容容器帧」用 contentFrames 判定，**不能**用 extCounts 里有没有
    //   "1003"：3 字节的空 ext1003{}（开始帧）与 EOS 帧也计在 1003 上，
    //   但它们都不含 Lfzrc —— 用 extCounts 判会把「上游没出正文」误报成
    //   「我方解析失败」。
    const contentFrames = result?.contentFrames ?? 0;
    const knownText = contentFrames > 0;
    const foreignExt = extKeys.filter((k) => k !== "1003");
    // 已知的「非正文」扩展：1000=能力表 ACK、1014=会话 id 握手帧 —— 它们出现
    // **不代表**文本落在那里（2026-10-20 实测：健康响应的帧序恒为
    // 1000(ACK) → 1003(空 oneof) → 1014(会话 id) ×2 → 1003(正文) …）。
    // 旧逻辑把它们算作「盲区扩展」，把「上游慢/真空」误报成「文本落在
    // 未解明的数据包里」——正是排查空回复时最大的误导来源。
    const BENIGN_EXT = new Set(["1000", "1014"]);
    const suspiciousExt = foreignExt.filter((k) => !BENIGN_EXT.has(k));
    let verdictLine;
    if ((result?.frames ?? 0) === 0) {
      verdictLine = "【A 上游真空】未收到任何帧 → 非解析问题（推理未被接受，或上游主动掐流）";
    } else if (result?.idleCutBeforeText) {
      verdictLine =
        "【A2 空闲截断】已收到帧但正文迟迟未到，被本端 idle 定时器掐断" +
        " → 上游只是**慢**（非拒答）；加大 ROBIN_IDLE_FIRST_MS 即可";
    } else if ((result?.unknownFrames ?? 0) > 0 || (result?.controlFrames ?? 0) > 0) {
      verdictLine = "【B 分类层丢弃】帧已到达但未被识别 → 需修 parseServerFrame";
    } else if (knownText) {
      verdictLine = "【C 结构变化】收到 ext1003 但解析不出文本 → 需修 extractResponse";
    } else if (suspiciousExt.length > 0) {
      verdictLine =
        `【D 盲区扩展】收到未处理的扩展 ext${suspiciousExt.join(",ext")}（文本可能在此通道）` +
        " → 需扩展 extractResponse";
    } else {
      verdictLine =
        "【E 上游未出正文】收到帧（含握手帧）但无正文且未触发本地超时" +
        " → 上游静默拒答（账号资源态），非解析问题";
    }
    // 诊断代号：取【】里的整段（如 A / A2 / B / C / D / E），不是固定 2 字符
    state.lastEmpty.diagnosis = (verdictLine.match(/^【\s*([A-Z0-9]+)/)?.[1]) ?? "?";
    // ★ 诊断全文也留一份（diagnosis 只是 2 字母代号，排查时要看得懂）
    state.lastEmpty.diagnosisText = verdictLine;
    console.log(
      `[guard] ⚠️ 上游返回「空响应」（无 #30、无正文，HTTP 200/STOP）` +
      ` [诊断] frames=${result?.frames ?? 0} unknown=${result?.unknownFrames ?? 0}` +
      ` control=${result?.controlFrames ?? 0} exts=${exts} endedBy=${result?.endedBy ?? "?"}` +
      ` idleCut=${result?.idleCutBeforeText ? "yes" : "no"}` +
      ` ⇒ ${verdictLine}（累计 ${state.emptyReplies} 次）`
    );
    // ── 取证：原始帧 hex 落日志（仅空响应时，零常态开销）──
    //   用途：离线复核盲区扩展。判定为 D/E（我方可能丢帧）时这是唯一物证。
    const raw = result?.rawFrames;
    if (raw && raw.length) {
      state.lastEmpty.rawFrames = raw.length;
      for (const r of raw.slice(0, 12)) {
        console.log(
          `[guard]   ↳ raw#${r.i} kind=${r.kind} len=${r.len}B hex=${r.hex}`
        );
      }
      if (raw.length > 12) console.log(`[guard]   ↳ …另有 ${raw.length - 12} 帧未展开`);
    } else {
      console.log(`[guard]   ↳ raw=(无原始帧缓冲，capture 关闭或真空)`);
    }
    return verdict;
  }

  // ── ★ 瞬时可重试的上游业务错误（如「地域不可用 ZZ」）：独立计数 ──
  //   明确拒答、推理没跑 ⇒ 零额度消耗；重试几乎无代价且实测可恢复。
  if (vState === "transient") {
    state.transients++;
    const hint = String(result?.error ?? result?.grpcMessage ?? "").slice(0, 200);
    state.lastTransient = { at: Date.now(), requestedId: requestedModeId, hint };
    console.log(
      `[guard] 🔄 上游瞬时业务错误（可重试，零额度消耗）：${hint}` +
      `（累计 ${state.transients} 次）`
    );
    return verdict;
  }

  // ── ★ 达到总时限（300s）仍未出正文：独立计数与告警 ──
  //   与「上游真空 / 静默拒答」不同 —— 这是**我们等满了**，不是上游先收手。
  //   可观测性意义：直接回答「上游到底能慢到什么程度」。
  if (vState === "timeout") {
    state.timeouts++;
    state.lastTimeout = {
      at: Date.now(),
      requestedId: requestedModeId,
      requestedLabel: entry?.label ?? null,
      frames: result?.frames ?? 0,
      extCounts: result?.extCounts ?? {},
      error: String(result?.error ?? "").slice(0, 200),
    };
    console.log(
      `[guard] ⏱ 达到总时限仍未出正文（等待上限 ${config.robinTimeoutMs}ms）` +
      ` frames=${result?.frames ?? 0} exts=${JSON.stringify(result?.extCounts ?? {})}` +
      ` ⇒ 上游极慢（非拒答）（累计 ${state.timeouts} 次）`
    );
    return verdict;
  }

  // ── ★ 凭证失效型：显式告警（2026-10-17）──
  //   核心价值：让「用量没涨」有明确归因，且**不被误判成配额耗尽**。
  //   这类失败过去会落进 "unknown"（因 no-token 短路带 error 字段而被 empty
  //   条件排除），导致 healthz 的 emptyReplies 不计数、运维完全看不见。
  if (vState === "auth-failure") {
    state.authFailures++;
    const authHint = result?.grpcMessage || result?.error || "上游拒绝鉴权";
    state.lastAuthFailure = {
      at: Date.now(),
      requestedId: requestedModeId,
      requestedLabel: entry?.label ?? null,
      endedBy: result?.endedBy ?? null,
      grpcStatus: result?.grpcStatus ?? null,
      status: result?.status ?? null,
      hint: String(authHint).slice(0, 300),
    };
    console.log(
      `[guard] 🔴 凭证失效型失败（auth-failure）—— 请求【未进入推理层，零额度消耗】` +
      `（累计 ${state.authFailures} 次）`
    );
    console.log(
      `[guard]   ↳ 指纹：endedBy=${result?.endedBy ?? "?"}` +
      ` grpcStatus=${result?.grpcStatus ?? "-"} http=${result?.status ?? "-"}` +
      ` frames=${result?.frames ?? 0}`
    );
    console.log(`[guard]   ↳ 原因：${String(authHint).slice(0, 300)}`);
    console.log(
      `[guard]   ↳ 处置：重新获取 Robin 凭证（网页登录抓 master token：GET /login；` +
      `或设备侧提取后 POST /admin/token 注入）。**这不是配额问题**——` +
      `重试无用（无令牌重发仍会被拒），跨通道回退由上层（Eidolon）负责。`
    );
    // 附件已上传但请求未发出 ⇒ 上传是无用功，明确提示避免误判为「上传也失败」
    if (result?.endedBy === "no-token") {
      console.log(
        `[guard]   ↳ 注：附件上传（/contrib_service）无需鉴权，故上传成功属预期；` +
        `失败点在取 ya29 令牌那一步。`
      );
    }
    return verdict;
  }
  if (vState !== "degraded") return verdict;

  // ── 降级：只上报（2026-10-17 起不换将、不重试、不置窗）──
  if (hasAudioAttachment) {
    console.log(
      `[guard] ⓘ 档位 ${entry?.label ?? requestedModeId} 被降级（响应：${model || "(无 #30)"}）` +
      ` —— 音频退让属预期行为，透出上报`
    );
  } else {
    console.log(
      `[guard] ⚠️ argon 档位被静默降级（响应：${model || "(无 #30)"}${eff ? ` / #25=${eff}` : " / #25 缺失"}）` +
      ` —— 不换将不重试，降级回显原样透出，交上层（Eidolon）跨通道处理`
    );
  }
  return verdict;
}

/** 供 /healthz 与排查用的状态快照（纯观测面） */
export function guardStatus() {
  return {
    enabled: config.robinDegradeGuard,
    // 策略提示：本模块只观测；换将/重试已按 2026-10-17 决策移除
    policy: "observe-only",
    lastEvent: state.lastEvent,
    // 「空响应」（上游静默拒答或解析失败）的观测面
    emptyReplies: state.emptyReplies,
    lastEmpty: state.lastEmpty,
    // ★ 凭证失效型（请求未发出 ⇒ 零额度消耗）：与上面【互斥】，
    //   排查时先看这个——非 0 即代表 robin 通道已不可用。
    authFailures: state.authFailures,
    lastAuthFailure: state.lastAuthFailure,
    // ★ 达到总时限（ROBIN_TIMEOUT_MS，默认 300s）仍未出正文
    timeouts: state.timeouts,
    lastTimeout: state.lastTimeout,
    // ★ 瞬时可重试的上游业务错误（如「地域不可用 ZZ」；零额度消耗）
    transients: state.transients,
    lastTransient: state.lastTransient,
  };
}

/** 测试专用：重置状态（生产代码不应调用） */
export function __resetGuardForTest() {
  state.lastEvent = null;
  state.emptyReplies = 0;
  state.lastEmpty = null;
  state.authFailures = 0;
  state.lastAuthFailure = null;
  state.timeouts = 0;
  state.lastTimeout = null;
  state.transients = 0;
  state.lastTransient = null;
}
