// service/lib/upload.js — 附件上传（push.clients6 两步 resumable）
//
// ★ 2026-10-15 端到端实证（_upload-full / _blue-verify / probe39/40）：
//   - 端点：https://push.clients6.google.com/upload/
//   - 必需 header：X-Tenant-Id: bard-storage、X-Goog-Upload-Protocol: resumable、
//     X-Goog-Upload-Command: start、Push-ID: feeds/mcudyrk2a4khkz、
//     X-Goog-Upload-Header-Content-Length、X-Goog-Upload-Header-Content-Type
//   - 两步式：① 初始化拿 upload_url（响应头 X-Goog-Upload-URL）
//             ② POST upload_url（command: "upload, finalize"）提交字节
//   - ★ finalize 响应体就是 blobId 字符串本身（非 JSON），如
//     /contrib_service/ttl_1d/vhoo7q5ua2tgjjzufwxarmmrqrnul21792068861（TTL 1 天）
//   - ⚠️ 实证请求未带 authorization 头也成功（200）；带 Bearer 的兼容性未测，
//     故 config.robinAuthToken 存在时默认不发送（见 uploadResumable 的 sendAuth 参数）。
//
// 关键架构点（Vercel）：函数"出站"上传不受 4.5MB 入站限制，
// 所以大文件由服务端转发没问题；入站侧需客户端分片（见 app.js /upload 路由）。

import { config } from "./config.js";

function authHeaders() {
  return config.robinAuthToken ? { authorization: `Bearer ${config.robinAuthToken}` } : {};
}

/**
 * 两步 resumable 上传（一步到位：小文件友好）。
 * @param {object} opts
 * @param {Uint8Array} opts.bytes  文件字节
 * @param {string} opts.mime
 * @param {string} [opts.name]
 * @param {boolean} [opts.dryRun]  只走第一步（初始化），拿 upload_url
 * @param {boolean} [opts.sendAuth] 是否带 authorization 头（默认 false：实证无需）
 * @returns {Promise<{uploadUrl:string, blobId:string, finalize?:object}>}
 */
export async function uploadResumable({ bytes, mime = "application/octet-stream", name, dryRun = false, sendAuth = false }) {
  const { uploadUrl } = await pushStart({ length: bytes.length, mime, sendAuth });
  if (dryRun) return { uploadUrl };
  const { blobId } = await pushFinalize(uploadUrl, { bytes, mime, sendAuth });
  return { uploadUrl, blobId };
}

/**
 * 第一步：向 push.clients6 初始化一个 resumable 上传会话。
 * @returns {Promise<{uploadUrl: string}>} push 侧上传 URL（后续 chunk 都打这里）
 */
export async function pushStart({ length, mime = "application/octet-stream", sendAuth = false }) {
  const initHeaders = {
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    "x-tenant-id": config.uploadTenantId,
    "x-goog-upload-protocol": "resumable",
    "x-goog-upload-command": "start",
    "x-goog-upload-header-content-length": String(length),
    "x-goog-upload-header-content-type": mime,
    ...(config.pushId ? { "push-id": config.pushId } : {}),
    ...(sendAuth ? authHeaders() : {}),
  };
  const initResp = await fetch(config.uploadBase, {
    method: "POST",
    headers: initHeaders,
    body: "",
  });
  if (!initResp.ok && initResp.status !== 200) {
    const t = await initResp.text().catch(() => "");
    throw new Error(`上传初始化失败 HTTP ${initResp.status}: ${t.slice(0, 300)}`);
  }
  const uploadUrl = initResp.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("初始化响应缺少 X-Goog-Upload-URL 头");
  return { uploadUrl };
}

/**
 * 第二步：向 push 侧 uploadUrl 提交字节（chunk 或整体）并 finalize。
 * 注意：不完整 chunk 时 push 侧按 Google resumable 协议回 **308 Resume Incomplete**
 * （非 2xx），属正常中间态，不可当错误。
 * @returns {Promise<{status:number, blobId:string, raw:string}>}
 */
export async function pushFinalize(uploadUrl, { bytes, command = "upload, finalize", offset = 0, mime, sendAuth = false }) {
  const upResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": mime ?? "application/octet-stream",
      "x-goog-upload-command": command,
      "x-goog-upload-offset": String(offset),
      ...(config.pushId ? { "push-id": config.pushId } : {}),
      ...(sendAuth ? authHeaders() : {}),
    },
    body: bytes,
  });
  const text = await upResp.text().catch(() => "");
  // 200/201 = 完成；308 = 不完整（还有后续 chunk）——都是成功态
  if (![200, 201, 308].includes(upResp.status)) {
    throw new Error(`上传失败 HTTP ${upResp.status}: ${text.slice(0, 300)}`);
  }
  // ★ 2026-10-15 实测：finalize 响应体就是 blobId 字符串本身（非 JSON）
  const blobId = command.includes("finalize") && upResp.status !== 308 ? text.trim() : "";
  return { status: upResp.status, blobId, raw: text.slice(0, 1000) };
}

/** 从上传结果里取 blobId（2026-10-15 实测：finalize 响应体即 blobId） */
export function extractFileRef(result) {
  if (!result) return null;
  if (typeof result.blobId === "string" && result.blobId) return result.blobId;
  if (typeof result === "string") return result;
  return null;
}
