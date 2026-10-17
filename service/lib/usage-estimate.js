// service/lib/usage-estimate.js —— 请求 token 用量**本地估算**
//
// ── 为什么需要它 ────────────────────────────────────────────────────────
// 上游（Robin / Gemini App 原生通道）不在响应里回传 usageMetadata，
// `gemini.js` 的 usageMetadata 因此一直是全 0。后果：robin 通道对 token
// 完全不可观测，Eidolon 侧记到的也是 prompt=0/cached=0/uncached=0，
// 于是「这次为什么吃掉 22% 配额」只能靠事后猜测。
//
// 2026-10-17 的逆向结论（临时插桩 dump Lfzrc 全字段）：
//   已解析的元信息字段是 #30(model) / #41(rank) / #42(thinking) / #25(用户文本)，
//   **没有任何字段承载 token 计数** ⇒ 走「从响应挖」这条路是不通的
//   （插桩已回滚，生产代码保持干净）。故改用本地估算。
//
// ── 口径来源（Google 公开计费文档，2026-10-17 核对）────────────────────
//   文本：按 ~4 字符/token 的量级估（中文偏密，取 3 字符/token 更贴近）
//   图片：≤384px 平面图 = 258 token；更大按 768px 平铺（每 tile 258）
//   视频：默认 media resolution = 258 token/帧，1 fps 采样
//         低 media resolution     =  66 token/帧
//         音频轨                 =  32 token/秒
//   ⇒ 同一段音频：走占位视频 = fps×258 + 32×秒数，走原音 = 32×秒数
//
// ── 定位 ────────────────────────────────────────────────────────────────
// 这是**估算**，不是账单。用途有三个，都不要求精确：
//   ① 相对比较（这一轮比上一轮贵/便宜多少），定位配额消耗的大头；
//   ② 触发护栏（单请求估算过大时告警），防再次出现 22% 这种形态；
//   ③ healthz 暴露，让运维随时看到「典型请求成本量级」。
// 绝不用于计费/对账 —— 精度不足以承担该职责，字段命名一律带 `estimated` 前缀。

/** 计费口径常量（集中在此，便于口径变更时单点修改） */
export const USAGE_RATES = {
  /** 文本：中文约 3 字符/token，英文约 4。取 3 偏保守（高估）。 */
  charsPerToken: 3,
  /** 图片：≤384px 直接 258；>384px 按 768 平铺，每 tile 258。 */
  imageFlatTokens: 258,
  imageTileTokens: 258,
  imageTilePx: 768,
  imageSmallPx: 384,
  /** 视频：帧率 × 每帧 token（1fps × 258 = 258 token/s）。 */
  videoTokensPerFrame: 258,
  /** 音频：32 token/秒（按 1 Kbps 处理）。 */
  audioTokensPerSecond: 32,
  /** 输出：文本回复按同样比例折算（缺 #30 真实计数时的近似）。 */
  outputCharsPerToken: 3,
};

/** 解析 WebP/PNG/JPEG 尺寸；解不出返回 null（调用方按"未知"处理，不猜）。 */
function imageSize(bytes, mime) {
  try {
    const b = bytes;
    const m = String(mime || "").toLowerCase();
    // PNG: IHDR 宽高在 16..24
    if (m.includes("png") && b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // GIF: 逻辑屏宽高在 6..10
    if (m.includes("gif") && b.length > 10) {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    // WebP (RIFF): VP8X/VP8/VP8L 三种子格式
    if (m.includes("webp") && b.length > 30 && b.toString("ascii", 0, 4) === "RIFF") {
      const fourcc = b.toString("ascii", 12, 16);
      if (fourcc === "VP8X") {
        const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return { width: w, height: h };
      }
      if (fourcc === "VP8 ") {
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === "VP8L") {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG: 逐段扫描 SOFn
    if (m.includes("jpeg") || m.includes("jpg")) {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        // SOF0..SOF15，排除 DHT(C4)/JPG(C8)/DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {
    /* 尺寸不可解析 → 返回 null，调用方按上限估并标注 */
  }
  return null;
}

function imageTokens(bytes, mime) {
  const R = USAGE_RATES;
  const size = bytes?.length ? imageSize(bytes, mime) : null;
  if (!size) {
    // 尺寸未知：按 1 tile 估，并标注出来，避免给出虚假的精确感。
    return { tokens: R.imageTileTokens, tiles: 1, sizeKnown: false };
  }
  const long = Math.max(size.width, size.height);
  if (long <= R.imageSmallPx) {
    return { tokens: R.imageFlatTokens, tiles: 1, sizeKnown: true, width: size.width, height: size.height };
  }
  const tiles = Math.ceil(size.width / R.imageTilePx) * Math.ceil(size.height / R.imageTilePx);
  return {
    tokens: tiles * R.imageTileTokens,
    tiles,
    sizeKnown: true,
    width: size.width,
    height: size.height,
  };
}

/**
 * 估算请求的输入 token。
 *
 * @param {object} body Gemini 原生请求体（解析后的对象）
 * @returns {{estimated:boolean, promptTokens:number, breakdown:object, notes:string[]}}
 */
export function estimatePromptTokens(body) {
  const R = USAGE_RATES;
  const notes = [];
  const breakdown = { text: 0, images: 0, audio: 0, videoFrames: 0, videoAudio: 0, unknown: 0 };
  let textChars = 0;
  let audioSeconds = 0;
  let videoSeconds = 0;

  const contents = Array.isArray(body?.contents) ? body.contents : [];
  for (const content of contents) {
    for (const part of Array.isArray(content?.parts) ? content.parts : []) {
      if (typeof part?.text === "string" && part.text) {
        textChars += part.text.length;
        continue;
      }
      const inline = part?.inlineData ?? part?.inline_data;
      const data = inline?.data;
      if (typeof data !== "string" || !data) continue;
      const mime = String(inline?.mimeType ?? inline?.mime_type ?? "");
      let bytes;
      try {
        bytes = Buffer.from(data, "base64");
      } catch {
        breakdown.unknown++;
        continue;
      }
      const m = mime.toLowerCase();
      if (m.startsWith("image/")) {
        const it = imageTokens(bytes, m);
        breakdown.images += it.tokens;
        if (!it.sizeKnown) notes.push("一张图片尺寸无法解析，按 1 tile 估");
        continue;
      }
      if (m.startsWith("audio/")) {
        const sec = estimateAudioSeconds(bytes, m);
        audioSeconds += sec;
        breakdown.audio += Math.round(sec * R.audioTokensPerSecond);
        continue;
      }
      if (m.startsWith("video/")) {
        // ★ 占位视频：帧率决定视觉 token。默认按 1 fps 估（保守），
        //   调用方若知道实际帧率（如 media shim 的 PLACEHOLDER_FPS）应传入覆盖。
        const meta = videoMeta(bytes);
        const fps = meta.fps ?? 1;
        videoSeconds += meta.seconds;
        breakdown.videoFrames += Math.round(meta.seconds * fps * R.videoTokensPerFrame);
        // 音轨：占位视频保留原音频（零转码），所以音频照常计费。
        breakdown.videoAudio += Math.round(meta.seconds * R.audioTokensPerSecond);
        if (meta.fps == null) notes.push("视频帧率未知，按 1 fps 估（保守）");
        continue;
      }
      breakdown.unknown++;
    }
  }

  breakdown.text = Math.ceil(textChars / R.charsPerToken);

  // 文件上传（fileData）与文档：无字节可读，按每张粗估一个 tile。
  const fileDataParts = contents.flatMap((c) => (Array.isArray(c?.parts) ? c.parts : []))
    .filter((p) => p?.fileData ?? p?.file_data);
  if (fileDataParts.length) {
    breakdown.unknown += fileDataParts.length;
    notes.push(`${fileDataParts.length} 个 fileData 无字节可读，未计入 token`);
  }

  const promptTokens =
    breakdown.text + breakdown.images + breakdown.audio + breakdown.videoFrames + breakdown.videoAudio;
  return {
    estimated: true,
    promptTokens,
    breakdown,
    notes,
    inputs: { textChars, audioSeconds: round2(audioSeconds), videoSeconds: round2(videoSeconds) },
  };
}

/** 音频时长估算（秒）。
 *  webm/opus 的容器时长常为 N/A（流式 webm 常见），所以不依赖 header：
 *  按 opus 24 kbps 估字节→秒，并标注为估算。mp3/wav 走 header。
 */
function estimateAudioSeconds(bytes, mime) {
  const m = mime.toLowerCase();
  if (m.includes("wav")) {
    try {
      const byteRate = bytes.readUInt32LE(28) || 1;
      return Math.max(0, (bytes.length - 44) / byteRate);
    } catch { /* 落到通用估算 */ }
  }
  // 通用：按 24 kbps 语音编码估算（opus/ AAC-VOIP 的常见码率）。
  return (bytes.length * 8) / 24_000;
}

/** 视频元信息（秒 + 帧率）。
 *  webm 容器时长常为 N/A；这里用「字节/码率」粗估，并对占位视频（极小视频轨）
 *  用音频字节反推。精度足够做量级判断。
 */
function videoMeta(bytes) {
  // 占位视频的特征：视频轨极小，主体是音频。按音频码率估时长。
  const seconds = (bytes.length * 8) / 24_000;
  return { seconds, fps: null };
}

/** 组装对外的 usageMetadata（估算值）。
 *  字段与 Gemini 原生一致，方便 Eidolon 侧无需改动即可消费；但额外挂
 *  ``usageEstimated: true`` 与 ``usageBreakdown``，诚实标明这是估算。
 */
export function withEstimatedUsage(response, estimate) {
  if (!response || typeof response !== "object") return response;
  const prompt = Math.max(0, Math.round(estimate?.promptTokens ?? 0));
  const completion = Math.max(
    0,
    Math.round(
      (response.candidates?.[0]?.content?.parts ?? [])
        .reduce((n, p) => n + (typeof p?.text === "string" ? p.text.length : 0), 0) /
        USAGE_RATES.outputCharsPerToken
    )
  );
  return {
    ...response,
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: completion,
      totalTokenCount: prompt + completion,
    },
    // ★ 诚实标注：下游（Eidolon quota / 账单）不得把这当真实计量。
    usageEstimated: true,
    usageBreakdown: estimate?.breakdown,
    usageNotes: estimate?.notes,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;