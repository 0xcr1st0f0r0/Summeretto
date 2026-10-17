// service/lib/gemini.js — Gemini 原生格式 ⇄ Robin 翻译层
//
// 入：Google Generative Language API 风格请求体
//     { contents: [{ role, parts: [{ text } | { inlineData: { mimeType, data(base64) } } | { fileData } }] } }
// 出：{ text, attachments: [{ mime, bytes } | { blobId, mime, name }] }
//
// ⚠️ 多轮语义：Robin 的会话状态载体（Lfzww/Lapuy 等）尚未接通，
//    MVP 采取"历史文本拼接"策略（保留全部轮次内容，不丢信息）。
//
// ★ 2026-10-15：fileData 支持 —— fileUri 形如 "files/<b64url(blobId|mime|name)>"
//    （见 app.js 的 /upload/v1beta/files 路由；无状态编码，跨 Vercel 实例可解析）
// ★ 2026-10-15：function calling 兼容层 —— tools/toolConfig 序列化进 prompt，
//    functionCall/functionResponse part 转文本标记；见 toolcall.js 头部说明。

import {
  extractToolDefs,
  buildToolPrompt,
  toolChoiceConstraint,
  toolPartToText,
} from "./toolcall.js";
import { config } from "./config.js";

/**
 * 字段别名兼容读取。
 *
 * ⚠️ 实证（2026-10-16）：google-genai SDK 不同版本的序列化行为不一致 ——
 *   2.6.0 输出 `inlineData.mimeType`，而 **2.28.0 输出 `inlineData.mime_type`**
 *   （Blob 的 alias 在序列化路径上没生效）。若代理只读 camelCase，附件就会
 *   静默退化成 `application/octet-stream`，服务端按错误类型解码 ⇒ 模型
 *   答「没有提供图片」。这是最危险的失败形态（无报错、结果错误）。
 *   故请求解析一律走别名兼容。
 */
const alias = (obj, ...names) => {
  for (const n of names) {
    if (obj && typeof obj === "object" && obj[n] !== undefined) return obj[n];
  }
  return undefined;
};

/** 编码 { blobId, mime, name } → fileUri（files/...） */
export function encodeFileUri({ blobId, mime, name }) {
  const id = Buffer.from(`${blobId}|${mime ?? ""}|${name ?? ""}`, "utf8").toString("base64url");
  return `files/${id}`;
}

/** 解码 fileUri → { blobId, mime, name }；无法解析返回 null */
export function decodeFileUri(fileUri) {
  const raw = String(fileUri ?? "");
  const id = raw.startsWith("files/") ? raw.slice(6) : raw;
  if (!id) return null;
  try {
    const [blobId, mime, name] = Buffer.from(id, "base64url").toString("utf8").split("|");
    if (blobId?.startsWith("/")) return { blobId, mime, name };
  } catch {
    /* fallthrough */
  }
  return null;
}

/** mime → 中文媒体类型名（截断注记用） */
function mediaKind(mime) {
  const m = String(mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "图片";
  if (m.startsWith("audio/")) return "音频";
  if (m.startsWith("video/")) return "视频";
  if (m === "application/pdf") return "PDF文档";
  return "文件";
}

/** 按类型计数 → "图片3、音频1"（跳过计数为 0 的项） */
function kindCounts(list) {
  const c = {};
  for (const a of list) {
    const k = mediaKind(a.mime);
    c[k] = (c[k] ?? 0) + 1;
  }
  return Object.entries(c)
    .map(([k, n]) => `${k}${n}`)
    .join("、");
}

/**
 * ★ 附件数量截断：多轮压单轮时历史媒体按时间序累积，超上限【丢最旧、保最新】。
 *
 * 为什么保末尾：contents 按时间序排列（旧→新），最末尾的媒体对应用户当前轮次，
 * 语义上最重要；早期轮次的媒体参考价值递减。
 *
 * @param {Array<{mime:string}>} attachments 时间序（旧→新）
 * @param {number} max 上限（<=0 表示不限制）
 * @returns {{kept: Array, dropped: Array, note: string}} kept=保留（时间序），dropped=丢弃（旧→新）
 */
export function truncateAttachments(attachments, max) {
  const list = attachments ?? [];
  const cap = Number(max);
  if (!Number.isFinite(cap) || cap <= 0 || list.length <= cap) {
    return { kept: list, dropped: [], note: "" };
  }
  const kept = list.slice(list.length - cap); // 保末尾（最新）
  const dropped = list.slice(0, list.length - cap); // 丢开头（最旧）
  const note =
    `[媒体附件截断提示] 本次请求的媒体附件共 ${list.length} 个，超过通道单次上限 ${cap} 个。` +
    `已按时间顺序保留最新的 ${cap} 个（${kindCounts(kept)}）；` +
    `更早的 ${dropped.length} 个（${kindCounts(dropped)}）未提交给你，其内容你不可见——` +
    `请勿猜测、引用或声称看过这些早期媒体。如用户问起，请说明因数量限制仅有最近的媒体被提交。`;
  return { kept, dropped, note };
}

export function geminiToRobin(body) {
  const contents = Array.isArray(body?.contents) ? body.contents : [];
  const textParts = [];
  const attachments = [];
  const metaNotes = []; // 元信息注记（媒体截断提示等），置于历史文本之前

  const pushPart = (p) => {
    if (!p || typeof p !== "object") return;
    const inline = alias(p, "inlineData", "inline_data");
    const file = alias(p, "fileData", "file_data");
    const fileUri = alias(file, "fileUri", "file_uri");
    const hasText = typeof p.text === "string";
    // ★ 宽容解析（2026-10-17 实证）：text 与 inlineData/fileData 允许共存于同一 part。
    //   旧实现是 else-if 链 —— text 命中后附件被【静默丢弃】（模型答"没有收到文件"、
    //   全链路无报错）。生产实测：单 part 同带 text+inlineData 的请求，音频被吞。
    if (hasText) textParts.push(p.text);
    if (inline?.data) {
      attachments.push({
        mime: alias(inline, "mimeType", "mime_type") ?? "application/octet-stream",
        bytes: Buffer.from(inline.data, "base64"),
      });
    } else if (fileUri) {
      const ref = decodeFileUri(fileUri);
      if (ref) {
        attachments.push({
          ...ref,
          mime: ref.mime || alias(file, "mimeType", "mime_type") || "application/octet-stream",
        });
      } else {
        // 无法解析的引用（外部 URL 等）：转为文本提示，避免静默丢失
        textParts.push(`[附件引用无法解析: ${fileUri}]`);
      }
    } else if (!hasText) {
      // 工具历史（functionCall / functionResponse）→ 文本标记，保住多轮工具循环
      const toolText = toolPartToText(p);
      if (toolText) textParts.push(toolText);
    }
  };

  for (const c of contents) for (const p of c?.parts ?? []) pushPart(p);

  // ★ 多轮压单轮的媒体累积防护：超上限丢最旧、保最新，并显式注记
  //   （防模型幻觉早期媒体内容——与工具仿真"不静默丢弃"同一原则）
  // ⚠️ 不超限时 kept 与 attachments 是同一引用，不能先 length=0 再 push（会连带清空 kept）
  const { kept, note } = truncateAttachments(attachments, config.maxAttachments);
  if (kept !== attachments) {
    attachments.length = 0;
    attachments.push(...kept);
  }
  if (note) metaNotes.push(note);

  const prefix = [];
  // systemInstruction 并入文本前缀（Robin 侧无独立系统提示位）
  const sys = (body?.systemInstruction ?? body?.system_instruction)?.parts;
  if (Array.isArray(sys)) {
    const sysText = sys.map((p) => p?.text ?? "").join("");
    if (sysText) prefix.push(sysText);
  }

  // ★ 工具仿真：声明序列化为提示词块，置于系统指令之后、对话历史之前
  //   （与 gemini_web2api 的 google_contents_to_prompt 同构）
  const toolDefs = extractToolDefs(body);
  if (toolDefs.length) {
    prefix.push(buildToolPrompt(toolDefs, body) + toolChoiceConstraint(body, toolDefs));
  }
  prefix.push(...metaNotes);

  const text = [...prefix, ...textParts].join("\n");
  return { text, attachments, toolDefs };
}

/**
 * 非流式响应体
 * @param {string} model
 * @param {string} text
 * @param {string|{conversationId?:string, model?:string}} [finishReason] 兼容旧签名：传字符串为 finishReason；传对象时可带 conversationId / model（上游真实模型名）
 * @param {Array<{name:string, args:object}>} [functionCalls] 工具调用（prompt 仿真回填，见 toolcall.js）
 */
export function makeGeminiResponse(model, text, finishReason = "STOP", functionCalls = null) {
  let fr = "STOP";
  let meta = null;
  if (typeof finishReason === "string") fr = finishReason;
  else if (finishReason && typeof finishReason === "object") meta = finishReason;
  const parts = [];
  if (text) parts.push({ text });
  for (const fc of functionCalls ?? []) parts.push({ functionCall: { name: fc.name, args: fc.args ?? {} } });
  if (!parts.length) parts.push({ text: "" });
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: fr,
        index: 0,
      },
    ],
    // 上游真实模型名（如 "Used 3.5 Flash-Lite model"）优先于请求里的模型名
    modelVersion: meta?.model ?? model,
    ...(meta?.conversationId ? { conversationId: meta.conversationId } : {}),
    // ★ 上游不回传真实 usage（逆向确认：Lfzrc 只有 #30/#41/#42，无 token 字段），
    //   故这里给 0 占位，由 usage-estimate.js 的 withEstimatedUsage() 覆盖为**估算值**。
    //   保留 0 是为了：未经估算包装的路径不会输出看似真实的数字。
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  };
}

/** 流式 chunk（SSE data 载荷） */
export function makeGeminiChunk(model, text, finishReason = null) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        ...(finishReason ? { finishReason } : {}),
        index: 0,
      },
    ],
    modelVersion: model,
  };
}

/** 流式 chunk：单个 functionCall part（工具仿真回填） */
export function makeGeminiFunctionCallChunk(model, call, finishReason = null) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ functionCall: { name: call.name, args: call.args ?? {} } }] },
        ...(finishReason ? { finishReason } : {}),
        index: 0,
      },
    ],
    modelVersion: model,
  };
}

export function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Gemini 原生错误格式 */
export function geminiError(code, message, status) {
  return { error: { code, message, status } };
}
