// 入口：本地 `node server.mjs`；Vercel 检测到 server.listen() 后自动把本 HTTP server
// 挂载为函数（Node.js runtime，非 Edge——Edge 无 node:http2，无法走 gRPC）。
import { createServer } from "node:http";
import { handle } from "./lib/app.js";
import { enterRequest, exitRequest, inflightStatus } from "./lib/inflight.js";

const server = createServer((req, res) => {
  // ★ 优雅停机：已开始关流时拒绝新请求，让调用方立刻失败并转投其他通道，
  //   而不是接进来再掐断（那正是「已计费但无人接收」的成因）。
  if (shuttingDown) {
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": "1",
      connection: "close",
    });
    res.end(
      JSON.stringify({
        error: {
          code: 503,
          message: "robin-proxy 正在停机（graceful shutdown）：请稍后重试或改走其他通道",
          status: "UNAVAILABLE",
        },
      })
    );
    return;
  }

  enterRequest();
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    exitRequest();
  };
  // res 的 close 覆盖正常 finish 与客户端提前断开两种情形
  res.on("close", done);
  res.on("finish", done);

  handle(req, res).catch((err) => {
    console.error("[server] unhandled:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end('{"error":{"code":500,"message":"internal error","status":"INTERNAL"}}');
    } else {
      res.end();
    }
  });
});

const port = Number(process.env.PORT ?? 3000);
// HOST 留空 = 监听全部网卡（Vercel / 本地开发沿用平台行为）。
// 自托管且只服务同机客户端时设 HOST=127.0.0.1，避免端口暴露到公网。
const host = process.env.HOST || undefined;
server.listen(port, host, () => {
  console.log(`[summeretto] listening on ${host ?? "0.0.0.0"}:${port}`);
});

/* ── ★ 优雅停机（2026-10-17，事故根因修复）──────────────────────────────
 * 背景：systemctl restart 会发 SIGTERM。默认行为是**立即**结束进程，
 *   在途请求（含已上传附件、已开始上游推理的）被硬掐 ⇒ 上游已计费但应答丢失 ⇒
 *   调用方重发 ⇒ 重复计费。实测一次这样的重启让同一段视频付了两遍钱。
 *
 * 做法：SIGTERM/SIGINT 后——
 *   1. 立刻拒绝新请求（503 + connection: close），让调用方转投其他通道；
 *   2. server.close() 停止接受新连接；closeIdleConnections() 关掉 keep-alive 空闲连接
 *      （否则 close() 的回调永远等不到，停机挂死）；
 *   3. 轮询等在途请求跑完，宽限默认 180s（覆盖最坏单请求 ≈110s）；
 *   4. 宽限耗尽才强制退出，并把「仍有 N 个在途」打到日志里 —— 那是明确的计费告警。
 */
const SHUTDOWN_GRACE_MS = Math.max(0, Number(process.env.SHUTDOWN_GRACE_MS ?? 180_000));

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return; // 重复信号不重入
  shuttingDown = true;
  const st = inflightStatus();
  console.log(
    `[server] 收到 ${signal}，进入优雅停机：在途 ${st.inflight}（峰值 ${st.peak} / 累计 ${st.totalStarted}），` +
      `宽限 ${SHUTDOWN_GRACE_MS}ms`
  );

  server.close(() => {
    console.log("[server] 监听已关闭，全部在途请求已完成");
    process.exit(0);
  });
  // Node ≥18.2：关掉空闲 keep-alive 连接，让 close() 能收敛
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline) {
    const cur = inflightStatus().inflight;
    if (cur <= 0) break;
    if (cur !== st.inflight) {
      console.log(`[server] 等待在途请求完成：剩 ${cur}`);
      st.inflight = cur;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const left = inflightStatus().inflight;
  if (left > 0) {
    console.warn(
      `[server] ⚠️ 宽限期耗尽，仍有 ${left} 个在途请求未完成，强制退出。` +
        `这些请求的上游推理已完成 ⇒ 已计费但应答丢失，调用方若重发将重复计费。` +
        `下次可调大 SHUTDOWN_GRACE_MS（当前 ${SHUTDOWN_GRACE_MS}）。`
    );
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
