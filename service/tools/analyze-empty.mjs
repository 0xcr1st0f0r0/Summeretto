#!/usr/bin/env node
// service/tools/analyze-empty.mjs — 空响应原始帧离线分析器
//
// 用途：robin-proxy 空响应时会落 `[guard] ↳ raw#N kind=… len=…B hex=…`。
//   本工具把这些 hex 还原成字段树，回答三个问题：
//     ① 顶层有哪些字段/扩展号？（→ 判定是否有未处理扩展 1002/1004/1008/1012/1014）
//     ② 这些扩展里有没有 STRING 载荷？（→ 若有 ⇒ 我方解析失败，可定位到具体字段号）
//     ③ 帧的分类是否正常？（→ unknown 帧说明分类层就没认出）
//
// 用法（三选一）：
//   node tools/analyze-empty.mjs --hex "c2a4 0a02 08ff"        # 单帧
//   node tools/analyze-empty.mjs --hex-file frames.hex          # 每行一个 hex（可带 # 注释）
//   node tools/analyze-empty.mjs --log /var/log/journal.log    # 直接吃 journalctl 文本
//   cat hexes.txt | node tools/analyze-empty.mjs --stdin
//
// 零网络、零上游调用 —— 纯离线解码，可反复跑。

import { decodeFields, asString, asUint } from "../lib/wire.js";

/** Lgcvq 注册的 7 个响应扩展（见 docs/stage2-robin-protocol.md §5.12） */
const RESP_EXTS = {
  1000: "Lgcvo", 1002: "Lgcwm", 1003: "Lgcvc",
  1004: "Lgcwv", 1008: "Lgcwv", 1012: "Lgcxe", 1014: "Lgcve",
};
/** extractResponse 目前只处理这两个（lib/pq.js:791） */
const HANDLED = new Set([1000, 1003]);

const WIRE = { 0: "varint", 1: "fixed64", 2: "len", 3: "sgroup", 4: "egroup", 5: "fixed32" };

function parseHex(s) {
  const clean = s.replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "");
  if (!clean || clean.length % 2 !== 0) throw new Error(`hex 长度非法: ${s.slice(0, 40)}…`);
  return new Uint8Array(Buffer.from(clean, "hex"));
}

/** 「像不像真文本」：可打印字符占比 ≥85% 且无 NUL/控制字符（排除把子消息误认成字符串） */
function isMostlyText(s) {
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // 可打印 ASCII + 常见 CJK/标点区段
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0x3000 && c <= 0x9fff) ||
        (c >= 0xff00 && c <= 0xffef) || c === 0x0a || c === 0x0d || c === 0x09) printable++;
  }
  return printable / s.length >= 0.85;
}

/**
 * 深度遍历，收集字符串载荷路径（找隐藏文本用）。
 *
 * ★ 关键：wt=2（length-delimited）既可能是 STRING 也可能是嵌套 MESSAGE，
 *   两者在线格式上不可区分。**必须用结构判定而非字符启发式**：
 *   载荷若能完整解成合法字段序列（无残留字节、无非法 wire type）⇒ 是 MESSAGE；
 *   否则才是 STRING。启发式（可打印字符占比）会把子消息误认成
 *   "_a" 之类垃圾，也会把真文本漏掉（实测已踩）。
 */
function findStrings(buf, depth = 0, maxDepth = 6) {
  const out = [];
  if (depth > maxDepth) return out;
  let fields;
  try {
    fields = decodeFields(buf);
  } catch {
    return out;
  }
  for (const f of fields) {
    const path = `${f.no}`;
    if (f.wt === 2) {
      if (looksLikeMessage(f.value)) {
        // 嵌套消息：继续下钻（这里不把消息本身记为字符串）
        out.push(...findStrings(f.value, depth + 1, maxDepth).map((x) => ({ ...x, path: `${path}.${x.path}` })));
      } else {
        let s = null;
        try { s = asString(f.value); } catch { /* ignore */ }
        if (s && s.length) out.push({ path, type: "STRING", value: s });
      }
    } else if (f.wt === 0) {
      out.push({ path, type: "varint", value: Number(asUint(f.value)) });
    } else if (f.wt === 1 || f.wt === 5) {
      out.push({ path, type: f.wt === 1 ? "fixed64" : "fixed32", value: `<${f.value.length} bytes>` });
    } else if (f.wt === 3 || f.wt === 4) {
      out.push(...findStrings(f.value, depth + 1, maxDepth).map((x) => ({ ...x, path: `${path}.${x.path}` })));
    }
  }
  return out;
}

/**
 * 结构判定：这段字节能否被合法解析为 protobuf 字段序列。
 * 条件：① 非空 ② 能解出 ≥1 个字段 ③ 解码过程无异常（decodeFields 对非法
 *   wire type 会 throw，且会一路消费到底，中途出错即视为不是消息）。
 *   注：decodeFields 不返回每字段占用的字节数，故不用「覆盖满长度」判据。
 */
function looksLikeMessage(buf) {
  if (!buf || buf.length === 0) return false;
  try {
    const fields = decodeFields(buf);
    if (!fields.length) return false;
    return fields.every((f) => [0, 1, 2, 3, 4, 5].includes(f.wt));
  } catch {
    return false;
  }
}

function analyzeFrame(hex, label = "") {
  let buf;
  try {
    buf = parseHex(hex);
  } catch (e) {
    return { label, error: e.message };
  }
  const rec = { label, len: buf.length, topExts: [], unknownExts: [], strings: [], classification: "?" };
  let fields;
  try {
    fields = decodeFields(buf);
  } catch (e) {
    rec.error = `解码失败: ${e.message}`;
    return rec;
  }
  // 顶层字段一览
  rec.top = fields.map((f) => `#${f.no}:${WIRE[f.wt] ?? f.wt}`);
  const exts = fields.filter((f) => f.no >= 1000);
  rec.topExts = exts.map((f) => f.no);
  rec.unknownExts = exts.filter((f) => !HANDLED.has(f.no)).map((f) => f.no);

  // 复刻 parseServerFrame 的分类逻辑
  if (exts.length) rec.classification = "response";
  else {
    const f1 = fields.find((f) => f.no === 1 && f.wt === 2);
    const f2 = fields.find((f) => f.no === 2 && f.wt === 0);
    rec.classification = f1 ? "response(兼容剥壳)" : f2 ? "control" : "unknown";
  }

  // 全树 STRING 扫描（含未处理扩展内部）
  rec.strings = findStrings(buf).filter((s) => s.type === "STRING");
  return rec;
}

function verdict(rec) {
  if (rec.error) return `✗ ${rec.error}`;
  const out = [];
  if (rec.classification === "unknown") {
    out.push("【B】分类层丢弃：顶层既无 >=1000 扩展，也不符旧版 #1/#2 形态 ⇒ 需修 parseServerFrame");
  }
  if (rec.unknownExts.length) {
    const names = rec.unknownExts.map((n) => `ext${n}(${RESP_EXTS[n] ?? "?"})`).join(",");
    const inUnk = rec.strings.filter((s) =>
      rec.unknownExts.some((n) => s.path === String(n) || s.path.startsWith(`${n}.`)));
    out.push(
      inUnk.length
        ? `【D】★ 盲区扩展内发现 ${inUnk.length} 条字符串载荷 ⇒ **我方解析失败**：` +
          inUnk.slice(0, 6).map((s) => `#${s.path}="${trunc(s.value)}"`).join(" ")
        : `【D?】出现未处理扩展 ${names}，但其内未见可读字符串（纯控制帧？需人工复核）`
    );
  }
  if (!rec.unknownExts.length && rec.classification !== "unknown" && rec.strings.length) {
    out.push("✓ 字符串都在已处理通道内 ⇒ 解析器本身没问题，倾向上游真空/拒答");
  }
  if (!rec.unknownExts.length && rec.classification !== "unknown" && !rec.strings.length) {
    out.push("【A/C/E】无扩展、无字符串 ⇒ 上游真空 或 1003 结构变化（需对照 pq.js:791）");
  }
  return out.join("\n     ") || "（无结论）";
}

const trunc = (s, n = 60) => (s.length > n ? s.slice(0, n) + "…" : s);

function print(rec) {
  console.log(`\n── ${rec.label} ──`);
  if (rec.error) { console.log("  ✗ " + rec.error); return; }
  console.log(`  len=${rec.len}B  分类=${rec.classification}`);
  console.log(`  顶层字段: ${rec.top.join(" ")}`);
  if (rec.topExts.length) console.log(`  扩展号: ${rec.topExts.join(", ")}`);
  if (rec.unknownExts.length) console.log(`  ★未处理扩展: ${rec.unknownExts.join(", ")}`);
  if (rec.strings.length) {
    console.log(`  字符串载荷 (${rec.strings.length}):`);
    for (const s of rec.strings.slice(0, 12)) console.log(`    #${s.path} = "${trunc(s.value, 90)}"`);
  } else {
    console.log("  字符串载荷: 无");
  }
  console.log(`  ⇒ ${verdict(rec)}`);
}

/* ── CLI ── */
const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const frames = [];

if (getArg("--hex")) {
  frames.push({ hex: getArg("--hex"), label: "--hex" });
} else if (getArg("--hex-file")) {
  const fs = await import("node:fs");
  const txt = fs.readFileSync(getArg("--hex-file"), "utf8");
  txt.split("\n").forEach((ln, i) => {
    const t = ln.trim();
    if (!t || t.startsWith("#")) return;
    const m = t.match(/raw#(\d+).*?hex=([0-9a-f]+)/i);
    frames.push({ hex: m ? m[2] : t, label: m ? `raw#${m[1]}` : `line${i + 1}` });
  });
} else if (getArg("--log")) {
  const fs = await import("node:fs");
  const txt = fs.readFileSync(getArg("--log"), "utf8");
  for (const ln of txt.split("\n")) {
    const m = ln.match(/raw#(\d+)\s+kind=(\S+)\s+len=(\d+)B\s+hex=([0-9a-f]+)/);
    if (m) frames.push({ hex: m[4], label: `raw#${m[1]} (${m[2]}, ${m[3]}B)` });
  }
} else {
  // stdin
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const txt = Buffer.concat(chunks).toString("utf8");
  for (const ln of txt.split("\n")) {
    const t = ln.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/raw#(\d+).*?hex=([0-9a-f]+)/i);
    frames.push({ hex: m ? m[2] : t, label: m ? `raw#${m[1]}` : "stdin" });
  }
}

if (!frames.length) {
  console.log("没有输入帧。用法：--hex <hex> | --hex-file <f> | --log <journalctl 文本> | stdin");
  process.exit(0);
}

console.log(`共 ${frames.length} 帧待分析`);
const recs = frames.map((f) => analyzeFrame(f.hex, f.label));
recs.forEach(print);

// 汇总
const hasUnkExt = recs.some((r) => r.unknownExts?.length);
const hasStr = recs.some((r) => r.strings?.length);
console.log("\n═══════ 汇总 ═══════");
console.log(`  帧数=${recs.length}  含未处理扩展=${hasUnkExt}  含字符串=${hasStr}`);
if (hasUnkExt && hasStr) console.log("  ★ 结论：存在「我方解析失败」的物证 —— 需扩展 extractResponse");
else if (hasUnkExt) console.log("  △ 存在未处理扩展但未见字符串 —— 需人工复核（可能是纯控制帧）");
else console.log("  ⇒ 无解析失败物证；倾向上游真空/静默拒答");
process.exit(0);