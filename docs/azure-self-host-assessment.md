# Azure 自托管可行性评估（gemini-robin-proxy）

> 评估日期：2026-10-16 · 目标机：`azureuser@172.197.160.219`（`Standard_B2ats_v2`，Malaysia West）
> 触发问题：Vercel 入站 4.5MB 硬限导致语音请求 413（生产实测请求体 5.37MB）

---

## 一、结论

**可行。内存不是瓶颈。**

生产规模请求（4.90MB 媒体 base64，含真实上传路径）在该机上的实测占用：

| 指标 | 数值 |
|---|---|
| 进程峰值（VmHWM） | **91.3 MB** |
| 稳态 RSS | 79.3 MB |
| cgroup 独占内存 | 44.7 MB |
| 端到端耗时 | 228 ms |

该机当前 `MemAvailable` = 304 MB。扣除后仍余 **210 MB 以上**，并发 2 路时（峰值 105.6 MB）余量也在 198 MB。

---

## 二、为何要自托管：Vercel 限制是硬伤

| 限制项 | Vercel Hobby | 自托管 |
|---|---|---|
| **入站请求体** | **4.5 MB（硬限，不可调）** | 无（受 `MAX_BODY_BYTES` 自控） |
| 函数最长执行 | 300 s | 无 |
| 冷启动 | 有 | 无 |
| 上游延迟 | 公网（SG/US 边缘 → Google） | loopback（Eidolon 同机，< 1 ms） |
| Token 持久化 | 无常驻内存，冷启动重刷 | 常驻进程可缓存/刷新 |
| 商业用途 | Hobby 限个人非商业 | 无限制 |

**生产实测的请求体构成**（`server/scripts/diag_robin_payload.py`）：

```
历史音频 base64   : 3.29 MB   ← 大头
历史图片 → base64 : 1.22 MB
当前语音 base64   : 0.39 MB
历史文本+工具提示  : 0.09 MB
─────────────────────────────
估算请求体        : 5.37 MB  ❌ 超 Vercel 4.50MB → 413
```

超限 0.87 MB —— 所以语音必然被拒，且**无法通过调参绕过**（Vercel 平台级硬限）。

---

## 三、实测数据（实机，非估算）

### 3.1 方法

在目标机上真实部署反代服务 + 本地 mock 上游（零配额），用生产实测的媒体分布构造请求体：

- 构造：6 条音频 + 6 张图片 + 1 条当前音频，比例 67.2 : 24.9 : 7.9（贴合生产）
- 测量：`/proc/PID/status` 的 `VmRSS`（瞬时）/ `VmHWM`（内核峰值水位）+ cgroup `memory.peak`
- 保护：用 `systemd-run` 给测试进程设 `MemoryMax`，避免波及同机 `eidolon` / `gcli2api`

### 3.2 结果

| # | 场景 | payload | 峰值 VmHWM | 稳态 RSS | cgroup 独占 | 耗时 |
|---|---|---|---|---|---|---|
| A | 生产规模单发（mock 上游） | 4.90 MB | 85.3 MB | 71.7 MB | 44.5 MB | 147 ms |
| B | 生产规模 ×5 连发 | 4.90 MB | 101.2 MB | 86.6 MB | 60.1 MB | ~100 ms/轮 |
| C | 2× 规模 | 10 MB | 119.8 MB | 91.2 MB | 74.9 MB | 188 ms |
| D | 4× 规模 | 20 MB | 161.1 MB | 106.5 MB | 117.4 MB | 403 ms |
| **E** | **生产规模（真实上传路径）** | **4.90 MB** | **91.3 MB** | **79.3 MB** | 44.7 MB | 228 ms |
| **F** | **并发 2 × 生产规模（真实上传）** | 2×4.90 MB | **105.6 MB** | 93.8 MB | 59.6 MB | 334 ms |
| G | 加 `--max-old-space-size=128`，连发 5 轮 | 4.90 MB | 113.3 MB | 99.9 MB | 66.5 MB | ~140 ms/轮 |

**全部 7 组 HTTP 200，零 OOM。**

### 3.3 三条要读出来的规律

1. **峰值 ≈ payload × 5~6**（V8 基础 55MB + 处理增量）。
   4.9MB → +36MB；10MB → +64MB；20MB → +106MB。
2. **内存会收敛，不泄漏**。连发 5 轮的峰值序列为 `67.6 → 96.8 → 92.1 → 101.2 → 91.8`，
   稳态稳定在 86.6MB；跑完后系统 `MemAvailable` 回升（286MB > 跑前 282MB）。
3. **`--max-old-space-size` 无效**（G 组反而略高 101.2 → 113.3）。
   原因：附件是 `Buffer`（V8 external memory），不受堆上限约束。**部署时不必设**。

### 3.4 上传路径的额外开销很小

E 组（真实上传路径，13 个附件全部 finalize 成功）对比 A 组（跳过上传）：

```
峰值：85.3 → 91.3 MB  (+6.0 MB)
稳态：71.7 → 79.3 MB  (+7.6 MB)
```

上传是**串行**的（每个附件传完即释放），所以开销恒定而不随附件数累积。

> 测试手法：利用 `isLocalUpstream()` 只匹配字面量 `127.0.0.1` 的特性，
> 让反代连 `127.0.0.2`（同属 loopback 网段）→ 判定为"远程"→ 走完整上传路径，
> 而 `UPLOAD_BASE` 指向本地 mock → 零配额、零外网。

---

## 四、与同机现有服务的共存

### 4.1 机器现状（实测）

| 项 | 值 |
|---|---|
| 机型 | `Standard_B2ats_v2`（2 vCPU / **1 GiB**，AMD EPYC 7763） |
| MemTotal | 848 MiB |
| MemAvailable | 304 MiB（评估时） |
| Swap | 8 GB `/swapfile`，已用 385 MB |
| **Committed_AS** | **1.14 GB（已超物理内存，靠 overcommit + swap 支撑）** |
| 磁盘 | 63 G，可用 39 G |

进程占用：

| 进程 | RSS |
|---|---|
| `eidolon` gunicorn master + worker | 166 + 46 MB |
| `gcli2api`（**同类 Gemini 反代服务**，systemd 常驻） | 88 MB |
| `caddy` | 32 MB |
| 系统 + 其他 | ~210 MB |

> `gcli2api` 是最好的参照物：**同类服务在这台机器上长期稳定占用 88 MB**，
> 与本反代的实测稳态（79 MB）几乎一致。

### 4.2 加进来之后

| 场景 | 稳态增量 | 峰值增量 | 峰值时刻 MemAvailable |
|---|---|---|---|
| 生产规模单发 | +79 MB | +91 MB | ~213 MB |
| 并发 2 路 | +94 MB | +106 MB | ~198 MB |

**结论：放得下，余量充足。**

---

## 五、部署要点（必须改的配置）

### 5.1 ★ `MAX_BODY_BYTES` 必须调大（否则搬过去还是 413）

反代的默认值是 `4.4 * 1024 * 1024`，**专为 Vercel 硬限设计**：

```js
// service/lib/config.js
maxBodyBytes: Number(process.env.MAX_BODY_BYTES ?? 4.4 * 1024 * 1024),
```

本次实测中，用默认值跑 4.90MB 请求**直接 413**：

```
{"error":{"code":413,"message":"请求体超限（>4613734.4 字节）。
  Vercel 硬限 4.5MB：大媒体请走分片上传（/upload/v1beta/files）"}}
```

建议值 **32 MB**（覆盖 4× 生产规模，实测峰值 161 MB 仍在 192 MB 配额内）：

```bash
MAX_BODY_BYTES=33554432
```

### 5.2 cgroup 内存约束（保护同机服务）

```ini
# systemd unit 关键属性
MemoryMax=192M        # 实测峰值 106 MB，留 86 MB 余量
MemorySwapMax=512M    # 允许少量换出，避免被 OOM 直接杀
```

### 5.3 不需要做的事

- ❌ **不要设** `--max-old-space-size`（实测无收益，见 §3.3）
- ❌ 不需要为反代单独开 HTTPS / 域名：Eidolon 与它同机，走 `http://127.0.0.1:8802` 即可
- ❌ 不要缩小 Eidolon 侧的媒体回放预算（`_HISTORY_AUDIO_MAX_TOTAL_BYTES` 等）——
  自托管后限制已解除，无需破坏既有语义

### 5.4 凭证迁移（已确认方案）

Vercel 生产环境变量（`vercel env ls production`）：

```
PROXY_API_KEY       (下游鉴权)
ADMIN_KEY           (管理端点)
GSA_EMAIL           ┐
GSA_MASTER_TOKEN    ├ gpsoauth：服务端用 master token 自动刷新 ya29.*
GSA_ANDROID_ID      ┘
```

说明生产**已在用 gpsoauth 方案**（网页登录换长期 master token，服务端按需刷新访问令牌）。
因此自托管后**没有静态 token 一小时后过期的问题** —— 只需迁移这 5 个变量。

> 常驻进程相比 serverless 的额外好处：刷新结果可缓存在内存/磁盘，冷启动不需要重刷。

### 5.5 Eidolon 侧

```bash
# 把反代地址从 Vercel 改到同机 loopback
ROBIN_PROXY_BASE_URL=http://127.0.0.1:8802
```

改完需 `systemctl restart eidolon`（本项目 `preload_app=True`，`reload` 不换代码）。

---

## 六、风险与遗留项

### 已识别风险

1. **该机内存本就紧张**：`Committed_AS` 1.14 GB 已超物理内存 848 MB，swap 已用 385 MB。
   加反代后约 1.25 GB。属**可接受但需知晓** —— 现状已在依赖 swap，本次是在既有基础上 +80 MB。
2. **swap 抖动**：若反代页被换出，请求处理会变慢（功能不受影响）。
   可通过 `MemorySwapMax=512M` 限制换出量来约束。

### 尚未验证（正式部署前建议补测）

1. **Azure → Google 真实连通性**：本机到 `robinfrontend-pa.googleapis.com` 的
   延迟/丢包（马来西亚 West 区域）。本次测试全程用本地 mock，未打真实上游。
2. **真实 token 下的端到端**：迁移 5 个环境变量后跑一次真实请求。
3. **长期稳定性**：建议观察 24h 的 RSS 曲线，确认无缓慢上涨。

---

## 七、复现方法

测试资产位于 `out/azure-mem/`（脚本）与目标机 `~/robin-probe/`（部署副本）：

| 文件 | 用途 |
|---|---|
| `_bench.sh` | 起服务 / 压测 / 读内存 / 停止（含 cgroup 限制） |
| `_memload.mjs` | 压测客户端：按生产分布构造 payload，采样目标进程 RSS |
| `_mock-serve.mjs` | 本地 mock Robin（h2c） |
| `_upload-mock.mjs` | 本地 mock 上传端点（触发真实上传路径） |

```bash
# 目标机上（Node 已装于 ~/opt/node-v22.23.3-linux-x64）
cd ~/robin-probe
./_bench.sh load 4.90 1 upload 224     # 生产规模 + 真实上传路径，224M 限制
./_bench.sh load 4.90 5 upload 224     # 连发 5 轮
PAR=2 ./_bench.sh load 4.90 1 upload 224   # 并发 2
./_bench.sh mem                        # 读 cgroup 峰值/事件
./_bench.sh stop
```

---

## 八、附：原始测量输出（关键几组）

```
A. 生产规模 4.90MB 单发（mock）
   baseline RSS 55.3 MB | #1 HTTP 200 147ms peak=82.5MB post=71.7MB
   final RSS 71.7 MB | 进程历史峰值 85.3 MB | cgroup peak 44.5 MB

B. 连发 5 轮
   #1 peak=67.6MB  #2 peak=96.8MB  #3 peak=92.1MB  #4 peak=101.2MB  #5 peak=91.8MB
   final RSS 86.6 MB | 进程历史峰值 101.2 MB | cgroup peak 60.1 MB

E. 生产规模 + 真实上传路径（13 次 finalize 全成功）
   #1 HTTP 200 228ms peak=90.9MB post=79.3MB
   final RSS 79.3 MB | 进程历史峰值 91.3 MB | cgroup peak 44.7 MB

F. 并发 2 × 生产规模 + 真实上传（26 次 finalize）
   #1 HTTP 200/200 334ms peak=104.4MB post=93.8MB
   final RSS 93.8 MB | 进程历史峰值 105.6 MB | cgroup peak 59.6 MB
```
