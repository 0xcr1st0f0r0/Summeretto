// service/lib/tos.js —— Robin 通道的 ToS（Terms of Service）读写
//
// ┌─ 为什么需要这个模块 ────────────────────────────────────────────────────────┐
// │ 协议层已 100% 打通（见 docs/stage2-robin-protocol.md §5.7），ProcessQuery  │
// │ 三步式被服务端完整接受，但最终返回：                                       │
// │   grpc-status=9                                                           │
// │   BardStatusException: Before proceeding, please accept our terms of service. │
// │ 这是**账号级**门禁（已实测：ClientType 1/2/3/4 全部同样报错，与客户端无关）。│
// │ 服务端指明待接受版本 = 9，对应文档 = Gemini 应用隐私信息中心                │
// │   https://support.google.com/gemini?p=awb_phh                             │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ⚠️ 法律提示：`AcceptTermsOfService` 是以**用户本人名义**同意一份法律协议。
//    本模块只负责「构造请求 / 解析响应」，**绝不自动调用** accept RPC。
//    必须由账号持有人明确授权后，由调用方（脚本 / 人工）显式触发。
//
// ── 字段表（全部由 tools/fieldmap.py 实测 + 反汇编交叉验证）──────────────────
//  Lgahq  (GetTermsOfServiceVersion 请求)  #1 STRING(语系/locale)  #2 gauy
//  Lgahr  (响应)                           #1 INT32  #2 INT32(tosVersionNo)
//                                          #3 Lgbip  #4 Lgavd(能力表)  #5 Lgcxm
//  Lgbip  (APK 17.66.12)                   #1 STRING  #4 STRING
//         ⚠️ 服务端实际下发            #1 = 空格哨兵(" ") → 表示「有待接受项」
//                                          #5 STRING = 条款文档 URL
//  Lfzky  (AcceptTermsOfService 请求)      #4 STRING(UA)  #5 ENUM(平台)  #6 oneof<int32>(版本号)
//                                          #7 gauy  #8 BOOL  #10 gogy  #11 BOOL  #12 gbiz
//  Lfzkz  (响应)                           #1 gavd
//  Lgbiz                                   #1 ENUM  #2 ENUM_LIST_PACKED  #3 ENUM
//
//  ★ 关键旁证（反汇编）：
//    Latqm.h("Ma-RobinOnboarding") → Latwf(Latwj, tosVersionNo, Boolean, cont)
//      → Latwc.e(int 版本号, …) 构造 Lfzky（本模块 buildAcceptTosRequest 的蓝本）
//      → Latfi.a(Lfzky) 以 RPC 名 "acceptTermsOfService" 发送
//    Latwc.e 中 Lfzky.#4 ← Lbzva.a() = 完整 User-Agent
//               Lfzky.#5 ← Lfzwy.AGSA.getNumber() = 1
//               Lfzky.#6 ← 版本号（oneof case 6）
//               Lfzky.#7 ← gauy
//               Lfzky.#12 ← Lgbiz{ #1=1, #2=[PARENT(1), CHILD(2)], #3=1 }

import { Writer, decodeFields, asInt32, asString, decodePackedVarint } from "./wire.js";

/* ─────────────────────────── RPC 路径 ─────────────────────────── */

export const TOS_RPC = Object.freeze({
  GET_VERSION: "/assistant.mobile.robin.RobinService/GetTermsOfServiceVersion",
  ACCEPT: "/assistant.mobile.robin.RobinService/AcceptTermsOfService",
});

/** 待接受条款文档（服务端随响应下发，此处为实测值，作兜底展示用） */
export const TOS_DOC_URL = "https://support.google.com/gemini?p=awb_phh";

/* ─────────────────────── 枚举（实测数值） ─────────────────────── */

/** `Lfzwy` —— 客户端平台/形态。★ Lfzky.#5 取 AGSA */
export const TosSurface = Object.freeze({
  UNSPECIFIED: 0,
  AGSA: 1,
  IOPA: 2,
  IGA: 3,
  IGEM: 4,
  WEAR: 5,
  ANDROID_AUTO: 6,
  CHROME: 7,
  ANDROID_XR_GLASSES: 8,
  ANDROID_GMM: 9,
  ANDROID_XR_HEADSET: 10,
  IOS_GMM: 11,
  ANDROID_AUTO_EMBEDDED: 12,
});

/** `Lgbiy` —— 数据受众。Lgbiz.#2 取 [PARENT, CHILD] */
export const TosAudience = Object.freeze({
  AUDIENCE_UNSPECIFIED: 0,
  PARENT: 1,
  CHILD: 2,
});

/** 空载 gauy 的默认 ClientType（与 pq.js 保持一致；AGSA = Google App 用 ANDROID） */
const DEFAULT_CLIENT_TYPE = 2;

/* ─────────────────────────── 请求构造 ─────────────────────────── */

/**
 * 构造 `Lgahq` —— GetTermsOfServiceVersion 请求。
 * @param {object}  [o]
 * @param {string}  [o.locale]       Lgahq.#1，语系（如 "zh-CN"）；实测留空也可用
 * @param {number}  [o.clientType]   Lgahq.#2 内 gauy.#4
 * @param {string}  [o.text]         Lgahq.#2 内 gauy.#25（探针用占位文本）
 */
export function buildGetTosRequest({ locale, clientType = DEFAULT_CLIENT_TYPE, text = "hi" } = {}) {
  const gauy = new Writer().varint(4, clientType).string(25, text).finish();
  const w = new Writer();
  if (locale !== undefined) w.string(1, locale);
  w.message(2, gauy);
  return w.finish();
}

/**
 * 构造 `Lfzky` —— AcceptTermsOfService 请求。
 *
 * 复刻 `Latwc.e` 的写入顺序（字段按号升序，wire 上顺序无实质影响，但保持一致便于比对）：
 *   #4 STRING(UA)  #5 ENUM(surface)  #6 oneof<int32>(version)  #7 gauy
 *   #11 BOOL       #12 gbiz{ #1=1, #2=[1,2], #3=1 }
 *
 * 未写入的字段（#8 BOOL / #10 gogy / #15 INT32 / #16 STRING）在真机流程中来自
 * onboarding 上下文，服务端对可选字段通常容忍缺省；若被拒再逐项补齐。
 *
 * @param {object} o
 * @param {number} o.version               待接受版本号（来自 Lgahr.#2，实测 = 9）
 * @param {string} [o.userAgent]           完整 UA 串（建议用 `gsaUserAgent()` 生成）
 * @param {Uint8Array} [o.gauyBytes]       Lgauy 载荷；缺省用最小 gauy
 * @param {number} [o.surface]             Lfzky.#5，默认 AGSA(1)
 * @param {boolean} [o.bool11]             Lfzky.#11，真机取自 flow 参数；缺省不写
 * @param {boolean} [o.includeGbiz=true]   是否写 Lfzky.#12
 */
export function buildAcceptTosRequest({
  version,
  userAgent,
  gauyBytes,
  surface = TosSurface.AGSA,
  bool11,
  includeGbiz = true,
} = {}) {
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`buildAcceptTosRequest: version 必须为正整数，收到 ${version}`);
  }

  const gauy = gauyBytes ?? new Writer().varint(4, DEFAULT_CLIENT_TYPE).string(25, "").finish();

  const w = new Writer();
  if (userAgent) w.string(4, userAgent);
  w.varint(5, surface);
  w.varint(6, version); // oneof case 6
  w.message(7, gauy);
  if (bool11 !== undefined) w.bool(11, bool11);
  if (includeGbiz) w.message(12, buildLgbiz());
  return w.finish();
}

/** `Lgbiz` —— 数据受众声明。实测 Latwc.e 写： #1=1, #2=[PARENT, CHILD], #3=1 */
export function buildLgbiz({
  e1 = 1,
  audiences = [TosAudience.PARENT, TosAudience.CHILD],
  e3 = 1,
} = {}) {
  const w = new Writer();
  w.varint(1, e1);
  w.packedVarint(2, audiences);
  w.varint(3, e3);
  return w.finish();
}

/**
 * 复刻 `Lbzva.a()` 生成的 GSA User-Agent。
 * 真机串：`Mozilla/5.0 (Linux; Android {RELEASE}; Build/{ID}) AppleWebKit/537.36
 *          (KHTML, like Gecko) Version/4.0 Chrome/{chromeVer} Mobile Safari/537.36 GSA/{gsaVer}`
 */
export function gsaUserAgent({
  release = "14",
  buildId = "UP1A.231005.007",
  chromeVersion = "122.0.6261.119",
  gsaVersion = "17.66.12.32.arm64",
} = {}) {
  return (
    `Mozilla/5.0 (Linux; Android ${release}; Build/${buildId}) ` +
    `AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${chromeVersion} ` +
    `Mobile Safari/537.36 GSA/${gsaVersion}`
  );
}

/* ─────────────────────────── 响应解析 ─────────────────────────── */

/**
 * 解析 `Lgahr` —— GetTermsOfServiceVersion 响应。
 *
 * 实测样本（hex 逐字节确认）：
 *   0809        #1 = 9
 *   1009        #2 = 9                      ← tosVersionNo
 *   1a30        #3 = Lgbip(48B)
 *     0a0120       #1 = " "（单空格哨兵 → 「有待接受项」）
 *     2a2b...      #5 = "https://support.google.com/gemini?p=awb_phh"
 *   22d307      #4 = Lgavd(979B)  244 项 packed int32 能力表
 *
 * 应用侧判定逻辑（反汇编 `Latjy.invokeSuspend` 实证）：
 *   需 `#2 > 0`；随后 `Lgbip.#1` 非空 → 判定 `"Terms of service available."` → 走 accept 流程。
 *
 * @returns {{tosVersionNo:number, pending:boolean, docUrl:string|null,
 *            flag1:number|null, capabilityIds:number[], raw:{hasResp:boolean}}}
 */
export function parseTosResponse(buf) {
  const fields = decodeFields(buf);
  const out = {
    flag1: null,
    tosVersionNo: 0,
    pending: false,
    docUrl: null,
    capabilityIds: [],
    raw: { hasResp: fields.length > 0 },
  };

  for (const f of fields) {
    if (f.no === 1 && f.wt === 0) out.flag1 = asInt32(f.value);
    else if (f.no === 2 && f.wt === 0) out.tosVersionNo = asInt32(f.value);
    else if (f.no === 3 && f.wt === 2) {
      // Lgbip：APK 映射 {#1,#4}，服务端实际下发 {#1 哨兵, #5 URL}
      for (const g of decodeFields(f.value)) {
        if (g.wt !== 2) continue;
        const s = asString(g.value);
        if (g.no === 1 || g.no === 4) {
          if (s.length > 0 && s.trim().length === 0) out.pending = true; // 纯空白哨兵
          else if (s.length > 0 && /^https?:\/\//.test(s)) out.docUrl = s;
          else if (s.length > 0) out.pending = true;
        } else if (g.no === 5) {
          if (/^https?:\/\//.test(s)) out.docUrl = s;
          else if (s.length > 0) out.pending = true;
        }
      }
    } else if (f.no === 4 && f.wt === 2) {
      // Lgavd { #1 INT32_LIST_PACKED }
      for (const g of decodeFields(f.value)) {
        if (g.no === 1) out.capabilityIds = decodePackedVarint(g.value).map(Number);
      }
    }
  }
  return out;
}

/**
 * 解析 `Lfzkz` —— AcceptTermsOfService 响应。形如 `#1 = Lgavd{ #1: [packed int32] }`
 * @returns {{accepted:boolean, capabilityIds:number[], fields:number}}
 */
export function parseAcceptResponse(buf) {
  const ids = [];
  let n = 0;
  for (const f of decodeFields(buf)) {
    n++;
    if (f.no === 1 && f.wt === 2) {
      for (const g of decodeFields(f.value)) {
        if (g.no === 1) ids.push(...decodePackedVarint(g.value).map(Number));
      }
    }
  }
  return { accepted: n > 0, capabilityIds: ids, fields: n };
}

/** 把 ToS 状态整理成一句人话（给 CLI / 日志用） */
export function describeTos(state) {
  if (!state.raw.hasResp) return "响应为空 —— 无 ToS 信息";
  if (state.tosVersionNo <= 0) return "服务端未给出 ToS 版本（可能通道/鉴权异常）";
  if (!state.pending) return `ToS 已满足（版本 ${state.tosVersionNo}）`;
  return (
    `⚠️ 账号尚未接受 ToS 版本 ${state.tosVersionNo}` +
    `（文档：${state.docUrl ?? TOS_DOC_URL}）`
  );
}

/* ─────────────────── 上游原始错误 → 可执行诊断 ─────────────────── */

/**
 * 把 Robin 上游的 `grpc-message` 翻译成带补救指引的结构化诊断。
 * 让 API 调用方一眼看懂「是自己参数错了、还是账号没开通」。
 * @returns {{code:string, hint:string, docUrl?:string}|null} 无法归类时返回 null
 */
export function explainUpstreamError(message) {
  if (!message) return null;
  const m = String(message);

  if (/accept our terms of service/i.test(m)) {
    return {
      code: "TERMS_OF_SERVICE_NOT_ACCEPTED",
      docUrl: TOS_DOC_URL,
      hint:
        "该 Google 账号尚未接受 Gemini 应用条款（实测版本 9）。协议层本身已跑通。" +
        "解法一（推荐，零代签）：用该账号打开一次 Gemini App / Google App 并点「同意」，" +
        "之后该账号在所有客户端通道自动解锁。" +
        "解法二（需账号持有人明确授权）：执行 `node out/_tos-accept.mjs --commit` 代发 AcceptTermsOfService。",
    };
  }
  if (/First request should be 'initial'/i.test(m)) {
    return {
      code: "PROTOCOL_FRAMING",
      hint: "initial 帧未被识别。检查是否误加了 Lgcxj 包装层（请求消息就是 Lgcvp 本身）。",
    };
  }
  if (/ClientType is UNSPECIFIED or not provided/i.test(m)) {
    return { code: "CLIENT_TYPE_MISSING", hint: "initial 帧缺少 Lgauy.#4（ClientType），必须显式给定。" };
  }
  if (/Either SpeechRecognitionFeature or PrefetchInputFeature is required/i.test(m)) {
    return {
      code: "PREFETCH_FEATURE_REQUIRED",
      hint: "已识别 ClientType，但未走 prefetch 步骤。纯文本查询需 initial → prefetch → commit 三步。",
    };
  }
  if (/CommitControlFeature is missing in initial request/i.test(m)) {
    return {
      code: "FEATURE_NOT_DECLARED",
      hint: "initial 帧未声明 CommitControlFeature（IOS 路径暴露的按客户端分表的必需 feature 集）。",
    };
  }
  if (/No prefetch query to commit/i.test(m)) {
    return { code: "COMMIT_WITHOUT_PREFETCH", hint: "直接 commit 了。必须先发 prefetch（Lgcvp[ext1007] Lgcvl{#1 文本}）。" };
  }
  return null;
}
