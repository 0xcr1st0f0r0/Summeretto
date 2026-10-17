// service/lib/empty-retry.js — 空响应自动重试（偶发故障甄别 + 重试）
//
// ═══════════════════════════════════════════════════════════════════════════
// 背景（2026-10-16 实证，见 docs §5.18）：
//   上游偶发「空响应」：HTTP 200 + finishReason=STOP + 无正文 + 无 #30，
//   等待 25~50s 后拿到一个空结果。特征：
//     · 官方 Gemini App 客户端同样会出现（用户确认）——多为不报错、重试后恢复、
//       或一段时间后自愈；
//     · 与「账号级档位降级」（Flash-Lite 换将）是两类不同失败：后者重试必然无意义，
//       前者（空响应）重试可能直接解决。
//
// 策略（用户 2026-10-16 指定）：
//   · 「额度/资源型降级」（档位被静默换 Flash-Lite）⇒ 不做本模块重试；
//     2026-10-17 起反代对该形态【完全不动作】（不换将/不置窗），回显原样透出，
//     由上层（Eidolon）跨通道回退到 ag/gemini-3.8-flash。
//   · 「空响应」⇒ 先视作偶发故障，自动重试【同一请求、同一档位】；
//     - 任一次成功 ⇒ 正常返回（调用方无感，robin 质量保留）；
//     - 连续 N 次仍空 ⇒ 判定「资源型空响应」可能性高，交上层处置（ag 回退）。
//
// 安全性质（为什么可在所有路径重试，含真流式）：
//   空响应 = 零内容 = 未向客户端透出任何字节 ⇒ 重试不会造成重复输出。
//   （本模块是 robin 内唯一保留的重试；降级≠空，降级不触发本模块。）
//
// 预算护栏（2026-10-16 深夜修订，实战教训）：
//   调用方（Eidolon）对单次 generateContent 有 **120s 硬超时**（LLM_SINGLE_REQUEST_TIMEOUT_S=120），
//   超时后该请求直接失败（用户侧表现为「发送失败」，反代即使随后自愈也无人接收）。
//   因此本模块保证：最坏「已用 + 一次尝试的观测最长耗时(≈70s)」≤ ~115s < 120s：
//     budget = 100s（从入口计时）；reserve = 60s（重试前预留一次尝试的最坏耗时）。
//     ⇒ 已用 < 40s 才允许重试（典型空响应 25~35s 在内；超过则不再赌，交上层 ag 回退）。
//   教训：旧默认（2 次重试 / 170s 预算）遇到「空 27s + 空 27s + 成功 69s = 123s」时
//   超出调用方 120s —— 反代自愈成功但客户端先放弃，4 秒之差双双落空。
// ═══════════════════════════════════════════════════════════════════════════

import { config } from "./config.js";

/** 观测统计（进程内；供 /healthz） */
const state = {
  logical: 0,       // 走过甄别逻辑的逻辑请求数
  emptyEvents: 0,   // 空响应事件数（每次物理尝试各计一次）
  retries: 0,       // 实际发起的重试次数
  successes: 0,     // 重试后恢复成功的请求数
  exhausted: 0,     // 重试耗尽（最终仍为空响应）的请求数
  budgetStopped: 0, // 因超预算未发起重试的次数
};

/** /healthz 状态快照 */
export function emptyRetryStatus() {
  return {
    enabled: config.robinEmptyRetry > 0,
    maxRetries: config.robinEmptyRetry,
    delayMs: config.robinEmptyRetryDelayMs,
    budgetMs: config.robinEmptyRetryBudgetMs,
    reserveMs: config.robinEmptyRetryReserveMs,
    ...state,
  };
}

/**
 * 是否应再发起一次重试（纯判定，无副作用）。
 *
 * 三道闸：① 开关 ② 次数上限 ③ 预算——按「已用 + 预留 ≥ 预算」判停，
 * 保证即便下一次尝试跑满观测最坏耗时，总时长也不拖穿调用方超时。
 *
 * @param {{attempt: number, deadline: number, maxRetries?: number, reserveMs?: number}} p
 *        attempt = 已完成的尝试次数（1 起）；deadline = 预算截止时间戳
 * @returns {{retry: boolean, reason: 'ok'|'disabled'|'exhausted'|'budget'}}
 */
export function decideEmptyRetry({ attempt, deadline, maxRetries, reserveMs }) {
  const max = maxRetries ?? config.robinEmptyRetry;
  if (max <= 0) return { retry: false, reason: "disabled" };
  if (attempt > max) return { retry: false, reason: "exhausted" };
  const reserve = reserveMs ?? config.robinEmptyRetryReserveMs;
  if (Date.now() + reserve >= deadline) return { retry: false, reason: "budget" };
  return { retry: true, reason: "ok" };
}

/**
 * 包装「单次尝试」：空响应时自动重试，直到成功 / 重试耗尽 / 超预算。
 * attemptFn(attempt) 返回单次尝试结果；空响应判定用 result.__modeVerdict.state === "empty"
 * （由 degrade-guard.noteResponse 在每次尝试内写入）。
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} attemptFn
 * @param {{deadline?: number, maxRetries?: number, delayMs?: number, log?: (...a: any[]) => void}} [opts]
 * @returns {Promise<T>} 最后一次尝试的结果（成功者，或重试耗尽后的空响应结果）
 */
export async function withEmptyRetry(attemptFn, opts = {}) {
  const max = opts.maxRetries ?? config.robinEmptyRetry;
  const delayMs = opts.delayMs ?? config.robinEmptyRetryDelayMs;
  const reserveMs = opts.reserveMs ?? config.robinEmptyRetryReserveMs;
  const deadline = opts.deadline ?? Date.now() + config.robinEmptyRetryBudgetMs;
  const log = opts.log ?? console.log;

  state.logical++;
  let attempt = 0;
  for (;;) {
    attempt++;
    const result = await attemptFn(attempt);
    const isEmpty = result?.__modeVerdict?.state === "empty";
    if (!isEmpty) {
      if (attempt > 1) {
        state.successes++;
        log(`[empty-retry] ✓ 第 ${attempt} 次尝试成功（本请求共空 ${attempt - 1} 次）—— 判为偶发故障，已自愈`);
      }
      return result;
    }
    state.emptyEvents++;
    const d = decideEmptyRetry({ attempt, deadline, maxRetries: max, reserveMs });
    if (!d.retry) {
      state.exhausted++;
      if (d.reason === "budget") state.budgetStopped++;
      log(
        `[empty-retry] ✗ ${attempt} 次尝试均为空响应（${d.reason === "budget" ? "超预算" : `重试上限 ${max}`}` +
        `${d.reason === "disabled" ? "，重试已关闭" : ""}）→ 放弃重试，交上层处置（资源型可能性高）`
      );
      return result;
    }
    state.retries++;
    log(
      `[empty-retry] ⚠️ 空响应（第 ${attempt}/${1 + max} 次尝试）→ 自动重试` +
      `${delayMs > 0 ? `（${delayMs}ms 后）` : "（立即）"}`
    );
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
}

/** 测试专用：重置统计（生产代码不应调用） */
export function __resetEmptyRetryForTest() {
  state.logical = 0;
  state.emptyEvents = 0;
  state.retries = 0;
  state.successes = 0;
  state.exhausted = 0;
  state.budgetStopped = 0;
}
