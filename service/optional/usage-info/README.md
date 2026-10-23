# 可选：查询共享额度与重置时间

独立、零新增依赖的只读工具。仅增加本目录文件，不修改网关、路由、启动命令、模型选择或凭证管理。默认关闭；不会自动轮询，也不会发送生成请求、切换账号或同意条款。

需要与服务相同的 Node.js 22 环境及已有 Robin 凭证配置。请参照现有凭证文档准备环境变量，不要把令牌写入命令参数、提交到仓库或放进公开网页。

在 `service/` 运行：

```sh
# 默认关闭，不导入服务模块，不访问网络
node optional/usage-info/query.mjs
# 显式启用，使用已有环境；若凭证在文件中，可使用 Node 的 --env-file 参数
node --env-file=.env optional/usage-info/query.mjs --enable
# 离线测试（不需要真实凭证）
node optional/usage-info/test.mjs
```

启用后只调用一次 `GetUsageInfo`。认证复用 `lib/auth.js`，可能为现有 master token 换取短期访问令牌或读取已配置的 token provider；不绑定新凭证，不写凭证文件。RPC 超时 20 秒；整个独立进程最多等待 60 秒（包括认证）。进程的内存令牌缓存随退出释放。

标准输出为单行 JSON。退出码 0 表示查询成功或默认关闭；1 表示查询/解析失败；2 表示参数错误。已有模块的日志在这个独立 CLI 进程中被抑制，避免污染 JSON 或暴露认证响应。不会修改服务进程的日志行为。错误仅返回固定代码及数字 gRPC status，不输出上游原文、邮箱、令牌或聊天正文。

示例（合成数据）：

```json
{"ok":true,"source":"GetUsageInfo","checkedAt":"2026-10-21T00:00:00.000Z","pools":[{"type":"five_hour","usedPercent":25,"remainingPercent":75,"resetAt":"2026-10-21T05:00:00.000000000Z"},{"type":"weekly","usedPercent":10,"remainingPercent":90,"resetAt":"2026-10-27T05:00:00.000000000Z"}]}
```

`resetAt` 是上游时间戳的 UTC ISO 8601 表示，保留纳秒；前端自行按用户时区显示。不会因为时间已经过去就推算额度已恢复。缺少或无效的百分比/时间返回 `null`；未返回的池不出现在数组中。`ok:true,pools:[]` 仅表示响应可解析且没有已识别的池，不能解释为无限额度、额度为零或账号一定可用。

这是**当前凭证的共享预算池百分比**，不是剩余请求次数、token 数，也不是每个模型独立的限额。实测 App 的若干高档模型显示同一共享恢复时间，但这里不硬编码模型归属，也不推断 Flash-Lite 的限制。后台可在发送消息前按需运行命令，按自己的凭证标识保存结果；本工具不读取多账号凭证库，也不自动决定是否允许生成。不要直接公开一个未鉴权的执行接口。

## 协议依据与限制

通过自有账号的 Google Android App 限制页面调用链及响应验证（2026-10-21）：

`SeeQuotaUsage → UsageLimitsDS → RobinService.GetUsageInfo`。

APK 中观察到的混淆类型仅作为定位线索，版本更新后可能变化：请求 `Lgckf`，响应 `Lgckg`；App 将 `Lgcky` 的 float 作为 `pctUsed` 使用并显示进度。查询期间没有提交生成请求。此接口并非 Google 公开、稳定的配额 API，不保证适用于所有账号或未来版本。

| 消息 | 字段 | 含义 |
| --- | --- | --- |
| GetUsageInfo request | #1 message | 已有 `buildLgauy({enum4:2})` Android 客户端信息 |
| GetUsageInfo response | #3 repeated message | 预算池 `Lgcla` |
| 预算池 | #1 enum | 1 五小时；2 每周；3 超额 credits（本工具忽略） |
| 预算池 | #2 oneof message | `Lgcky` 使用比例与重置时间；#3 为另一种 credits 结构 |
| 使用信息 | #1 message | Timestamp：#1 int64 秒，#2 int32 纳秒 |
| 使用信息 | #2 float32 | **已使用比例**，范围 0–1；剩余百分比 = `(1-pctUsed)*100` |

缺少 float 字段时保守返回未知，不把 protobuf 默认值当作“额度全满”的证据。未知池跳过，截断/不支持的 wire 数据报错；不把其它结构中的数值套用到这里。`CheckGeminiQuota` 的通用数值和 `CheckModeFeatureQuota` 的特性时间不用于此工具，不能据此推断剩余次数。

测试覆盖 0/满额/部分用量、缺失和异常比例、UTC 纳秒、无效时间、未知池和 oneof、截断数据；本地 HTTP/2 mock 验证 opt-in 开关、请求编码、单次调用、错误退出及日志不泄漏。不依赖 APK、生产凭证或真实 Google 网络。
