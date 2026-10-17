// lib/inflight.js — 在途请求计数（优雅停机与部署安全检查用）
//
// ★ 为什么需要它：2026-10-17 生产事故的直接根因是**重启掐断了在途请求**。
//   附件已上传、auth 已换到、上游已开始推理 ⇒ 上游**已计费**，但应答无人接收，
//   调用方 SDK 自动重发同一 payload ⇒ 又计费一次。同一份内容付两次钱。
//
//   「客户端没收到」≠「上游没算」。掐断只切断回程，不回滚上游推理。
//
// 用途：
//   · server.mjs 优雅停机：SIGTERM 后等在途请求跑完再退（默认宽限 180s，
//     覆盖最坏单请求耗时 ≈110s，见 empty-retry 预算约束）；
//   · /healthz 暴露 inflight，供**部署前检查**：有在途请求就别重启。
//
// 计数口径：从 handle() 进入起算，到响应 finish/close 止。
// 用事件而非 try/finally：客户端提前断开（aborted）时 finally 不一定触发，
// 而 res 的 close 事件一定会触发。

let inflight = 0;
let peak = 0;
let totalStarted = 0;

export function enterRequest() {
  inflight++;
  totalStarted++;
  if (inflight > peak) peak = inflight;
}

export function exitRequest() {
  if (inflight > 0) inflight--;
}

export function inflightStatus() {
  return { inflight, peak, totalStarted };
}

/** 测试辅助 */
export function resetInflight() {
  inflight = 0;
  peak = 0;
  totalStarted = 0;
}
