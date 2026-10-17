// 运行环境配置：全部走环境变量（自托管时写进 service/.env；Vercel 时代走 Project Settings）。
function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn(`[config] ${name} 不是合法 JSON，已忽略`);
    return fallback;
  }
}

export const config = {
  // 本地监听端口（Vercel 上由平台注入 PORT）
  port: Number(process.env.PORT ?? 3000),

  // 下游客户端鉴权 key（argon 等使用）。留空 = 不鉴权（仅限本地开发）。
  proxyApiKey: process.env.PROXY_API_KEY ?? "",

  // Robin gRPC 上游（ROBIN_URL 可指向 mock：http://127.0.0.1:8788）
  robinUrl: process.env.ROBIN_URL ?? "https://robinfrontend-pa.googleapis.com",
  robinPath: process.env.ROBIN_PATH ?? "/assistant.mobile.robin.RobinService/ProcessQuery",
  robinUserAgent: process.env.ROBIN_USER_AGENT ?? "grpc-java-cronet/1.60.0",
  robinAuthToken: process.env.ROBIN_AUTH_TOKEN ?? "", // OAuth Bearer（设备侧提取，静态兜底）
  robinExtraHeaders: parseJsonEnv("ROBIN_EXTRA_HEADERS", {}), // {"x-goog-...": "..."}

  // ── 凭证管理（见 docs/credential-acquisition.md）──
  adminKey: process.env.ADMIN_KEY ?? "", // POST /admin/token 的管理口令（留空 = 禁用该端点）
  tokenProviderUrl: process.env.TOKEN_PROVIDER_URL ?? "", // 设备侧 token 供应器（返回 {"token":"ya29..."}）
  tokenProviderKey: process.env.TOKEN_PROVIDER_KEY ?? "",
  tokenProviderTtlMs: Number(process.env.TOKEN_PROVIDER_TTL_MS ?? 30_000),

  // ── gpsoauth：网页登录方案（服务端自行取凭证，无需真机）──
  // 一次性网页登录换到 master token（长期有效）后，服务端按需自动刷新 ya29.* 访问令牌。
  // 见 service/lib/gpsoauth.js。三个变量都可通过 GET /login 页面引导产出。
  gsaEmail: process.env.GSA_EMAIL ?? "", // 谷歌账号邮箱
  gsaMasterToken: process.env.GSA_MASTER_TOKEN ?? "", // oauth2rt_1/... （网页登录换取）
  gsaAndroidId: process.env.GSA_ANDROID_ID ?? "", // 留空 → 由 master token 派生，冷启动稳定
  gsaService: process.env.GSA_SERVICE ?? "oauth2:https://www.googleapis.com/auth/assistant",
  gsaApp: process.env.GSA_APP ?? "com.google.android.googlequicksearchbox", // AGSA：真正持有 assistant scope 的 app

  // 上传管道（push.clients6 两步 resumable）
  uploadBase: process.env.UPLOAD_BASE ?? "https://push.clients6.google.com/upload/",
  uploadTenantId: process.env.UPLOAD_TENANT_ID ?? "bard-storage",
  // ★ 2026-10-15 实证：push-id 头必需，值为固定 feeds ID（上传/附件链路打通的关键之一）
  pushId: process.env.UPLOAD_PUSH_ID || "feeds/mcudyrk2a4khkz",
  clientPctx: process.env.UPLOAD_CLIENT_PCTX ?? "",

  // 入站请求体上限。自托管给 32MB（生产真实请求体约 5.4MB）；
  // Vercel 平台硬限 4.5MB，须 ≤4613734 并留 ~128KB 余量做提前拦截
  maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 4.4 * 1024 * 1024),

  // ── 单请求媒体附件数量上限（多轮压单轮的累积防护）──
  // 多轮对话历史里的图片/音频/视频会被拼接进同一请求（附件按时间序累积）。
  // 实证（2026-10-16，_media-count-probe*.mjs）：N=1..30 全部 200，模型逐张数对、
  //   零丢弃；N=30 全程 66s（Vercel 300s 限额内）。超过上限时【丢最旧、保最新】
  //   （末尾媒体对应用户当前轮次，语义上最重要），并在提示词里显式告知模型
  //   哪些早期媒体未提交（防幻觉，与工具仿真的"不静默丢弃"同一原则）。
  // 0 或负数 = 不限制。
  maxAttachments: Number(process.env.ROBIN_MAX_ATTACHMENTS ?? 30),

  // ── 会话隔离（跨请求/跨用户串扰根治）──
  // Robin 服务端按【账号】维护会话，会话 ID 由服务端下发、客户端无法指定。
  //   2026-10-16 隔离对照实验（out/_conv-isolation-verify.mjs）：
  //   对照组（隔离关）检出了跨请求串扰迹象，开启隔离后不再泄漏。
  // 开启后：每次请求拿到答案后，调用 RobinService/DeleteConversation 删掉该次请求
  //   产生的会话 → 下次请求开启全新会话（对话内容不在服务端留存）。
  // 设为 "0"/"false" 关闭（保留服务端会话连续性）。
  isolateConversations: String(process.env.ROBIN_ISOLATE_CONVERSATIONS ?? "1") !== "0" &&
    String(process.env.ROBIN_ISOLATE_CONVERSATIONS ?? "1").toLowerCase() !== "false",

  // ── 模型档位（mode）──
  // Gemini App 的模型选择 = Lgauy.#16 里的 mode id（服务端下发，非硬编码）。
  // 调用方通过请求路径里的模型名选择（如 models/gemini-4-argon），解析表见 lib/modes.js。
  //   robinDefaultMode：模型名无法识别时用的兜底档位；留空 = 不发 #16（账号默认档位）
  robinDefaultMode: process.env.ROBIN_DEFAULT_MODE ?? "",
  // 档位表（GetUserStatus）的缓存时长。Google 新增/改名档位时无需改代码，等缓存自然过期即可。
  robinModeCacheTtlMs: Number(process.env.ROBIN_MODE_CACHE_TTL_MS ?? 10 * 60_000),

  // ── 档位静默降级观测（见 lib/degrade-guard.js）──
  // 上游按【账号】静默把高档位降为 3.5 Flash-Lite（HTTP 200、无报错，仅响应元数据可辨）。
  // 2026-10-17 起本模块【只观测+上报】：不换将、不跨档重试、不置窗 —— robin 与
  //   调用方（Eidolon）解耦，降级回显（modelVersion）原样透出，由上层跨通道回退
  //   （ag/gemini-3.8-flash）。同模型重试只保留在 empty-retry（空响应，见下）。
  // robinDegradeGuard=0 时连观测也关闭（/healthz 的 degradeGuard.enabled=false）。
  robinDegradeGuard: String(process.env.ROBIN_DEGRADE_GUARD ?? "1") !== "0" &&
    String(process.env.ROBIN_DEGRADE_GUARD ?? "1").toLowerCase() !== "false",

  // ── 媒体占位视频转封装（media shim，见 lib/mediashim.js）──
  // 音频附件 × Argon 互斥（上游硬限，已穷举无解）⇒ 把音频包进 16×16 极简视频绕过：
  //   Argon 满血档位下能准确转录视频音轨（2026-10-16 实测，7 段全过）。
  //   · 音频流 `-c:a copy` 零转码（~100ms/条、+0.4KB）；容器不兼容（wav/mp3/mp4）时回退 libopus。
  //   · 同内容音频（sha256）命中缓存直接复用 —— 多轮回放历史音频的场景命中率极高。
  //   · ffmpeg 缺失 / 转换失败 ⇒ 单条静默回退（保持原音频，行为同旧版：档位退让换听觉）。
  robinMediaShim: String(process.env.ROBIN_MEDIA_SHIM ?? "1") !== "0" &&
    String(process.env.ROBIN_MEDIA_SHIM ?? "1").toLowerCase() !== "false",
  robinShimCacheBytes: Number(process.env.ROBIN_SHIM_CACHE_MB ?? 32) * 1024 * 1024,
  robinShimConcurrency: Number(process.env.ROBIN_SHIM_CONCURRENCY ?? 2),
  robinShimTimeoutMs: Number(process.env.ROBIN_SHIM_TIMEOUT_MS ?? 30_000),
  robinFfmpegBin: process.env.ROBIN_FFMPEG_BIN ?? "ffmpeg",

  // ── 空响应自动重试（「偶发故障」与「资源型」的甄别，见 lib/empty-retry.js）──
  // 上游空响应（HTTP 200/STOP、无正文、无 #30）在官方 App 上同样偶发，且常见「重试即恢复」；
  // 与账号级降级（Flash-Lite 换将，重试无意义）是两类失败：
  //   · 档位降级 ⇒ 不重试、不换将（2026-10-17 起）：回显原样透出，由上层
  //     （Eidolon）跨通道回退到 ag/gemini-3.8-flash；
  //   · 空响应 ⇒ 先按「偶发故障」自动重试；连续空响应视为「资源型」，交上层处置。
  //   robinEmptyRetry：单请求最多重试次数（默认 1 ⇒ 总尝试 2 次）；0 = 关闭
  //   robinEmptyRetryDelayMs：重试间隔（默认 0，空响应本身已自带 25~35s 等待）
  //   robinEmptyRetryBudgetMs：重试总预算，从本请求进入 callRobin 起计时（默认 100s）
  //   robinEmptyRetryReserveMs：重试预留（默认 60s）——「已用 + 预留 ≥ 预算」即停止重试。
  //     约束来自调用方（Eidolon）的 120s 单请求硬超时：超时后请求直接失败，用户侧
  //     表现为「发送失败」；必须保证「已用 + 一次尝试的观测最长耗时(≈70s)」< 120s。
  //     → 允许重试窗口 = 预算 - 预留 = 40s（典型空响应 25~35s 在内）。
  //     教训（2026-10-16 20:25）：旧默认（2 次重试/170s 预算）在「空27s+空27s+成功69s=123s」
  //     时超过调用方 120s 4 秒，反代自愈成功但客户端已放弃 —— 双双落空。
  robinEmptyRetry: Math.max(0, Math.min(3, Number(process.env.ROBIN_EMPTY_RETRY ?? 1))),
  robinEmptyRetryDelayMs: Math.max(0, Number(process.env.ROBIN_EMPTY_RETRY_DELAY_MS ?? 0)),
  robinEmptyRetryBudgetMs: Number(process.env.ROBIN_EMPTY_RETRY_BUDGET_MS ?? 100_000),
  robinEmptyRetryReserveMs: Number(process.env.ROBIN_EMPTY_RETRY_RESERVE_MS ?? 60_000),

  // ── 空响应取证（诊断用；默认开，只在空响应时落盘，零常态开销）──
  //   空响应若因「解析失败」而起，光看 frames/unknown/extCounts 无法定位——
  //   必须拿到**原始字节**才能离线复核未知扩展（ext1004/1012/1014 等盲区）。
  //   代价：每次空响应落一份 hex（典型 <2KB），写到 journalctl 可直接捞。
  //   ROBIN_EMPTY_CAPTURE=0 关闭；ROBIN_EMPTY_CAPTURE_BYTES 控制单帧截断（默认 512 B）。
  robinEmptyCapture: String(process.env.ROBIN_EMPTY_CAPTURE ?? "1") !== "0",
  robinEmptyCaptureBytes: Math.max(64, Number(process.env.ROBIN_EMPTY_CAPTURE_BYTES ?? 512)),

  // ★ .env 路径（供 auth.js 在 /login 绑定成功后把新master token 落盘）。
  //   不落盘的代价：绑定只活在进程内存里，一重启就退回 .env 里的旧 token，
  //   而那个通常已失效 ⇒ 表现为「刚绑定成功、一重启又 auth-failure」。
  //   自托管默认指向 run.sh 同级的 .env；留空则关闭落盘（仅告警，不阻断绑定）。
  envFilePath: String(process.env.ROBIN_ENV_FILE ?? "").trim() || null,

  nodeEnv: process.env.NODE_ENV ?? "development",
};
