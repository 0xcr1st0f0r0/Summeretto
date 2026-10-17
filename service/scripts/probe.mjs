// service/scripts/probe.mjs — 联调探针
//
// 用法：
//   node scripts/probe.mjs --hex "你好"            只打印装配出的请求字节（不发网络）
//   ROBIN_URL=http://127.0.0.1:8788 node scripts/probe.mjs "hi"    打本地 mock
//   ROBIN_AUTH_TOKEN=ya29.xxx node scripts/probe.mjs "你好"        打真实上游
//
// 用途：拿到真机 token 后，一条命令完成「装配 → 发送 → 打印响应帧」，
//       便于对照抓包逐字段校准（校准清单见 lib/pq.js 头部注释）。
import { buildProcessQueryRequest } from "../lib/pq.js";
import { processQuery } from "../lib/robin.js";
import { config } from "../lib/config.js";

const args = process.argv.slice(2);
const hexOnly = args.includes("--hex");
const text = args.filter((a) => a !== "--hex").join(" ") || "你好";

const payload = buildProcessQueryRequest({ text });
console.log(`[probe] 上游: ${config.robinUrl}${config.robinPath}`);
console.log(`[probe] 请求装配: ${payload.length} 字节`);
console.log(`[probe] hex: ${Buffer.from(payload).toString("hex")}`);

const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(config.robinUrl);
if (hexOnly || (!config.robinAuthToken && !isLocal)) {
  console.log(
    hexOnly
      ? "[probe] --hex 模式：仅打印装配结果"
      : "[probe] dry-run：未配置 ROBIN_AUTH_TOKEN（真实上游需要真机 OAuth token）"
  );
  process.exit(0);
}

console.log("[probe] 发送中…");
const result = await processQuery({ payload, idleMs: 8000 });
console.log(
  `[probe] HTTP ${result.status} | grpc-status=${result.grpcStatus ?? "-"} | frames=${result.frames} | endedBy=${result.endedBy}`
);
if (result.grpcMessage) console.log(`[probe] grpc-message: ${result.grpcMessage}`);
console.log(`[probe] texts(${result.texts.length}): ${JSON.stringify(result.texts)}`);
console.log(`[probe] ops(${result.ops.length}): ${result.ops.map((o) => o.length + "B").join(", ")}`);
if (result.error) console.log(`[probe] error: ${result.error}`);
process.exit(0);
