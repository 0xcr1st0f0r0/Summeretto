// service/lib/pq.js — ProcessQuery（Robin 主对话 RPC）协议层：请求装配 + 响应解析
//
// ⚠️ 全部字段号来自 APK 字节码级逆向（docs/stage2-robin-protocol.md），
//    修改任何字段号前，务必对照该文档 + out/robin/fieldmap-*.txt。
//
// ══════════════════════════════════════════════════════════════════════════
// ★★★ 2026-10-15 实测校准：三条关键更正（此前版本全部错误）★★★
// ══════════════════════════════════════════════════════════════════════════
//
// 【更正 1】请求消息就是 Lgcvp 本身，**没有 Lgcxj 外层包装**。
//   铁证：RPC 描述符注册（classes2.dex / Lgbdm.cg）
//       "assistant.mobile.robin.RobinService" + "ProcessQuery"
//       请求 message = Lgcvp.a（默认实例）   响应 message = Lgcvq.a
//   而 Lgcxj 在整个 RPC 注册表里一处都没出现 —— 它不是任何 RPC 的消息类型。
//   此前把 Lgcvp 再包一层 Lgcxj{ #1 } 后，服务端按 Lgcvp 解析只能看到
//   「未知普通字段 #1」，真正的 ext1000(Lgcvm) 被埋在里面 → 永远判定
//   "First request should be 'initial'"。这一条是 initial 攻坚四轮全负的根因。
//
// 【更正 2】`Lgauy.#4 = ClientType` 是**必需**的，否则服务端报
//   "ClientType is UNSPECIFIED or not provided"。
//   枚举 Lgprd：0=CLIENT_TYPE_UNSPECIFIED 1=IOS 2=ANDROID 3=OMNIENT 4=LENS
//   （安卓侧固定用 2）
//
// 【更正 3】一次完整的文本查询是 **initial → prefetch → commit** 三步，
//   不是单帧。每一步发什么，由 Lansi.i / Lansi.f / Lansi.j 字节码实证：
//
//     ① initial（Lansi.i，日志 "Send ProcessQuery initial …" / "INIT_SENT"）
//          Lgcvp[ext1000] Lgcvm {
//            #1 Lgauy { #25 文本, #4 ClientType, … }
//            #2 Lgcww { #1 文本 }
//            #8 enum  #9 int32  #4 Lgatn  #6 Lgcvd    ← 均为条件写入
//          }
//        → 服务端 ACK：Lgcvq[ext1000] Lgcvo{ #1 Lgavd{ #1: [N 个 int32 能力表] } }
//          （ACK 与查询文本无关，只随 ClientType 变化元素个数）
//
//     ② prefetch（Lansi.j，日志 "Send ProcessQuery prefetch" / "PREFETCH_SENT"）
//          Lgcvp[ext1007] Lgcvl{ #1: 查询文本 }        ← ★ 查询文本真正落这里
//        （Lgcxb.q 字节码：Lgcvl.c=1, Lgcvl.d=String）
//
//     ③ commit（Lansi.f，日志 "Send ProcessQuery commit" / "COMMIT_SENT"）
//          ★★ 文本模式 = 单帧（probe23/25 实证，2026-10-15）：
//             Lgcvp[ext1007] Lgcvl{ #2: godw(空) }
//           字节码：Lansi.f [312] `if-nez L, +77` —— 仅文本模式（Lansi.L==null）发此帧。
//          ★ 语音模式才追加两帧（Lansi.f [470] `if-eqz ar, +148` 门控 Lansi.ar）：
//             Lgcvp[ext1010] Lgcuz{ #2: godw(空) }
//             Lgcvp[ext1010] Lgcuz{ #3: godw(空) }
//           ⚠️ 文本模式发 Lgcuz → "CommitControlFeature is missing in initial request"
//             （probe23 T4/T5/T6 实证）；不先 prefetch 就 commit → "No prefetch query to commit."
//           ✅ 正确文本流程 = initial → prefetch → 单帧 Lgcvl{#2}，服务端随即流式推送
//              10 帧（含真实模型输出，模型名 "3.5 Flash-Lite"）。
//
// 【更正 4】服务端响应是 **gzip 压缩** 的（响应头 `grpc-encoding: gzip`），
//   gRPC 帧的压缩标志位 = 1，payload 以 1f8b 开头，必须先解压。
//
// ── 字段表（tools/fieldmap.py 实测）────────────────────────────────────
// Lgcvm  oneof=0 hasbits=1  范围 1..9
//   #1 MESSAGE gauy    #2 MESSAGE gcww   #4 MESSAGE gatn
//   #6 MESSAGE gcvd    #8 ENUM           #9 INT32
// Lgauy  22 字段；#4 ENUM(ClientType) #25 STRING(文本) #20/#21 oneof<int32>
// Lgcww  #1 STRING     Lgcvd  #1 STRING
// Lgcvj  #1 MESSAGE gcvi（Lgcvi = oneof{#1 STRING, #2 STRING}）
// Lgcvl  oneof{ #1 STRING, #2/#3/#4 godw(空), #5 gcxi }
// Lgcuz  oneof{ #1/#2/#3 godw(空) }
// 扩展注册：Lgcvp ← 1000=Lgcvm 1001=Lgcvr 1002=Lgcwh 1003=Lgcwr 1007=Lgcvl
//                  1008=Lgcxa 1009=Lgcva 1010=Lgcuz 1011=Lgcwd 1013=Lgcwn 1015=Lgcvf
//           Lgcvm ← 1000=Lgcwe 1001=Lgcvb 1002=Lgcwp 1004=Lgcvk 1006=Lgcux
//                  1007=Lgcwx 1008=Lgcuy 1009=Lgcvs 1011=Lgcvj
//           Lgcvq ← 1000=Lgcvo 1002=Lgcwm 1003=Lgcvc 1004=Lgcwv 1008=Lgcwv
//                  1012=Lgcxe 1014=Lgcve
//
// ⚠️ Lgcvm[ext1006] = Lgcux 是 AudioFeature（case1=use_speech，
//    case2=s3_preprocessed_audio）。**纯文本查询不要发它** —— 发了就会引入
//    语音路径，服务端转而报 "SpeechRecognitionFeature is required for
//    AudioFeature.xxx to work"。
//
// ── 附件/媒体链路 ★★★ 2026-10-15 深夜实证打通（probe38/39/40 + _blue-verify）★★★
//
// 【完整链路】上传 → blobId → 信封 → initial 帧
//   ① 上传：POST https://push.clients6.google.com/upload/（租户 bard-storage，
//      Push-ID: feeds/mcudyrk2a4khkz），两步 resumable；finalize 响应体即 blobId
//      字符串，形如 /contrib_service/ttl_1d/vhoo7q5ua2tgjjzufwxarmmrqrnul21792068861
//      （TTL 1 天）。见 upload.js。
//   ② 信封（实测可用最小形态，probe40 C 矩阵 8/8 通过）：
//      Lgcvp[ext1000] Lgcvm[ext1001] Lgcvb {
//        #1 Lfzqy {
//          #1 Lgbkn { #3 Lgbku {                 ← 仅此一个字段！
//            #1 Lgbkr { #1 blobId, #3 mime, #4 枚举 },
//            #2 name（可选）
//          } }
//        }
//      }
//      ⚠️ Lgbkn 只需要 #3（Lgbku repeated）——#1（Lanmw.h 的 URI 列表）、
//         #5（Lgbko→Lfzms→Lfzmr）均非必需（probe36/39/40 C8 实证：带上也不错）。
//      ⚠️ Lfzqy.#13（Lgauy 副本）非必需（C8 实证带上也行）。
//      ⚠️ 旧假设「Lgbkn.#5 Lgbko 链」与「Lgbku.#3 = base64(Lgbku)」均已证伪/降级
//         为可选：base64 那个是 probe34 时代的误判，删掉照样跑（C3）。
//   ③ initial 帧照常发（text + mode:1 + ext1001 信封），然后 prefetch → commit。
//
// 【C 矩阵结论（probe40，纯蓝 64×64 PNG 实证）】
//   C1 全字段(blobId+mime+e4+name+b64空)  ✅ 识别蓝色
//   C2 去掉 #2 name                      ✅ 识别蓝色
//   C3 去掉 #3 b64(空Lgbku)              ✅ 识别蓝色
//   C4 去掉 Lgbkr.#4 枚举(默认0)          ✅ 识别蓝色
//   C5 去掉 Lgbkr.#3 mime                ✅ 识别蓝色
//   C6 去掉 Lgbkr.#1 blobId              ❌ grpc=13 Dependency RPC failed ← 唯一硬必需
//   C7 最小 = 仅 Lgbkr{#1 blobId}         ✅ 识别蓝色
//   C8 完整 app 信封(Lgbko+Lgauy)        ✅ 识别蓝色
//   ⇒ blobId 是唯一必需字段；mime/枚举/name 强烈建议携带（帮服务端选解析器）。
//
// 【Lgbkr.#4 枚举 = 文件来源类型】（Lbcsn.a(mime) 客户端映射，probe38 实测服务端支持集）
//   支持：0=UNSPECIFIED 1=IMAGE(png/jpeg/webp/heic/heif…) 5=EXCEL(xlsx/xls)
//         6=VIDEO(mp4) 7=PDF 8=TEXT(plain) 9=DOC(rtf/msword) 12=AUDIO?(待实证)
//   拒绝("Unsupported file source.")：2=CSV 3=GSPREADSHEET 4=AVIF 10=DOCX
//         11=GDOC（13=HWP 14=PPTX 15=ODT 16=PRESENTATION 20=VORBIS 同属拒绝集，未逐一实测）
//   ⚠️ 传错枚举（如把 image 传成 3）→ "Unsupported file source."，与图片内容无关。

import { Writer, decodeFields, fieldOne, fieldAll, asString, asUint } from "./wire.js";
import { gunzipSync } from "node:zlib";

/* ────────────────────────── ClientType（Lgprd 枚举） ────────────────────────── */

export const ClientType = Object.freeze({
  UNSPECIFIED: 0,
  IOS: 1,
  ANDROID: 2,
  OMNIENT: 3,
  LENS: 4,
});

/* ────────────────────────── 帧 ────────────────────────── */

/**
 * ★ ProcessQuery 请求 = Lgcvp 字节，直接发送，不要任何外层包装。
 * （保留函数名以兼容旧调用点；内部不再包 Lgcxj）
 */
export function clientFrame(lgcvpBytes) {
  return lgcvpBytes;
}

/** @deprecated 错误做法：Lgcxj 不是 ProcessQuery 的消息类型，仅作逆向留档 */
export function legacyLgcxjWrap(lgcvpBytes) {
  return new Writer().message(1, lgcvpBytes).finish();
}

/**
 * 服务端帧：**ProcessQuery 的响应就是 Lgcvq 本身，同样没有外层包装**。
 * 兼容旧写法：若首字段为 #1 且整帧像一个「单字段包裹」，也按包裹处理。
 */
export function parseServerFrame(payload) {
  const fields = decodeFields(payload);
  // 直接就是 Lgcvq：顶层出现扩展号（>=1000）
  if (fields.some((f) => f.no >= 1000)) {
    return { kind: "response", body: payload };
  }
  // 兼容旧版 Lgcxk{ #1 Lgcvq | #2 enum }
  const f1 = fieldOne(payload, 1);
  if (f1 && f1.wt === 2) return { kind: "response", body: f1.value };
  const f2 = fieldOne(payload, 2);
  if (f2 && f2.wt === 0) return { kind: "control", code: asUint(f2.value) };
  return { kind: "unknown", raw: payload };
}


/* ────────────────────────── 请求装配 ────────────────────────── */

/** Lgcww { #1: string } */
export function buildLgcww(text) {
  return new Writer().string(1, text).finish();
}

/** Lgcvd { #1: string } */
export function buildLgcvd(value) {
  return new Writer().string(1, value).finish();
}

/** Lfzww { #1 enum, #2 bool } */
export function buildLfzww({ mode, flag } = {}) {
  const w = new Writer();
  if (mode !== undefined) w.varint(1, mode);
  if (flag !== undefined) w.bool(2, flag);
  return w.finish();
}

/** Lfzou { #1 Lgbmd{ #1 bool, #2 string[] }, #2 packed enum[] } */
export function buildLfzou({ gbmd, enums } = {}) {
  const w = new Writer();
  if (gbmd) {
    const inner = new Writer();
    if (gbmd.flag !== undefined) inner.bool(1, gbmd.flag);
    for (const s of gbmd.list ?? []) inner.string(2, s);
    w.message(1, inner.finish());
  }
  if (enums?.length) w.packedVarint(2, enums);
  return w.finish();
}

/**
 * Lgauw { #1 str c, #2 Lgyst, #3 Lgpei, #4 Lgmay, #5/#6 bool, #10 str i, #11 int j }
 * 证据：Lanma.e（Lgauw#3 ← Lapui.m；#10/#11 被重置为默认）
 */
export function buildLgauw({ c, gpeiBytes, bool5, bool6, i, j } = {}) {
  const w = new Writer();
  if (c !== undefined) w.string(1, c);
  if (gpeiBytes) w.message(3, gpeiBytes); // Lgpei（计时/会话数据；结构见 fieldmap）
  if (bool5 !== undefined) w.bool(5, bool5);
  if (bool6 !== undefined) w.bool(6, bool6);
  if (i !== undefined) w.string(10, i);
  if (j !== undefined) w.varint(11, j);
  return w.finish();
}

/**
 * Lgauy（主载荷，22 字段）
 * opts: {
 *   text,            // → #25(w)  用户文本（Lanma.e: Lgbla.f）
 *   s26,             // → #26(x)  Lapui.U（Lanma.e）
 *   lfzww, lgauw, lfzou,   // 子消息（传对象，或 *Bytes 传已编码字节）
 *   s7, s16, s23,    // #7/#16/#23 字符串（语义待校准）
 *   list28,          // #28 STRING_LIST
 *   packed2021,      // #20/#21 oneof<INT32>
 *   enums: {4,5,18,22} // 枚举字段
 * }
 */
export function buildLgauy(opts = {}) {
  const w = new Writer();
  if (opts.lfzwwBytes) w.message(1, opts.lfzwwBytes);
  else if (opts.lfzww) w.message(1, buildLfzww(opts.lfzww));

  if (opts.lgauwBytes) w.message(3, opts.lgauwBytes);
  else if (opts.lgauw) w.message(3, buildLgauw(opts.lgauw));

  // ★ Lgauy.#4 = ClientType —— 必需！缺省固定 ANDROID(2)
  w.varint(4, opts.enum4 ?? ClientType.ANDROID);
  if (opts.enum5 !== undefined) w.varint(5, opts.enum5);

  if (opts.lfzouBytes) w.message(6, opts.lfzouBytes);
  else if (opts.lfzou) w.message(6, buildLfzou(opts.lfzou));

  // 字符串 / 枚举分开写（清晰起见）
  if (opts.s7 !== undefined) w.string(7, opts.s7);
  if (opts.s16 !== undefined) w.string(16, opts.s16);
  if (opts.enum18 !== undefined) w.varint(18, opts.enum18);
  if (opts.enum22 !== undefined) w.varint(22, opts.enum22);
  if (opts.s23 !== undefined) w.string(23, opts.s23);
  if (opts.packed2021 !== undefined) w.varint(20, opts.packed2021);
  if (opts.text !== undefined) w.string(25, opts.text);
  if (opts.s26 !== undefined) w.string(26, opts.s26);
  for (const s of opts.list28 ?? []) w.string(28, s);

  // 联调用：任意字段原样注入（探针 / feature 扫描）
  for (const { field, bytes } of opts.rawMessages ?? []) {
    w.message(field, bytes instanceof Uint8Array ? bytes : new Uint8Array(0));
  }
  for (const { field, value } of opts.rawVars ?? []) w.varint(field, value);

  return w.finish();
}

/** Lgbkr { #1 str, #2 enum, #3 str, #4 enum, #5 str } */
export function buildLgbkr({ s1, e2, s3, e4, s5 } = {}) {
  const w = new Writer();
  if (s1 !== undefined) w.string(1, s1);
  if (e2 !== undefined) w.varint(2, e2);
  if (s3 !== undefined) w.string(3, s3);
  if (e4 !== undefined) w.varint(4, e4);
  if (s5 !== undefined) w.string(5, s5);
  return w.finish();
}

/** Lgbks { #1 Lgaci{ #1 str }, #2 enum, #3 str, #4 str } */
export function buildLgbks({ uri, e2, s3, s4 } = {}) {
  const w = new Writer();
  if (uri !== undefined) w.message(1, new Writer().string(1, uri).finish());
  if (e2 !== undefined) w.varint(2, e2);
  if (s3 !== undefined) w.string(3, s3);
  if (s4 !== undefined) w.string(4, s4);
  return w.finish();
}

/** Lgadu { #1 bool, #2 bytes } */
export function buildLgadu({ flag, bytes } = {}) {
  const w = new Writer();
  if (flag !== undefined) w.bool(1, flag);
  if (bytes) w.bytes(2, bytes);
  return w.finish();
}

/**
 * Lgbku（附件消息，11 字段）
 * 已确认：Lgbku 由 Lanjc.f(Lapue):Lgbku 从 app 模型转换（mime/名称/尺寸）。
 * 布局： #1 Lgbkr{文件描述} / #2 str / #3 str / #5 Lgbks / #10 Lgadu{bytes} / #1000,#1001 bool
 * ⚠️ 字段语义映射待真机校准：这里给出"常见组合"，可通过 raw 覆盖。
 */
export function buildLgbku({ kr, s2, s3, ks, gadu, s7Bytes, s11Bytes, s12Bytes, s14Bytes, bool1000, bool1001 } = {}) {
  const w = new Writer();
  if (kr) w.message(1, typeof kr === "object" && !(kr instanceof Uint8Array) ? buildLgbkr(kr) : kr);
  if (s2 !== undefined) w.string(2, s2);
  if (s3 !== undefined) w.string(3, s3);
  if (ks) w.message(5, typeof ks === "object" && !(ks instanceof Uint8Array) ? buildLgbks(ks) : ks);
  if (s7Bytes) w.message(7, s7Bytes);
  if (gadu) w.message(10, typeof gadu === "object" && !(gadu instanceof Uint8Array) ? buildLgadu(gadu) : gadu);
  if (s11Bytes) w.message(11, s11Bytes);
  if (s12Bytes) w.message(12, s12Bytes);
  if (s14Bytes) w.message(14, s14Bytes);
  if (bool1000 !== undefined) w.bool(1000, bool1000);
  if (bool1001 !== undefined) w.bool(1001, bool1001);
  return w.finish();
}

/** Lfzmr { #1 uri(string), oneof: #3 string | #4 Lgbku | #6 bytes } */
export function buildLfzmr({ uri, str, gbkuBytes, bytes } = {}) {
  const w = new Writer();
  if (uri !== undefined) w.string(1, uri);
  if (gbkuBytes) w.message(4, gbkuBytes);
  else if (str !== undefined) w.string(3, str);
  else if (bytes) w.bytes(6, bytes);
  return w.finish();
}

/** Lgbko { #2 Lfzms }，Lfzms { #1 Lfzmr } */
export function buildLfzmsFromFzmr(lfzmrBytes) {
  return new Writer().message(1, lfzmrBytes).finish(); // Lfzms
}

/** Lgbkn { #3 Lgbku[], #5 Lgbko{ #2 Lfzms } } */
export function buildLgbkn({ gbkuList = [], fzmsBytes } = {}) {
  const w = new Writer();
  for (const b of gbkuList) w.message(3, b);
  if (fzmsBytes) {
    const gbko = new Writer().message(2, fzmsBytes).finish();
    w.message(5, gbko);
  }
  return w.finish();
}

/**
 * Lfzqy { #1 Lgbkn, #13 Lgauy, #47 rank, #48 思考档位, #66 名称, #67 routingVariantId }
 * （63 字段信封；上表只列已解字段）
 *
 * ★★ 思考强度承载位（2026-10-16 逆向定案，字节码级）
 *   证据链：Lanmw.c → Lfzqz.{O,E,P,S} → Lfzqy.{R,T,S,U}
 *     Lfzqz.O(int)    → hasBits1 |= 1<<11 → Lfzqy.#47 (R, INT32)  = rank
 *     Lfzqz.P(int)    → hasBits1 |= 1<<12 → Lfzqy.#48 (S, INT32)  = 思考档位值 ★
 *     Lfzqz.E(String) → hasBits1 |= 1<<13 → Lfzqy.#66 (T, STRING) = 显示名
 *     Lfzqz.S(String) → hasBits1 |= 1<<14 → Lfzqy.#67 (U, STRING) = routingVariantId ★
 *   （hasBits1 位序 ↔ fieldmap hasbit 索引：32+n）
 *   取值来源：Laloi{int value, String routingVariantId} → 即 Lalsq.g(int, Z, String, …)
 *   档位值：Low=1 / Medium=4 / High=2（Apollo flag `launch_ultra_mode_pro_policy`
 *           → Lgaic.#34 Lgawz → Lgawx.#2 Lgbdp[].#4）
 *
 * @param {number} [opts.thinkingLevel]     思考档位值（1/4/2；不传则不写）
 * @param {string} [opts.routingVariantId]  路由变体 ID（Lgaww.#16 Lgaxb.#2；不传则不写）
 */
export function buildLfzqy({ lgbknBytes, lgauyBytes, thinkingLevel, routingVariantId, rank, displayName } = {}) {
  const w = new Writer();
  if (lgbknBytes) w.message(1, lgbknBytes);
  if (lgauyBytes) w.message(13, lgauyBytes);
  if (rank !== undefined && rank !== null) w.varint(47, rank);
  if (thinkingLevel !== undefined && thinkingLevel !== null) w.varint(48, thinkingLevel);
  if (displayName) w.string(66, displayName);
  if (routingVariantId) w.string(67, routingVariantId);
  return w.finish();
}

/** Lgcvb { #1 Lfzqy }（Lgcvm 的子扩展 #1001 值类型） */
export function buildLgcvb(lfzqyBytes) {
  return new Writer().message(1, lfzqyBytes).finish();
}

/* ────────────────────────── 附件信封（2026-10-15 实证打通） ────────────────────────── */

/**
 * Lgbkr.#4 = 文件来源枚举（Lbcsn.a(mime) 客户端映射 + probe38 服务端实测）
 * 支持集 {0,1,5,6,7,8,9,12}；{2,3,4,10,11,…} 服务端报 "Unsupported file source."
 */
export const FileSource = Object.freeze({
  UNSPECIFIED: 0,
  IMAGE: 1,      // png/jpeg/webp/heic/heif（Lbcsn 默认分支）
  CSV: 2,        // ✗ 服务端拒绝
  GSPREADSHEET: 3, // ✗ 服务端拒绝
  AVIF: 4,       // ✗ 服务端拒绝
  EXCEL: 5,      // xlsx/xls
  VIDEO: 6,      // mp4
  PDF: 7,
  TEXT: 8,       // text/plain
  DOC: 9,        // rtf/msword
  DOCX: 10,      // ✗ 服务端拒绝
  GDOC: 11,      // ✗ 服务端拒绝
  AUDIO: 12,     // ★ 假设值（支持集中唯一未定槽位；音频链路待实证）
});

/** mime → FileSource（Lbcsn.a 反推；未命中回 IMAGE=1，与客户端默认分支一致） */
export function fileSourceOf(mime) {
  const m = String(mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return FileSource.IMAGE;
  if (m.startsWith("audio/")) return FileSource.AUDIO;   // 待实证
  if (m.startsWith("video/")) return FileSource.VIDEO;
  if (m === "application/pdf") return FileSource.PDF;
  if (m === "text/plain") return FileSource.TEXT;
  if (m === "application/rtf" || m === "application/msword" ||
      m === "text/rtf") return FileSource.DOC;
  if (m === "application/vnd.ms-excel" ||
      m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return FileSource.EXCEL;
  return FileSource.IMAGE; // Lbcsn 默认分支
}

/**
 * ★ 附件信封（probe38/39/40 + _blue-verify 实证，2026-10-15）
 *
 * 用法：
 *   const env = buildAttachmentEnvelope({ blobId, mime: "image/png", name: "a.png" });
 *   buildProcessQueryRequest({ text, mode: 1, lgcvmExts: [{ field: 1001, bytes: env }] });
 *
 * 结构（实测可用最小形态，C7）：
 *   Lgcvb{ #1 Lfzqy{ #1 Lgbkn{ #3 Lgbku{ #1 Lgbkr{#1 blobId,#3 mime,#4 src}, #2 name } } } }
 *
 * @param {object} opts
 * @param {string} opts.blobId   push.clients6 上传返回的引用（★唯一硬必需字段）
 * @param {string} [opts.mime]   默认 image/png
 * @param {string} [opts.name]   显示名（可选）
 * @param {number} [opts.source] Lgbkr.#4 枚举，默认按 mime 推断（fileSourceOf）
 * @param {boolean} [opts.full]  true = 额外带 Lgbko→Lfzms→Lfzmr 的 app 级附件镜像
 *                               （C8 实证同样通过；默认 false = 不带该段）
 *                               ⚠️ `Lfzqy.#13 Lgauy` 不受本开关控制 —— 自 2026-10-16 起
 *                               它无条件随附，缺了会导致服务端整包忽略信封（见 §5.14）
 * @param {Uint8Array} [opts.lgauyBytes] 随附的 Lgauy（默认 { #4=2 }；带档位时应传含 #16 的完整对象）
 * @param {number} [opts.thinkingLevel]  思考档位（1=Low / 4=Medium / 2=High；见 buildLfzqy）
 * @param {string} [opts.routingVariantId] 路由变体 ID（⚠️ 实测填错会让上游路由到 "Legacy" 并断流，一般留空）
 * @returns {Uint8Array} 直接作为 Lgcvm[ext1001] 的值
 */
export function buildAttachmentEnvelope(opts = {}) {
  const {
    blobId, mime = "image/png", name,
    source = fileSourceOf(mime),
    full = false, lgauyBytes,
    thinkingLevel, routingVariantId,
  } = opts;
  if (typeof blobId !== "string" || !blobId) {
    throw new Error("buildAttachmentEnvelope: blobId 是唯一硬必需字段（probe40 C6 实证）");
  }

  // Lgbkr { #1 blobId, #3 mime, #4 source }
  const lgbkrBytes = buildLgbkr({ s1: blobId, s3: mime, e4: source });
  // Lgbku { #1 Lgbkr, #2 name }
  const lgbkuBytes = buildLgbku({ kr: lgbkrBytes, s2: name });

  // Lgbkn { #3 Lgbku[] }（+ 可选 #5 Lgbko→Lfzms→Lfzmr{#4 Lgbku}）
  const lgbknBytes = buildLgbkn({
    gbkuList: [lgbkuBytes],
    fzmsBytes: full ? buildLfzmsFromFzmr(buildLfzmr({ gbkuBytes: lgbkuBytes })) : undefined,
  });
  // Lfzqy { #1 Lgbkn, #13 Lgauy, #48 思考档位 }
  // ★ 2026-10-17：`#13 Lgauy` 保持【无条件随附】（上游若缺它会冷落整个信封）。
  //   注意 `#13` **不是** 档位的有效承载位 —— `#16` 放这里会被整包忽略（静默降级）。
  //   档位归属由调用方决定（见 buildProcessQueryRequest 的 lgauyForField13）。
  //   `full` 仍只控制 Lgbko→Lfzms→Lfzmr 那一段（实测 `full=true` 会让模型答非所问，勿开）。
  const lfzqyBytes = buildLfzqy({
    lgbknBytes,
    lgauyBytes: lgauyBytes ?? new Writer().varint(4, ClientType.ANDROID).finish(),
    thinkingLevel, routingVariantId,
  });
  return buildLgcvb(lfzqyBytes);
}

/**
 * ★ 组装 ProcessQuery 的 **initial 帧**（= Lgcvp 字节，直接作为第一帧发送）
 *
 * 实测通过的最小形态（probe7 R0）：
 *   Lgcvp[ext1000] Lgcvm{ #1 Lgauy{ #25 text, #4 ClientType=2 }, #2 Lgcww{ #1 text } }
 *
 * opts: {
 *   text,                     // 用户文本（→ Lgcww.#1 与 Lgauy.#25）
 *   clientType,               // Lgauy.#4（默认 ClientType.ANDROID = 2）
 *   blobId,                   // 已上传文件的 blobId（→ Lgcvd.#1，mode 自动置 2）
 *   mode,                     // Lgcvm.#8（不传则不写）
 *   queryType,                // Lgcvm.#4 Lgatn{ #1: 枚举 }（不传则不写）
 *   attachments,              // [{ blobId, mime, name, source, full }] 附件引用列表
 *                               （blobId = push.clients6 上传返回值；★probe40 实证路径）
 *   lgauy,                    // Lgauy 额外选项（见 buildLgauy）
 *   thinkingLevel,            // ★ 思考档位（1=Low / 4=Medium / 2=High）；不传 = 服务端默认 Low
 *   routingVariantId,         // 路由变体 ID（实测填错 → 上游 "Used Legacy model" 断流，留空）
 *   envelope,                 // 是否带 Lgcvb 信封（默认：有附件或带档位时 true）
 *   extOverrides,             // [{field, bytes}] 附加扩展（联调用）
 * }
 * @returns {Uint8Array} Lgcvp 字节（首帧）
 */
export function buildProcessQueryRequest(opts = {}) {
  const lgauyOpts = {
    text: opts.text,
    enum4: opts.clientType,
    ...(opts.lgauy ?? {}),
  };
  const lgauyBytes = buildLgauy(lgauyOpts);

  // 附件 → ext1001 信封（★2026-10-15 实证路径：blobId 引用，不发原始字节）
  const atts = (opts.attachments ?? []).filter((a) => a?.blobId); // 无 blobId 的旧式 raw 附件已废弃（服务端不读 #10 字节）
  const thinkingLevel = opts.thinkingLevel ?? null;
  const wantEnvelope = opts.envelope ?? (atts.length > 0 || thinkingLevel !== null);

  // ★★★ 档位承载位（2026-10-17 实测修正，推翻 §5.14 的旧结论）
  //   判据只看 `Lfzrc.#30`（上游自述模型名）+ `#41`(rank) + `#25`(实际生效档位 id)。
  //
  //   ① `#16` 放 `Lfzqy.#13 Lgauy` ⇒ 服务端**整包忽略该 Lgauy**，档位回落账号默认
  //      （实测恒为 3.5 Flash-Lite，rank 6，`#25` 缺席）—— 这就是"满血 Argon 静默变笨"
  //      的真凶，与"上游临时限制"无关。反证：`#16` 移回 `Lgcvm.#1` 后立刻
  //      `#30="Used 4 Argon High model"`、`#41=8`、`#25=95a4c0abcba24364`。
  //   ② ⚠️ **唯一例外——音频**：携带音频附件时，Argon 路径**读不到音频**
  //      （模型答"没有收到录音文件"），而 Flash-Lite 路径能正常听写。
  //      两者互斥且无兼容形态（已穷举 `Lgcvd`/`full`/`#13` 缺省/双承载等 12 种变体）。
  //      ⇒ 音频场景必须把 `#16` 退到 `#13` 换"能听到"，代价是本次降级。
  //      **图片不受此限**：`#16` 在 `#1` 时图片照常被采纳（实测答出颜色）。
  //   ③ 由此得到的分工是当前能拿到的最优解：
  //      无音频（纯文本 / 图片）⇒ 满血 Argon；含音频 ⇒ 自动走 Flash-Lite 换听觉。
  const hasAudioAttachment = atts.some((a) =>
    String(a.mime ?? "").toLowerCase().trim().startsWith("audio/")
  );
  const lgauyForField1 = hasAudioAttachment
    ? buildLgauy({ ...lgauyOpts, s16: undefined })   // 音频退让：档位让位给听觉能力
    : lgauyBytes;                                     // 默认：档位随 #1（唯一生效位）
  const lgauyForField13 = hasAudioAttachment
    ? lgauyBytes
    : buildLgauy({ ...lgauyOpts, s16: undefined });

  // Lgcvm
  const lgcvm = new Writer();
  lgcvm.message(1, lgauyForField1); // #1 Lgauy
  if (opts.text !== undefined) lgcvm.message(2, buildLgcww(opts.text)); // #2 Lgcww
  if (opts.queryType !== undefined) {
    // #4 Lgatn { #1 ENUM }（Lgatm：19=DEEPLINK 20=FLOATY_TEXT_INPUT 21=FULL_SCREEN_TEXT_INPUT）
    lgcvm.message(4, new Writer().varint(1, opts.queryType).finish());
  }
  if (opts.blobId !== undefined) lgcvm.message(6, buildLgcvd(opts.blobId)); // #6 Lgcvd
  const mode = opts.mode ?? (opts.blobId !== undefined ? 2 : undefined);
  if (mode !== undefined) lgcvm.varint(8, mode); // #8 mode

  // ★ 信封（Lgcvb[ext1001]）—— 承载【附件】、档位与【思考强度】
  //   · 无附件 + 无档位：不发信封（与 probe7 R0 最小形态逐字节一致）
  //   · 单附件（无档位）：2026-10-15 实证路径 + 随附 #13 Lgauy
  //   · 其它（带档位 / 多附件）：统一构造一个 Lfzqy，附件与 #48 共存
  if (wantEnvelope) {
    const rv = opts.routingVariantId;
    if (atts.length === 0) {
      // 纯档位信封：Lgcvb{ Lfzqy{ #13 Lgauy, #48 } }
      lgcvm.message(1001, buildLgcvb(buildLfzqy({ lgauyBytes: lgauyForField13, thinkingLevel, routingVariantId: rv })));
    } else if (atts.length === 1) {
      lgcvm.message(1001, buildAttachmentEnvelope({ ...atts[0], lgauyBytes: lgauyForField13, thinkingLevel, routingVariantId: rv })); // [ext1001] Lgcvb
    } else {
      const kuList = [];
      for (const a of atts) {
        const src = a.source ?? fileSourceOf(a.mime);
        kuList.push(buildLgbku({
          kr: buildLgbkr({ s1: a.blobId, s3: a.mime ?? "image/png", e4: src }),
          s2: a.name,
        }));
      }
      lgcvm.message(1001, buildLgcvb(buildLfzqy({
        lgbknBytes: buildLgbkn({ gbkuList: kuList }),
        lgauyBytes: lgauyForField13,
        thinkingLevel, routingVariantId: rv,
      })));
    }
  }

  // ★ 联调用：Lgcvm 层的扩展注入（feature 声明扫描等）
  for (const { field, bytes } of opts.lgcvmExts ?? []) {
    lgcvm.message(field, bytes instanceof Uint8Array ? bytes : new Uint8Array(0));
  }
  // 联调用：Lgcvm 层普通 int 字段注入（#8/#9 等）
  for (const { field, value } of opts.lgcvmVars ?? []) lgcvm.varint(field, value);

  // ★ Lgcvp { [ext1000] Lgcvm } —— 直接就是请求消息，不包 Lgcxj
  const lgcvp = new Writer();
  lgcvp.message(1000, lgcvm.finish());
  for (const { field, bytes } of opts.extOverrides ?? []) lgcvp.message(field, bytes);
  return lgcvp.finish();
}

/* ────────────────────────── 后续帧（prefetch / commit） ────────────────────────── */

/**
 * ★ prefetch 帧：Lgcvp[ext1007] Lgcvl{ #1: 查询文本 }
 * 实证：Lansi.j("Send ProcessQuery prefetch"/"PREFETCH_SENT")
 *        + Lgcxb.q 字节码（Lgcvl.c=1, Lgcvl.d=String）
 * 查询文本真正落在这一帧；initial 里的文本只是上下文。
 */
export function buildPrefetchFrame(text) {
  const lgcvl = new Writer().string(1, text).finish();
  return new Writer().message(1007, lgcvl).finish();
}

/**
 * ★ commit 帧（probe23/25 实证，2026-10-15）：
 *   Lgcvp[ext1007] Lgcvl{ #2: godw(空) }
 *
 *   字节码依据：Lansi.f [312] `if-nez L, +77` —— 只有文本模式（Lansi.L==null）
 *   才发这一帧；Lgcuz 两帧由 [470] `if-eqz ar, +148` 的 Lansi.ar 门控，
 *   属语音模式（s3Connection + manual endpointing）专属。
 *   ⚠️ 文本模式发 Lgcuz 会触发 `CommitControlFeature is missing`（probe23 T4/T5/T6 实证）。
 */
export function buildCommitFrames(opts = {}) {
  const EMPTY = new Uint8Array(0);
  const frames = [
    new Writer().message(1007, new Writer().bytes(2, EMPTY).finish()).finish(),
  ];
  if (opts.audio === true) {
    // 语音模式追加的两帧（文本模式禁止，见上）
    frames.push(new Writer().message(1010, new Writer().bytes(2, EMPTY).finish()).finish());
    frames.push(new Writer().message(1010, new Writer().bytes(3, EMPTY).finish()).finish());
  }
  return frames;
}

/* ────────────────────────── 会话管理（unary RPC） ────────────────────────── */

/**
 * ★ DeleteConversation 请求 —— Lgaaz { #1 string conversationId, #2 Lgauy }
 *
 * 反推依据（tools/protoreach.py --root "^Lgaaz;$"，2026-10-16）：
 *   RPC 目录 out/robin/rpc-msg-map.txt → `F DeleteConversation req=Lgaaz; resp=Lgaba;`
 *   消息图：Lgaaz #1 STRING / #2 MESSAGE →Lgauy（与 ProcessQuery 同款客户端上下文）
 *
 * 用途：Robin 服务端按【账号】维持 active 会话 —— 不指定会话 ID 时，请求会落进
 *   同一个持续累积的会话（实测：不带历史直接问上轮暗号，模型仍能答出）。
 *   删掉本次请求产生的会话 = 下次请求开启全新会话 → 跨请求/跨用户串扰的根治手段。
 *
 * @param {string} conversationId 形如 "c_e495ac0c4f798273"（来自响应 Lfzrc.#2.Lgavc.#1）
 * @param {object} [opts] { clientType } 透传给 buildLgauy
 */
export function buildDeleteConversationRequest(conversationId, opts = {}) {
  if (!conversationId) throw new Error("buildDeleteConversationRequest: conversationId 必填");
  const lgauy = buildLgauy({ enum4: opts.clientType ?? ClientType.ANDROID });
  return new Writer().string(1, conversationId).message(2, lgauy).finish();
}

/* ────────────────────────── GetUserStatus（模式配置发现） ────────────────────────── */

/**
 * Lgahv（GetUserStatus 请求，RPC 槽位 "aI"）
 *
 * 字段表（tools/fieldmap.py --class "^Lgahv;$"）：
 *   #1 MESSAGE c → Lgauy    ★ 主载荷（与 ProcessQuery 同构，直接复用 buildLgauy）
 *   #2 INT32_LIST_PACKED d
 *   #3 MESSAGE e → Lgbkz
 *   #4 BOOL  f
 *   #5 ENUM  g
 *   #6 STRING h
 *
 * 证据（2026-10-16）：Lalqh.C(Lgaic;Lhcuk;) 是模式配置的唯一入口，
 * 而 Lgaic = GetUserStatus 响应；其中 #17 → Lgavr[]（模式配置）、#18 → Lgahy[]（白名单）。
 */
export function buildGetUserStatusRequest(opts = {}) {
  const lgauyBytes = buildLgauy({
    enum4: opts.clientType ?? ClientType.ANDROID,
    ...(opts.lgauy ?? {}),
  });
  const w = new Writer().message(1, lgauyBytes);
  if (opts.s6 !== undefined) w.string(6, opts.s6);
  return w.finish();
}

/**
 * 解析 Lgaic（GetUserStatus 响应）里与「模型档位」相关的部分。
 *
 * 字段表（tools/fieldmap.py --class "^Lgaic;$"，28 字段）：
 *   #17 MESSAGE_LIST → Lgavr    ★ 模式配置列表
 *   #18 MESSAGE_LIST → Lgahy    ★ 可用模式白名单（allowlist）
 *
 * Lgavr（22 字段）关键位：
 *   #1 STRING c  ★ 模式 ID（BardModeId 的字符串来源，Laotd.a ← 此处）
 *   #2 STRING e     同族说明串
 *   #3 STRING f     同族说明串
 *   #4 ENUM   d     分类/图标枚举
 *   #22 STRING r / #23 INT32 s / #26 STRING u    其余元数据
 *
 * Lgahy（3 字段）：
 *   #1 STRING_LIST b  ★ 允许的 mode id 列表
 *   #2 BOOL c
 *   #3 MESSAGE d → Lgahx { #1 STRING b, #2 STRING c }
 */
export function parseUserStatus(lgaicBytes) {
  const out = { modes: [], allowlists: [] };
  for (const f of decodeFields(lgaicBytes)) {
    if (f.no === 17) {
      const m = parseModeConfig(f.value);
      if (m) out.modes.push(m);
    } else if (f.no === 18) {
      const ids = [];
      for (const s of fieldAll(f.value, 1)) if (s.wt === 2) ids.push(asString(s.value));
      const flag = fieldOne(f.value, 2);
      const note = fieldOne(f.value, 3);
      let notePair = null;
      if (note && note.wt === 2) {
        const a = fieldOne(note.value, 1);
        const b = fieldOne(note.value, 2);
        notePair = {
          a: a && a.wt === 2 ? asString(a.value) : null,
          b: b && b.wt === 2 ? asString(b.value) : null,
        };
      }
      out.allowlists.push({
        ids,
        flag: flag ? Boolean(asUint(flag.value)) : null,
        note: notePair,
      });
    }
  }
  return out;
}

/** 单个 Lgavr（模式配置）→ 可读对象 */
function parseModeConfig(buf) {
  const g = (no) => {
    const f = fieldOne(buf, no);
    return f && f.wt === 2 ? asString(f.value) : null;
  };
  const n = (no) => {
    const f = fieldOne(buf, no);
    return f && f.wt === 0 ? asUint(f.value) : null;
  };
  const id = g(1);
  if (!id) return null;
  return {
    id,                       // ★ mode id（写入 Lgauy.#16 的候选值）
    s2: g(2),
    s3: g(3),
    enum4: n(4),              // 分类枚举
    s16: g(16),
    s18: g(18),
    s19: g(19),
    s20: g(20),
    s22: g(22),
    int23: n(23),
    s26: g(26),
    bool8: n(8),
    bool21: n(21),
  };
}

/** RobinService 的服务前缀（robinPath 形如 "/assistant.mobile.robin.RobinService/ProcessQuery"） */
export function robinServicePrefix(path = "") {
  const i = String(path).lastIndexOf("/");
  return i > 0 ? String(path).slice(0, i + 1) : path;
}

/**
 * ★ 组装一次完整文本查询的发送剧本（含建议间隔）
 * @returns {Array<{bytes: Uint8Array, label: string, delayMs: number}>}
 */
export function buildTextQueryScript(text, opts = {}) {
  const frames = [
    { bytes: buildProcessQueryRequest({ text, ...opts }), label: "initial", delayMs: opts.initialDelayMs ?? 900 },
  ];
  if (opts.skipPrefetch !== true) {
    frames.push({ bytes: buildPrefetchFrame(text), label: "prefetch", delayMs: opts.prefetchDelayMs ?? 500 });
  }
  const commit = buildCommitFrames();
  commit.forEach((bytes, i) => frames.push({ bytes, label: `commit${i + 1}`, delayMs: i === commit.length - 1 ? 0 : 150 }));
  return frames;
}

/* ────────────────────────── 响应解析 ────────────────────────── */

/** 响应可能是 gzip（响应头 grpc-encoding: gzip，帧压缩位=1）。Node 内置 zlib 解压。 */
export function maybeGunzip(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return new Uint8Array(gunzipSync(Buffer.from(buf)));
    } catch {
      return buf;
    }
  }
  return buf;
}

/** 响应扩展号 → 语义名（tools/fieldmap.py + extension-map 实测） */
export const RESP_EXT = Object.freeze({
  1000: "Lgcvo", 1002: "Lgcwm", 1003: "Lgcvc",
  1004: "Lgcwv", 1008: "Lgcwv", 1012: "Lgcxe", 1014: "Lgcve",
});

/**
 * 从 Lgcvq（ProcessQueryResponse，gzip 已解）提取文本与 RobinOp 原始字节。
 *
 * 结构（2026-10-15 probe24/25 实证修订）：
 *   Lgcvq[ext1000] Lgcvo{ #1 Lgavd{ #1: int32[] } }   ← initial 的能力表 ACK
 *   Lgcvq[ext1003] Lgcvc{ #1 Lfzrc }                  ← 主响应容器
 *       Lfzrc{ #1 Lgapu[], #2 Lgavc{会话/响应id}, #4 标题, #30 模型名 }
 *           Lgapu{ #2 Lgace{#1 增量文本}, #7 累积文本, #20 语言 }
 *   （其余扩展 Lgcwm/Lgcwv/Lgcxe/Lgcve 逐个留档到 byExt）
 */
export function extractResponse(lgcvqBytes) {
  const out = { texts: [], ops: [], hasExt: {}, byExt: {}, ackCapabilities: null,
    cumulative: null, language: null, conversationId: null, responseId: null, title: null, model: null,
    rank: null, thinking: null, effectiveMode: null,
    // ★ 流结束标记（2026-10-20 实证）：上游在**最后一帧**发
    //   Lgcvq[ext1003] Lgcvc{ #2 = <空 godw> }（oneof 落在 case2）
    //   ⇒ 这是「答完了」的**确定性**信号，不再需要靠 idle 静默超时收尾。
    //   实测帧序（健康响应，8/8 一致）：
    //     ext1000(ACK) → ext1003(空 3B) → ext1014(会话id)×2 → ext1003(正文)×N
    //     → ext1003{Lgcvc.#2 空} (EOS)
    //   ⚠️ 与「开始帧」区分：3 字节的 ext1003{}（oneof 未设）是开始标记，不是 EOS。
    eos: false,
    // ★★ 「正文已完整」标记（2026-10-20 实证，141 个响应 810 帧）
    //   Lgapu.#19：1 = 分片进行中，**2 = 该分片已完成**。
    //   · 首个 #19=2 的帧**即含全部文本**（139/141），其后 0 例再增长
    //     ⇒ 见到它就可以**确定性收尾**，不必再靠静默超时猜「答完了没」。
    //   · 实测每帧**恒为单分片**（810/810）⇒ 「该帧所有分片都 #19=2」即全文完成。
    //   ⚠️ 若将来出现多分片，本字段只在「同一帧内全部 #19=2」时才置位。
    complete: false,
    // ★ 本帧是否带**内容容器**（Lgcvc.#1 = Lfzrc）——区分
    //   「收到了正文容器却解不出文本（我方解析问题）」与
    //   「只收到握手帧 / 空 oneof 帧，上游根本没出正文（上游拒答或本地超时）」。
    //   ⚠️ 不能用 extCounts 里有没有 "1003" 判断：3 字节的空 ext1003{}（开始帧）
    //   与 EOS 帧也计在 1003 上，但它们都不含内容。
    lfzrcSeen: false };
  for (const f of decodeFields(lgcvqBytes)) {
    out.hasExt[f.no] = (out.hasExt[f.no] ?? 0) + 1;
    out.byExt[f.no] ??= [];
    out.byExt[f.no].push(f.value);

    if (f.no === 1000) {
      // Lgcvo { #1 Lgavd { #1 packed int32[] } } —— initial 的 ACK（能力表）
      const gavd = fieldOne(f.value, 1);
      if (gavd) {
        const listField = fieldOne(gavd.value, 1);
        if (listField && listField.wt === 2) {
          // 手工解 packed varint
          const vals = [];
          let p = 0;
          const b = listField.value;
          while (p < b.length) {
            let v = 0n, s = 0n;
            while (p < b.length) {
              const byte = b[p++];
              v |= BigInt(byte & 0x7f) << s;
              if (!(byte & 0x80)) break;
              s += 7n;
            }
            vals.push(Number(v));
          }
          out.ackCapabilities = vals;
        }
      }
      continue;
    }

    if (f.no === 1003) {
      // Lgcvc { oneof: #1 Lfzrc | #2 godw(空) }
      const lfzrcF = fieldOne(f.value, 1);
      if (!lfzrcF) {
        // ★ oneof 落在 case2（#2 = 空 godw）⇒ 上游的**流结束标记**（见函数头注释）。
        //   注意区分：3 字节的 ext1003{}（一个字段都没有）是「开始帧」，不是结束帧。
        const godw = fieldOne(f.value, 2);
        if (godw) out.eos = true;
        continue; // case2 = 空控制帧
      }
      const lfzrc = lfzrcF.value;
      out.lfzrcSeen = true;
      // ★ 2026-10-15 probe24/25 实证结构：
      //   Lfzrc {
      //     #1[] Lgapu {                       ← 候选分片（repeated）
      //       #1 STRING  = 'rc_…'              ← 分片 id（不是文本！）
      //       #2 Lgace { #1 STRING }           ← ★ 累积文本（每帧递增，末帧即全文）
      //       #7 STRING                       ← 末帧快照（与 #2 末帧一致）
      //       #19 varint = 1→2                ← 分片状态（2 = 完成）
      //       #20 STRING = 'en'               ← 语言
      //     }
      //     #2 Lgavc { #1 STRING 会话id 'c_…', #2 STRING 响应id 'r_…' }
      //     #4 { #1 STRING 标题 }
      //     #30 STRING = 'Used 3.5 Flash-Lite model'
      //     #41 varint, #42 varint, #45 varint
      //   }
      let allShardsDone = true;
      let shardCount = 0;
      for (const gapu of fieldAll(lfzrc, 1)) {
        shardCount++;
        const gace = fieldOne(gapu.value, 2);           // Lgace
        if (gace && gace.wt === 2) {
          const t = fieldOne(gace.value, 1);
          if (t && t.wt === 2) out.texts.push(asString(t.value));   // delta
        }
        const cum = fieldOne(gapu.value, 7);            // 累积
        if (cum && cum.wt === 2 && cum.value.length) out.cumulative = asString(cum.value);
        const lang = fieldOne(gapu.value, 20);
        if (lang && lang.wt === 2) out.language = asString(lang.value);
        // ★ 分片状态：#19 == 2 ⇒ 该分片已完成（见函数头 complete 注释）
        const v19 = fieldOne(gapu.value, 19);
        if (!(v19 && v19.wt === 0 && Number(asUint(v19.value)) === 2)) allShardsDone = false;
      }
      // 只有「本帧**有分片**且全部 #19=2」才判定正文完整
      //   ⚠️ 帧里一个 Lgapu 都没有时不得判定完成（否则会提前收尾）。
      if (shardCount > 0 && allShardsDone) out.complete = true;
      const gavc = fieldOne(lfzrc, 2);                  // Lgavc{会话/响应 id}
      if (gavc && gavc.wt === 2) {
        const cid = fieldOne(gavc.value, 1);
        const rid = fieldOne(gavc.value, 2);
        if (cid && cid.wt === 2) out.conversationId = asString(cid.value);
        if (rid && rid.wt === 2) out.responseId = asString(rid.value);
      }
      const title = fieldOne(lfzrc, 4);                 // 标题包装
      if (title && title.wt === 2) {
        const t = fieldOne(title.value, 1);
        if (t && t.wt === 2) out.title = asString(t.value);
      }
      const model = fieldOne(lfzrc, 30);                // 模型名
      if (model && model.wt === 2) out.model = asString(model.value);
      // ★ 档位/思考强度的**服务端判定面**（2026-10-16 实证，见 modes.js 章节）：
      //   #41 = rank（服务端实际档位的等级；3.5 Flash-Lite = 6，Argon = 8）
      //   #42 = 思考强度回显（逐字等于请求的 #48；这是"思考参数有没有被吞"的唯一判据）
      //   #25 = 服务端**实际生效**的档位 id（不是请求回显 —— 请求发 Argon 而这里回
      //         flash-lite 的 id，就是静默降级的铁证）
      const rank = fieldOne(lfzrc, 41);
      if (rank && rank.wt === 0) out.rank = Number(asUint(rank.value));
      const think = fieldOne(lfzrc, 42);
      if (think && think.wt === 0) out.thinking = Number(asUint(think.value));
      const effMode = fieldOne(lfzrc, 25);
      if (effMode && effMode.wt === 2) out.effectiveMode = asString(effMode.value);
      for (const op of fieldAll(lfzrc, 7)) out.ops.push(op.value);
    }
  }
  return out;
}
