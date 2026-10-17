// service/scripts/user-status.mjs — 账号「模型档位」发现工具
//
// 背景：Gemini App 的模型/档位（如 Gemini 4 Argon）在协议里不是硬编码的模型名，
//       而是服务端下发的 **mode id**（写入 Lgauy.#16）。APK 里搜不到 "argon" 之类的
//       字面量 —— 唯一的获取途径是向账号实时查询。
//
// 本脚本调用 GetUserStatus（RPC 槽位 "aI"，req=Lgahv / resp=Lgaic），打印：
//   · 模式配置列表（Lgaic.#17 → Lgavr[]，每个含 mode id / 名称 / 分类）
//   · 可用白名单  （Lgaic.#18 → Lgahy[]，账号实际允许的 mode id）
//
// 取证链（2026-10-16）：
//   rpc-msg-map.txt 全 162 条 RPC 中没有任何 GetModeConfig → 必然挂在既有响应上；
//   Lalqh.C(Lgaic;Lhcuk;) 是模式配置的唯一入口 ⇒ Lgaic = GetUserStatus 响应；
//   fieldmap Lgaic:#17→gavr / #18→gahy 与 Lalmy/Lbbca 的消费逻辑逐字对应。
//
// 用法：
//   node service/scripts/user-status.mjs                 # 自动加载 out/gpsoauth-env.txt
//   node service/scripts/user-status.mjs --json          # 输出原始 JSON
//   CLIENT_TYPE=2 node service/scripts/user-status.mjs   # 指定 ClientType（默认 2=ANDROID）
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// 凭证：优先环境变量，其次 out/gpsoauth-env.txt（与 run-local.mjs 同源）
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
  /* 没有该文件就靠现有环境变量 */
}
if (loaded.length) console.log(`[user-status] 已加载凭证：${loaded.join(", ")}`);

// ★ 必须在设置 process.env **之后**再加载业务模块：config.js 在模块加载时就把
//   GSA_* 固化进 state，而 ESM 的静态 import 会被提升到本文件顶部执行 → 会读到空值。
const { getUserStatus } = await import("../lib/robin.js");
const { config } = await import("../lib/config.js");

const asJson = process.argv.includes("--json");
const clientType = Number(process.env.CLIENT_TYPE || 2);

console.log(`[user-status] 上游: ${config.robinUrl}${config.robinPath}`);
console.log(`[user-status] ClientType=${clientType}，调用 GetUserStatus…`);

const t0 = Date.now();
const r = await getUserStatus({ clientType, timeoutMs: 30_000 });
console.log(
  `[user-status] ok=${r.ok} grpc-status=${r.grpcStatus ?? "-"} 耗时=${Date.now() - t0}ms` +
    (r.grpcMessage ? ` grpc-message=${r.grpcMessage}` : "")
);
if (r.error) console.log(`[user-status] error: ${r.error}`);
if (r.parseError) console.log(`[user-status] parseError: ${r.parseError}`);

if (asJson) {
  console.log(JSON.stringify({ modes: r.modes, allowlists: r.allowlists }, null, 2));
  process.exit(0);
}

if (!r.modes.length && !r.allowlists.length) {
  console.log("[user-status] 未取到模式配置（检查凭证 / grpc 状态 / 字段号是否漂移）");
  process.exit(0);
}

console.log(`\n================ 模式配置 Lgavr[]（${r.modes.length} 项）================`);
for (const m of r.modes) {
  const extra = [
    m.s2 && `s2=${JSON.stringify(m.s2)}`,
    m.s3 && `s3=${JSON.stringify(m.s3)}`,
    m.s16 && `s16=${JSON.stringify(m.s16)}`,
    m.s18 && `s18=${JSON.stringify(m.s18)}`,
    m.s19 && `s19=${JSON.stringify(m.s19)}`,
    m.s20 && `s20=${JSON.stringify(m.s20)}`,
    m.s22 && `s22=${JSON.stringify(m.s22)}`,
    m.s26 && `s26=${JSON.stringify(m.s26)}`,
    m.enum4 !== null && `enum4=${m.enum4}`,
    m.int23 !== null && `int23=${m.int23}`,
    m.bool8 !== null && `bool8=${m.bool8}`,
    m.bool21 !== null && `bool21=${m.bool21}`,
  ].filter(Boolean);
  console.log(`  id=${JSON.stringify(m.id)}`);
  console.log(`      ${extra.join("  ") || "(无其他字段)"}`);
}

console.log(`\n================ 可用白名单 Lgahy[]（${r.allowlists.length} 项）================`);
r.allowlists.forEach((a, i) => {
  console.log(`  [${i}] flag=${a.flag} ids(${a.ids.length})=${JSON.stringify(a.ids)}`);
  if (a.note) console.log(`      note=${JSON.stringify(a.note)}`);
});

// 交叉比对：白名单里出现、但模式配置里没有的 id（以及反之）
const configIds = new Set(r.modes.map((m) => m.id));
const allowed = new Set(r.allowlists.flatMap((a) => a.ids));
console.log(`\n================ 交叉比对 ================`);
console.log(`  模式配置 id 数: ${configIds.size} | 白名单 id 数: ${allowed.size}`);
const both = [...allowed].filter((x) => configIds.has(x));
const onlyAllowed = [...allowed].filter((x) => !configIds.has(x));
const onlyConfig = [...configIds].filter((x) => !allowed.has(x));
console.log(`  两边都有 (${both.length}): ${JSON.stringify(both)}`);
console.log(`  仅白名单   (${onlyAllowed.length}): ${JSON.stringify(onlyAllowed)}`);
console.log(`  仅配置表   (${onlyConfig.length}): ${JSON.stringify(onlyConfig)}`);
console.log(`\n  ★ 候选 mode id（两边都有的，可直接填 Lgauy.#16）: ${JSON.stringify(both)}`);

process.exit(0);
