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
 * 响应后调用（app.js 的 attemptRobin 尾部）：判定本次请求是否被静默降级 /
 * 空响应，只记录与上报，不做任何换将/重试/置窗动作。
 * 裁决挂在 result.__modeVerdict 上供 lib/empty-retry.js 触发【同模型】重试
 * （state === "empty" 是唯一会触发重试的形态；降级不透传重试）。
 * @returns {{state: 'ok'|'degraded'|'empty'|'auth-failure'|'unknown'|'off', requestedId?: string,
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
  // ★ ⑤ 凭证失效型（2026-10-17 实测新增，必须排在 empty 之前）：
  //   no-token 短路 —— 无可用 ya29 令牌，请求根本没发出去（robin.js 的
  //   `endedBy:"no-token"` / `grpcStatus:"UNAUTHENTICATED"` 分支），或
  //   令牌过期后上游鉴权层拒绝。两种都【零额度消耗】——与 ③ 的「上游真空」
  //   性质完全不同（③ 大概率已计费），历史上曾被混为一谈导致误判为配额问题。
  if (isAuthFailure(result)) {
    vState = "auth-failure";
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
    };
    // ── 分流判据（三类互斥，按可能性排序）──
    //  A. frames=0                      → 上游真空，一个字节都没给（非我方问题）
    //  B. unknown>0 或 controlFrames>0   → 帧到了但分类层就没认出来（需修 parseServerFrame）
    //  C. 有 1003 但 texts=0              → 1003 结构变了 / oneof 落在空分支（需修 extractResponse）
    //  D. exts 里出现 1003 以外的扩展且无文本 → ★ 文本可能落在未处理的扩展里
    //     （Lgcvq 注册 7 个扩展：1000/1002/1003/1004/1008/1012/1014，
    //      extractResponse 只处理 1000 与 1003；ext1004/1008=Lgcwv、1012=Lgcxe、
    //      1014=Lgcve、1002=Lgcwm 均为 oneof 容器，若上游把文本改走这些通道即静默丢失）
    const extKeys = Object.keys(result?.extCounts ?? {});
    const knownText = extKeys.includes("1003");
    const foreignExt = extKeys.filter((k) => k !== "1003");
    let verdictLine;
    if ((result?.frames ?? 0) === 0) {
      verdictLine = "【A 上游真空】未收到任何帧 → 非解析问题（推理未被接受，或上游主动掐流）";
    } else if ((result?.unknownFrames ?? 0) > 0 || (result?.controlFrames ?? 0) > 0) {
      verdictLine = "【B 分类层丢弃】帧已到达但未被识别 → 需修 parseServerFrame";
    } else if (knownText) {
      verdictLine = "【C 结构变化】收到 ext1003 但解析不出文本 → 需修 extractResponse";
    } else if (foreignExt.length > 0) {
      verdictLine =
        `【D 盲区扩展】收到未处理的扩展 ext${foreignExt.join(",ext")}（文本可能在此通道）` +
        " → 需扩展 extractResponse";
    } else {
      verdictLine = "【E 未知】有帧但无任何扩展字段，需抓原始 payload 复核";
    }
    state.lastEmpty.diagnosis = verdictLine.slice(0, 2).replace(/【|】/g, "");
    console.log(
      `[guard] ⚠️ 上游返回「空响应」（无 #30、无正文，HTTP 200/STOP）` +
      ` [诊断] frames=${result?.frames ?? 0} unknown=${result?.unknownFrames ?? 0}` +
      ` control=${result?.controlFrames ?? 0} exts=${exts} endedBy=${result?.endedBy ?? "?"}` +
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
  };
}

/** 测试专用：重置状态（生产代码不应调用） */
export function __resetGuardForTest() {
  state.lastEvent = null;
  state.emptyReplies = 0;
  state.lastEmpty = null;
  state.authFailures = 0;
  state.lastAuthFailure = null;
}
