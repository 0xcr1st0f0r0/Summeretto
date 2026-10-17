// service/run-local.mjs —— 本地开发启动器
// 从 out/gpsoauth-env.txt（由 tools/browser-login.mjs / tools/gpsoauth.py 生成）读取
// GSA_* 凭证环境变量后启动服务；文件不存在则原样透传现有 process.env。
//
// 用法：
//   node service/run-local.mjs            # 默认端口 3000
//   node service/run-local.mjs 8788       # 指定端口
//
// 说明：不放 .env 文件（避免误提交）；凭证唯一来源是 out/（已在 .gitignore）。
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const envFile = path.join(ROOT, "out", "gpsoauth-env.txt");

const env = { ...process.env };
let loaded = [];
try {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      env[m[1]] = m[2].trim();
      loaded.push(m[1]);
    }
  }
  console.log(`[run-local] 已加载凭证：${loaded.join(", ")}（来源 ${envFile}）`);
} catch {
  console.log(`[run-local] 未找到 ${envFile} —— 使用现有环境变量启动`);
  console.log(`[run-local] 生成方式：node tools/browser-login.mjs --email <账号>`);
}

const port = process.argv[2] || env.PORT || "3000";
env.PORT = port;

console.log(`[run-local] 启动 service/server.mjs（PORT=${port}）…`);
const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
