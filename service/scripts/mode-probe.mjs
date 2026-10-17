// service/scripts/mode-probe.mjs — 指定 mode id 发一次真实 ProcessQuery，验证上游选用的模型
//
// 背景：Gemini App 的档位选择写在 Lgauy.#16（STRING），值 = 服务端下发的 mode id。
//       本脚本把该字段设成指定值，然后读响应 Lfzrc.#30（"Used … model"）来确认上游真的换了模型。
//
// 用法：
//   node service/scripts/mode-probe.mjs --list              # 先跑 user-status.mjs 拿 id
//   node service/scripts/mode-probe.mjs --mode 95a4c0abcba24364
//   node service/scripts/mode-probe.mjs --mode 95a4c0abcba24364 --text "1+1=?" --compare
//
// --compare：先不带 mode 发一次，再带 mode 发一次，并排比对 #30 回报的模型名（最直观的证据）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const envFile = path.join(ROOT, "out", "gpsoauth-env.txt");
const loaded = [];
try {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim();
      loaded.push(m[1]);
    }
  }
} catch {
  /* 靠现有环境变量 */
}
if (loaded.length) console.log(`[mode-probe] 已加载凭证：${loaded.join(", ")}`);

// 必须在 env 就绪后再加载业务模块（config.js 在加载时固化 GSA_*）
const { buildTextQueryScript } = await import("../lib/pq.js");
const { processQuery } = await import("../lib/robin.js");
const { config } = await import("../lib/config.js");

const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const mode = getArg("--mode", "95a4c0abcba24364"); // 默认 = Gemini 4 Argon
const text = getArg("--text", "用一句话说明你是什么模型。");
const compare = argv.includes("--compare");
const clientType = Number(getArg("--client-type", "2"));

console.log(`[mode-probe] 上游: ${config.robinUrl}`);
console.log(`[mode-probe] ClientType=${clientType}  mode=${mode}  text=${JSON.stringify(text)}`);

async function once(label, modeId) {
  const frames = buildTextQueryScript(text, {
    clientType,
    ...(modeId ? { lgauy: { s16: modeId } } : {}),
  });
  const t0 = Date.now();
  const r = await processQuery({ frames, idleMs: 9000, timeoutMs: 180_000 });
  const ms = Date.now() - t0;
  console.log(`\n──────── ${label} ────────`);
  console.log(
    `  HTTP ${r.status} | grpc-status=${r.grpcStatus ?? "-"} | frames=${r.frames} | endedBy=${r.endedBy} | ${ms}ms`
  );
  if (r.grpcMessage) console.log(`  grpc-message: ${r.grpcMessage}`);
  console.log(`  ★ 上游回报模型 (#30): ${JSON.stringify(r.model)}`);
  console.log(`  conversationId: ${r.conversationId}`);
  console.log(`  文本: ${JSON.stringify((r.cumulative ?? r.texts.join("")).slice(0, 400))}`);
  if (r.error) console.log(`  error: ${r.error}`);
  return r;
}

if (compare) {
  const a = await once("对照：不带 mode（默认档位）", null);
  const b = await once(`实验：mode=${mode}`, mode);
  console.log(`\n════════ 结论 ════════`);
  console.log(`  不带 mode → ${JSON.stringify(a.model)}`);
  console.log(`  带   mode → ${JSON.stringify(b.model)}`);
  console.log(
    a.model !== b.model ? "  ✅ 模型确实随 mode 变化" : "  ⚠️ 模型未变化（该 mode 未生效或被账号权限降级）"
  );
} else {
  await once(`mode=${mode}`, mode);
}

process.exit(0);
