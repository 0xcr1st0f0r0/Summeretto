// service/lib/modes.js — Gemini App 通道的「模型档位」（mode）解析
//
// ═══════════════════════════════════════════════════════════════════════════
// 为什么需要这一层：
//   Gemini App 里选模型 = 选一个 **mode id**（16 位十六进制串），写在
//   Lgauy.#16（STRING）。上游据此决定用哪个模型，并在响应 Lfzrc.#30 回报
//   "Used 4 Argon model" 这样的真实模型名。
//
//   关键性质：mode id **由服务端下发**，不硬编码在 APK 里
//   （全 APK 搜不到 "argon" 字样）⇒ 必须向账号实时查询。
//
// 取证链（2026-10-16，字节码级）：
//   · Laotd.a(String) ← Lgavr.#1（模式配置的 id 字段），由 Lalof.i / Lbbca.b / Lbiyk.a 构造
//   · Laouo.b(...) 把 Laotd.a 写入 Lgauy.#16
//       —— iput-object v1, v0, Lgauy;.r + hasbits |= 1<<14
//       —— fieldmap: "#16 STRING [UTF8,HASBIT] r hasbit#14"  双向吻合
//   · 模式配置 + 可用白名单的唯一下发点 = GetUserStatus 响应 Lgaic
//       —— Lalqh.C(Lgaic;Lhcuk;) 是模式配置唯一入口
//       —— Lgaic.#17 → Lgavr[]（模式配置）、Lgaic.#18 → Lgahy[]（白名单）
//   · 全 162 条 RPC 中不存在任何 GetModeConfig ⇒ 必然搭在既有响应上
// ═══════════════════════════════════════════════════════════════════════════
//
// 设计：**静态表兜底 + 动态刷新**。
//   · 静态表（下方 MODES_STATIC）：首请求零延迟即可解析已知档位，冷启动也不怕
//   · 动态刷新（GetUserStatus，缓存 TTL）：Google 新增/改名档位时自愈，无需改代码
//   · 解析失败 → 返回 modeId=null（**不发 #16**，退回账号默认档位），不抛错

import { config } from "./config.js";

/** "3.5 Flash-Lite" → "3.5-flash-lite"；"Argon4p0" → "argon4p0"；"4 Argon" → "4-argon" */
function slug(s) {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 静态兜底表 —— 2026-10-16 实测账号（GetUserStatus 实拉）的 4 个档位。
 * label 取 Lgavr.#26（简短展示名）优先，退化到 #19。
 * 这张表只影响「冷启动首请求能否立即解析」，不决定可用性（动态刷新会覆盖/扩展）。
 */
const MODES_STATIC = [
  { id: "8c46e95b1a07cecc", short: "Flash-Lite", label: "3.5 Flash-Lite", rank: 6 },
  { id: "56fdd199312815e2", short: "Flash", label: "3.8 Flash", rank: 1 },
  { id: "e6fa609c3fa255c0", short: "Pro", label: "3.1 Pro", rank: 3 },
  { id: "95a4c0abcba24364", short: "Argon", label: "4 Argon", rank: 8 },
];

/** 无档位（不写 Lgauy.#16）的显式写法 —— 退回账号默认档位 */
export const MODE_NONE_ALIASES = new Set(["default", "auto", "", "none"]);

/** 一个 mode 的所有可识别别名（含 id 自身、slug、gemini- 前缀形式） */
function aliasesOf({ id, short, label }) {
  const out = new Set([String(id).toLowerCase()]);
  for (const raw of [short, label]) {
    const s = slug(raw);
    if (!s) continue;
    out.add(s);
    out.add(`gemini-${s}`);
    out.add(`models/${s}`);
    out.add(`models/gemini-${s}`);
  }
  return [...out];
}

let cache = { at: 0, entries: MODES_STATIC, byAlias: null, source: "static", error: null };

function buildIndex(entries) {
  const byAlias = new Map();
  for (const e of entries) for (const a of aliasesOf(e)) if (!byAlias.has(a)) byAlias.set(a, e);
  return byAlias;
}

// 静态表索引（永不过期，作为最终兜底）
const STATIC_INDEX = buildIndex(MODES_STATIC);

/** 归一化调用方给的模型名：去 models/ 前缀、小写、去空白 */
function norm(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}

/**
 * 判断是否为「裸 mode id」（16 位十六进制）。
 * 允许调用方直接传 id —— 这样即使静态表过期，用户从 /v1beta/models 拿到的新 id 也能直接用。
 */
function asRawId(s) {
  return /^[0-9a-f]{16}$/.test(s) ? s : null;
}

/**
 * 同步解析（不发网络）。解析不到返回 modeId=null（= 不发 #16）。
 * @returns {{modeId: string|null, label: string|null, alias: string, source: 'static'|'dynamic'|'raw'|'none'|'miss'}}
 */
export function resolveModeSync(name) {
  const s = norm(name);
  if (MODE_NONE_ALIASES.has(s)) return { modeId: null, label: "账号默认档位", alias: s, source: "none" };

  const raw = asRawId(s);
  if (raw) return { modeId: raw, label: null, alias: s, source: "raw" };

  const dyn = cache.byAlias?.get(s);
  if (dyn) return { modeId: dyn.id, label: dyn.label ?? dyn.short ?? null, alias: s, source: "dynamic" };

  const st = STATIC_INDEX.get(s);
  if (st) return { modeId: st.id, label: st.label ?? st.short ?? null, alias: s, source: "static" };

  return { modeId: null, label: null, alias: s, source: "miss" };
}

/** 缓存是否新鲜 */
function fresh(ttlMs = config.robinModeCacheTtlMs) {
  return cache.byAlias && Date.now() - cache.at < ttlMs;
}

/**
 * 从上游刷新档位表（GetUserStatus）。失败**不抛错**，保留旧缓存。
 * @returns {Promise<{ok: boolean, count: number, source: string, error?: string}>}
 */
export async function refreshModes(force = false) {
  if (!force && fresh()) return { ok: true, count: cache.entries.length, source: cache.source };
  try {
    // 动态 import：避免 modes.js ↔ robin.js 的循环依赖，也让 mock/单测可绕开
    const { getUserStatus } = await import("./robin.js");
    const r = await getUserStatus({ timeoutMs: 20_000 });
    if (!r.ok || !r.modes?.length) {
      cache = { ...cache, error: r.error ?? r.grpcMessage ?? `无模式配置（grpc-status=${r.grpcStatus}）` };
      return { ok: false, count: cache.entries.length, source: cache.source, error: cache.error };
    }

    // 白名单过滤：只保留账号真正允许的 id（Lgaic.#18 → Lgahy.#1）
    const allowed = new Set(r.allowlists.flatMap((a) => a.ids ?? []));
    const usable = allowed.size ? r.modes.filter((m) => allowed.has(m.id)) : r.modes;

    const entries = usable.map((m) => ({
      id: m.id,
      short: m.s2 ?? null,
      label: m.s26 ?? m.s19 ?? m.s2 ?? m.id,
      rank: m.int23 ?? null,
      // 附加原始字段便于排查
      raw: m,
    }));
    if (!entries.length) {
      cache = { ...cache, error: "白名单与配置表无交集" };
      return { ok: false, count: cache.entries.length, source: cache.source, error: cache.error };
    }

    cache = {
      at: Date.now(),
      entries,
      byAlias: buildIndex(entries),
      source: "dynamic",
      error: null,
    };
    return { ok: true, count: entries.length, source: "dynamic" };
  } catch (err) {
    cache = { ...cache, error: err?.message ?? String(err) };
    return { ok: false, count: cache.entries.length, source: cache.source, error: cache.error };
  }
}

/**
 * 异步解析：同步未命中时按需刷新一次（只在**未知模型名**上付出这一次 ~2s 代价）。
 * @returns {Promise<ReturnType<typeof resolveModeSync>>}
 */
export async function resolveMode(name) {
  const first = resolveModeSync(name);
  if (first.source !== "miss") return first;
  await refreshModes(false);
  return resolveModeSync(name);
}

/**
 * 按档位 id 反查条目（降级判定用：lib/degrade-guard.js 需要 label/short 来比对 #25/#30）。
 * 动态表优先、静态表兜底；查不到返回 null。
 */
export function modeById(id) {
  const s = String(id ?? "").trim().toLowerCase();
  if (!s) return null;
  for (const e of cache.entries) if (String(e.id).toLowerCase() === s) return e;
  for (const e of MODES_STATIC) if (e.id === s) return e;
  return null;
}

/** 当前档位表（供 /v1beta/models 列清单；不触发刷新） */
export function currentModes() {
  return {
    source: cache.source,
    fetchedAt: cache.at ? new Date(cache.at).toISOString() : null,
    error: cache.error,
    entries: cache.entries.map((e) => ({ id: e.id, short: e.short, label: e.label, rank: e.rank })),
  };
}

/** 生成 Gemini 原生格式的模型清单条目 */
export function modelListPayload() {
  const entries = cache.entries;
  const out = entries.map((e) => {
    const name = `models/${slug(e.label ?? e.short ?? e.id)}`;
    return {
      name,
      displayName: `${e.label ?? e.short ?? e.id}（Gemini App 通道）`,
      description:
        `Robin App 通道档位 mode=${e.id}` +
        (e.rank !== null && e.rank !== undefined ? `（rank ${e.rank}）` : ""),
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
      modeId: e.id,
    };
  });
  // 显式暴露「不打 #16、用账号默认档位」的选项
  out.push({
    name: "models/default",
    displayName: "账号默认档位（Gemini App 通道）",
    description: "不指定档位，由服务端按账号默认值选择",
    supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    modeId: null,
  });
  return out;
}

/** 供 /healthz 用的极简摘要 */
export function modesSummary() {
  return {
    source: cache.source,
    count: cache.entries.length,
    fetchedAt: cache.at ? new Date(cache.at).toISOString() : null,
    error: cache.error,
    ids: cache.entries.map((e) => e.id),
  };
}

/* ══════════════════════ 思考强度（thinking level） ══════════════════════ */
//
// ★★ 2026-10-16 逆向定案 + 线上实证：思考档位写【信封 Lfzqy.#48】，**不在 Lgauy**。
//   这也是此前对 Lgauy 全部 22 个字段扫描全部失败的原因。
//
// 取证链（字节码级，可复现）：
//   · Lanmw.c 发送序列（同一 Lfzqz 构建器实例）：
//       Lalmv.a() → Lfzqz.O(I)      // rank
//       Lalmv.d() → Lfzqz.E(String) // 显示名
//       Laloi.a() → Lfzqz.P(I)      // ★ 档位值
//       Laloi.b() → Lfzqz.S(String) // ★ routingVariantId
//   · Lfzqz.P/S 只做两件事：or hasBits1 标记 + 写数据字段
//       P: c |= 1<<12 → hasbit#44 → Lfzqy.#48 (INT32)
//       S: c |= 1<<14 → hasbit#46 → Lfzqy.#67 (STRING)
//   · Laloi = {int value, String routingVariantId}（= 日志里的 ThinkingLevelId）
//     构造点 Lalsq.g(int, Z, String, Lgaps, Lhcuk) / Lbejo.a（UI 点击）
//   · 档位表来源 = Apollo flag `launch_ultra_mode_pro_policy`
//       Lgaic.#34 Lgawz → #2 Lgawx[] → #2 Lgbdp[]，其中 #2=名称、#4=档位值
//
// 线上实证（Argon，out/_think-envelope.mjs，2026-10-16）：
//   不发 #48        → Lfzrc.#30 "Used 4 Argon model"          #42=1
//   #48=1 (Low)     → "Used 4 Argon model"                    #42=1
//   #48=4 (Medium)  → "Used 4 Argon Medium model"             #42=4
//   #48=2 (High)    → "Used 4 Argon High model"               #42=2
//   ⇒ Lfzrc.#42 逐字回显档位值 + 上游自述变更 + High 耗时显著更长（三重互证）
//
// ⚠️ 不传 #48 = 服务端按 Low(1) 处理（#42 回显 1）
// ⚠️ Lfzqy.#67 (routingVariantId) 实测填 mode id → 上游 "Used Legacy model" 且流中断
//    ⇒ 默认留空；保留参数仅供后续实测出真实变体 id 后启用

/** 档位名 → 协议值（Lgbdp.#4 实测） */
export const THINKING_LEVELS = Object.freeze({ low: 1, medium: 4, high: 2 });

/**
 * 外部档位名别名 → 本通道档位名。
 * `minimal` 是 Gemini 公开 API 的 ThinkingLevel 枚举成员（部分 SDK 版本），
 * 语义即"最低档"，映射到 low —— 避免调用方拿到无用的"无法识别"告警。
 * （`max` 由调用方自行归一，见 Eidolon `_get_thinking_config`：max → high）
 */
export const THINKING_LEVEL_ALIASES = Object.freeze({ minimal: "low" });

/** 协议值 → 档位名（回显/日志用） */
export const THINKING_LEVEL_NAMES = Object.freeze({ 1: "low", 4: "medium", 2: "high" });

/** 每个档位的中文说明（来自 Lgbdp.#3） */
export const THINKING_LEVEL_HINTS = Object.freeze({
  low: "Quick and efficient（快而省）",
  medium: "Balanced depth（均衡）",
  high: "Extra thorough（更充分）",
});

/**
 * 解析调用方给的思考档位。
 * 接受："low"/"medium"/"high"（大小写不敏感）、别名 "minimal"→low、
 *       数字 1/4/2、数字字符串 "1"/"4"/"2"。
 * @returns {{value: number, name: string}|null} 无法识别时返回 null（= 不发送，服务端默认 Low）
 */
export function parseThinkingLevel(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === "number" || typeof input === "bigint") {
    const v = Number(input);
    return THINKING_LEVEL_NAMES[v] ? { value: v, name: THINKING_LEVEL_NAMES[v] } : null;
  }
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = THINKING_LEVEL_ALIASES[s] ?? s;
  if (THINKING_LEVELS[s] !== undefined) return { value: THINKING_LEVELS[s], name: s };
  if (/^[0-9]{1,3}$/.test(s)) {
    const v = Number(s);
    if (THINKING_LEVEL_NAMES[v]) return { value: v, name: THINKING_LEVEL_NAMES[v] };
  }
  return null;
}

/**
 * 从模型名里剥离思考档位后缀：`4-argon-high` → `{ base: "4-argon", level: "high" }`。
 * 无后缀时 level=null。调用方需在 base 解析失败时回退到完整名字（见 app.js）。
 */
export function splitThinkingSuffix(name) {
  const s = norm(name);
  const m = s.match(/^(.*?)-(low|medium|high)$/);
  return m ? { base: m[1], level: m[2] } : { base: s, level: null, raw: s };
}

/** 思考档位能力摘要（/v1beta/models、/healthz 用） */
export function thinkingSummary() {
  return {
    supported: true,
    levels: Object.entries(THINKING_LEVELS).map(([name, value]) => ({ name, value })),
    aliases: { ...THINKING_LEVEL_ALIASES },
    defaultWhenOmitted: "low",
    carrier: "Lgcvb.#1 Lfzqy.#48",
    requestWays: [
      "generationConfig.thinkingConfig.thinkingLevel: \"low\"|\"medium\"|\"high\"",
      "generationConfig.thinkingLevel: 同上（简写）",
      "模型名后缀：4-argon-high / 4-argon-medium / 4-argon-low",
    ],
  };
}
