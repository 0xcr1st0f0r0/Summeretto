// 临时排查脚本：用生产实际发出的同一份载荷（out/_shimtest.json）走本地 mock 全链路，
// 复核「音频附件 → media shim → video/webm」是否按预期工作。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { startMockRobin } from "./mock-robin.mjs";

const payloadPath = process.argv[2];
const { server: mockServer, port: mockPort, seen } = await startMockRobin({});
process.env.ROBIN_URL = `http://127.0.0.1:${mockPort}`;
process.env.PROXY_API_KEY = "";
process.env.NODE_ENV = "test";
const { handle } = await import("../lib/app.js");
const app = createServer((req, res) => handle(req, res).catch((e) => console.error("handle err:", e)));
await new Promise((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${app.address().port}`;

const body = readFileSync(payloadPath, "utf8");
console.log("payload bytes:", body.length);

const r = await fetch(`${base}/v1beta/models/gemini-4-argon:generateContent`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body,
});
console.log("status:", r.status);
const j = await r.json();
console.log("resp text:", JSON.stringify(j.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 120)));
console.log("mock 收到附件数:", seen.lastAttachments.length);
console.log("mock 收到档位承载位:", JSON.stringify(seen.lastModeCarriers));

app.close();
mockServer.close();
process.exit(0);
