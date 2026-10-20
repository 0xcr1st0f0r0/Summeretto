# Stage 2 —— AGSA Robin 协议逆向报告（原生音视频通道定位）

> 日期：2026-10-15（末次更新 23:xx）| 状态：**★ 协议层已实机贯通**；唯一剩余阻塞 = 账号级 ToS（见 §6.2）
> 分析对象：`apk/AGSA_17.66.12.xapk`（内层 `com.google.android.googlequicksearchbox.apk`，14 DEX，245MB）
>
> **最新突破速览**：ProcessQuery 三步式（initial→prefetch→commit）已被真实服务端接受，
> 能力表 ACK 解析成功，服务端正常结束流。核心更正是「**请求消息就是 `Lgcvp` 本身，无 `Lgcxj` 包装**」
> —— 此前 4 轮探测全负的根因。详见 **§5.7**。

---

## 0. 一句话结论

**移动端 Gemini（Robin）与 Web 是两套完全独立的协议栈：**

| | Web（现有网关） | 移动端（本次目标） |
|---|---|---|
| 前端主机 | `gemini.google.com` | **`robinfrontend-pa.googleapis.com`** |
| 协议 | HTTP `batchexecute` （`f.req` + `rpcids`） | **gRPC**（Kotlin stub + Cronet 双向流） |
| 服务 | `BardChatUi`（无任何命中） | **`assistant.mobile.robin.RobinService`** |
| 主对话 RPC | `hNvQHb` 等（字符串/JSON 混排） | **`ProcessQuery`（bidi stream）** |
| 附件上传 | `push.clients6` / `content-push` | **同族端点，但租户/Push-ID 不同（见 §3）** |

→ 移动端能力**不可能**通过微调 web payload 获得；要原生音视频，必须复刻 Robin gRPC 通道 + 附件上传协议。

**★ 可复刻性已由实机证实（2026-10-15 晚）**：`ProcessQuery` 三步式协议经真实 gRPC 双向流探测全部被接受
（见 §5.7），无客户端证书 / attestation 门控。唯一剩余的账号级阻塞是 ToS 未接受（错误消息明确）。

---

## 1. 工具链修复与升级（本次关键工程产出）

修复了两个**导致此前所有"方法级"分析结果全部不可信**的核心 bug：

| Bug | 位置 | 影响 | 修复 |
|---|---|---|---|
| `encoded_method` 多读了 1 个 ULEB（4 而非 3 个字段） | `tools/dexlib.py::iter_class_data` | **每个类从第 2 个方法起全部错位**，方法名大面积错乱 | 只读 3 字段（idx_diff/access/code_off） |
| `try_item.handler_off` 当绝对文件偏移读 | `tools/codeitem.py::_parse_tries` | 读到垃圾后做巨量 ULEB 循环 → **全方法扫描 10 分钟跑不完** | 默认跳过 tries；需要时按 `list_base + off` 正确解析 |

修复后性能：**全库 14 DEX 字符串转储 3 秒；全库字符串交叉引用 0.1 秒/DEX**（此前 >11 分钟未完成）。

新增工具：
- `tools/dump_strings.py` —— 全量字符串/类名转储 + 索引（`out/idx/`，60 万条）
- `tools/xref.py` —— 字符串交叉引用扫描（"哪个类.哪个方法引用了 X"，C 级 bytes.find）

---

## 2. 传输层（gRPC / robinfrontend）

### 2.1 主机（均含 .mtls. / preprod / staging / autopush 变体）

```
robinfrontend-pa.googleapis.com              ← prod 主入口
webchannel-robinfrontend-pa.googleapis.com   ← webchannel 变体
assistantfrontend-pa.googleapis.com          ← 旧 assistant 前端（并存）
robin-proactivebackend-pa.googleapis.com     ← 主动式
speechs3proto2-pa.googleapis.com             ← 语音 S3（S3Bidi 双向流）
```

引用类：`Lwjb.b`（classes.dex）、`Lfzkv`/`Lgcpe`（classes2.dex，含 mtls）、`Lbvlu.<clinit>`（classes5.dex）、`Lerqq.<clinit>`（环境枚举，38 个常量）

### 2.2 gRPC 服务

- 服务名：**`assistant.mobile.robin.RobinService`**（含 `.`、`/` 变体，classes2.dex:60682-60684）
- 服务描述符类：**`Lgbdm`**（classes2.dex，**162 个方法**一一对应 RPC）
- Kotlin 存根：`com.google.assistant.mobile.robin.proto.RobinServiceGrpcKt$RobinServiceCoroutineStub`
- 相关 assistant 服务：`assistant.frontend.v1.CloudArbitrationFrontendProxyService/SendArbitrationRequest`、`AssistantSummarizeProxyService`、`assistant.mobile.robin.android.RobinStatusCheckerService`、`notify.GeminiNotifyService`

### 2.3 主对话 RPC：`ProcessQuery`（双向流）

客户端类 **`Lanuc`**（`ProcessQueryStreamConnection`，classes12.dex，19 个方法）：

| 方法 | 含义 |
|---|---|
| `initRequest` | 初始请求（initial） |
| `sendCommitRequest` / `commitStream` | 提交（commit） |
| `sendAbortRequest` | 中止（abort） |
| `sendContextUpdateRequest` | 设备上下文更新（device context） |
| `sendPrefetchRequest` | 预取（prefetch） |
| `sendEndBlockingSession` | 结束阻塞会话 |
| `fetchDeviceContext` / `collectResponsesAndHandleReconnects` | 上下文 & 重连 |

- 变体：`processQuery-Classic`（经典）/ `processQuery-AgentTask`（Agent 任务）
- 网络：**Cronet**（`org.chromium.net.BidirectionalStream`）+ 指数退避重试
- 请求类型：`com.google.assistant.mobile.robin.proto.streaming.ProcessQueryRequest`（来自 Kotlin 签名：`record(Lcom/google/assistant/mobile/robin/proto/streaming/ProcessQueryRequest;)V`）
- 响应处理：`ProcessQueryResponseHandler.handleResponses`；模型回复 = **RobinOp** 序列

### 2.4 RPC 目录（162 个，完整清单见 `out/robin/robin-rpc-list.txt`）

重点 RPC 节选：

| RPC | 用途 |
|---|---|
| **ProcessQuery** | 主对话（bidi 流） |
| AbortGeneration | 中止生成 |
| DetectImageText / DecomposeImage | 图片文字/分解（OCR 类） |
| GenerateImages / EditImage / SaveEditedImage / DownloadGeneratedImage | 图像生成/编辑/下载 |
| ListConversationTurns / GetConversationMetadata / SearchConversationHistory | 会话管理 |
| ListConversations / BranchConversation / CreateSharedConversation | 对话树/分享 |
| CheckFactuality / CheckGeminiQuota / GetUserStatus / GetUserCohort | 事实性/配额/用户状态 |
| ListProjects / CreateProject / ListProjectSources / AddProjectConversation | 项目（Notebooks 系） |
| ListSkills / CreateSkill / UpdateSkill / SetSkillEnabled | 技能 |
| ListRemyGoals / UpdateRemySchedule / ConfirmTask / PauseTask | Remy（Agent 任务） |
| GetAvailableVoices / GetVmSettings / SaveVmProfile | 语音/Live |
| GetStorageQuota / ListCollections / SetCollectionVisibility | 存储/集合 |

---

## 3. 上传层（3 条独立管道，全部已定位到类）

| 类 | 端点 | 方法 | Push-ID | 租户 | Authorization | 用途 |
|---|---|---|---|---|---|---|
| `Lbzuv.a/b`（classes.dex） | `push.clients6.google.com/upload/` | POST | `feeds/mcudyrk2a4khkz` | **`bard-storage`** | — | **Gemini/Bard 附件上传（主用）** |
| `Lcoxj.a`（classes6.dex） | `push.clients6.google.com/upload/` | POST | `feeds/kxlwurp47nhro2` | `saves` | `Basic c2F2ZXM6cyNMdGhlNmxzd2F2b0RsN3J1d1U=`（`saves:...`） | 图片上传（返回 blob id） |
| `Lcvjc` / `Lcxyb`（classes6.dex） | `content-push.googleapis.com/upload/` | PUT | `feeds/loa3rt3fvy5xx7` | — | `Basic KHJvSjQpYkEkMV4tSmUhYTp0MTE1Vi03cjM0WWRJJWha` | 图片上传（image/jpeg，`X-SafeSearch`、`Cookie`） |

- 其他头：`X-Tenant-Id`、`X-Client-Pctx`、`Cookie`、`Content-Type`
- 上传结果 = **blobId**（证据：`Failed to preprocess file for blobId %s`、`BlobId(blobId=`）
- 附件在请求里的引用字段：`attachment`、`attachments`、`attachmentType(s)`、`attachmentUris`、`fileContentUri`、`fileName`、`fileSizeKb/Mb`、`mimeType`（toString 字段名，见 §4.2）
- ⚠️ 与 README 既有认知对齐：**`push.clients6.google.com` + `X-Tenant-Id: bard-storage` 是正解**（`Lbzuv` 证实）；web 网关的 `content-push` 用法在移动端另有其用途（图片系）。

---

## 4. 消息层（proto 轮廓）

### 4.1 已知类型（`com.google.assistant.mobile.robin.proto.*`，来自 Kotlin 元数据签名）

```
streaming.ProcessQueryRequest       ← 主请求（bidi 流）
DeviceContext                       ← 设备上下文
ClientTriggerType                   ← 触发类型
RobinBardModeConfig                 ← 模型/模式配置（模型选择器数据源）
ClientBusinessProfile / ClientProjectIcon / ToolConsentPreference
GeneratedImage / punt.Punt / discovery.SuggestionData
session.SessionInput / session.AudioInputChunk   ← 会话输入/音频分块（Live）
```

注：这些 Java 类被 R8 混淆（原名仅存于 Kotlin 元数据字符串），反推字段编号需按 §5 路线进行。

### 4.2 字段名金矿（toString 片段，共提取 11,070 个字段名 → `out/names/toString-fields.txt`）

关键附件/视频相关字段：

```
allowVideoAttachment        ← 视频附件开关（UI/配置层）
areAttachmentsEnabled / attachmentPickerType / attachmentTypes
attachment / attachments / attachmentType / attachmentState / attachmentUris
attachmentUploadTransitionHandler / canRemoveUploadedAttachments / blockAttachments
allowUseUploadedImageBytes / allowedFilesConfig / attachmentFile / attachmentSender
fileContent / fileContentUri / fileName / fileSizeKb / fileSizeMb / fileExtension
blobId / clientFileGroup / mimeType / enableEphemeralVideo
bardModeConfig / bardModeConfigList / bardModeId / allowedRobinOps
```

### 4.3 视频门控信号（与本项目靶心直接相关）

| 证据 | 位置 | 解读 |
|---|---|---|
| `RESTRICT_IMAGE_UPLOAD` / `RESTRICT_NON_IMAGE_UPLOAD` / **`RESTRICT_VIDEO_UPLOAD`** | classes2.dex 枚举族 | **服务端可下发的上传限制枚举**（每模型/每模式） |
| `video_upload_restricted` | classes12.dex | 限制触发时的状态 |
| `apollo_video_attachment_consent_dialog_counter` | classes.dex 遥测 | 视频附件特性代号 = **Apollo**（含用户同意弹窗） |
| `VideoAttachment(id=` / `VideoMeta(duration=` / `VideoTrimmer*` | classes12.dex | 视频附件消息 + 本地裁剪 UI |
| `Video duration limit reached` / `VideoDurationLimitExceededException(maxDuration=` | classes12.dex | 时长限制逻辑 |
| `VIDEO_UPLOAD` / `LIVE_CONVERSATION_VIDEO_UPLOAD` | classes2/8.dex 大枚举 | 能力/入口枚举 |

**推论（待验证）**：移动端 ≠ 客户端写死视频能力，而是**服务端通过 mode config 下发**（`RESTRICT_VIDEO_UPLOAD` 不出现时即可上传）。
这与「web + argon 无视频、移动端 + argon 有视频」吻合——**同一账号同一模型，差异在客户端拿到的配置 + 客户端能表达的请求结构**。

---

## 5. 消息层：扩展体系与附件链路 ✅ 本轮完成（字节码级证明）

### 5.0 工程基础设施：RawMessageInfo 字段表解码器（`tools/fieldmap.py`）

javajlite 把每个 message 的字段表压进一个 **info 字符串**，由 `dynamicMethod()` 里的
`newMessageInfo(默认实例, info, objects[])` 注册。解码器要解决三件事：

**① info 字符串是 13-bit/char 变长整型**（UTF-16 码元序列）

```
c < 0xD800           → 单值
c ≥ 0xD800（续接标记）→ value = c1&0x1FFF | (c2&0x1FFF)<<13 | … | last<<shift
```

头部顺序：`flags(bit0=proto2,bit1=messageSet,bit2=editions) fieldCount oneofCount hasbitsCount
minField maxField numEntries mapCount repeated checkInitSize`，随后每字段
`fieldNumber fieldTypeWithExtraBits [oneofIndex | hasBitsIndex]`。
附加位 `0x100=required / 0x200=utf8 / 0x400=checkInit / 0x800=legacyClosedEnum / 0x1000=hasHasBit`；
类型低 8 位 `0..17` 单值、`18..34` LIST、`35..48` PACKED_LIST、`49` GROUP_LIST、`50` MAP、`≥51` = `ONEOF_OFFSET(51)` 偏移。

> ⚠️ **致命陷阱：DEX MUTF-8 的孤立代理码元**。续接标记正好落在 D800–DFFF，
> DEX 允许以「CESU-8 风格 3 字节 `ED xx xx`」编码孤立代理，Python 的
> `bytes.decode("utf-8")` 会判非法并替换成 `U+FFFD`，**直接毁掉 info 字符串**。
> `tools/dexlib.py` 因此提供 `mutf8_units()`（手写按码元解码，处理 `C0 80` 与 4 字节拆代理对）
> 与 `units_at(idx)`（按需取精确码元，不缓存全量省内存）。

**② objects[] 游标模型（本轮实证修正）**

```
objects 布局 = [oneof 段: oneofCount×2 项] [hasbits 段: hasbitsCount 项] [字段名/引用 逐项]
游标起点 pos = oneofCount*2 + hasbitsCount      ← ★ 关键
```

- oneof 段每 oneof 2 项（`value 字段名` / `case 字段名`）；一个 oneof 成员的**字段号 = case 值**
- hasbits 段是 **hasbits 位域本身的 Java 字段名**（如 `b`），每字一个
- 非 oneof 字段消费 1 个「Java 字段名字符串」
- `MESSAGE(9)/GROUP(17)` 在 javalite 下**不额外消费**（靠反射 `field.getType()`），
  故对象图需用「声明类型」回退补链
- `MESSAGE_LIST(27)/GROUP_LIST(49)` +1；`ENUM(12)/30/44` 在 proto2 或 closed 时 +1；`MAP(50)` +1（closed 再 +1）
- 有 HASBIT 且 `type ≤ 17` → 再读 hasBitsIndex

**③ 数据流：后向求值 + 序言回退**（本轮重写）

`dynamicMethod` 是编译器生成的 **switch 分发体**，`newMessageInfo` 段只是其中一个基本块。
线性前向跟踪会被**死分支**里的寄存器写污染 —— 实测 `Lgbku`：死分支的 `sget-object v5`
覆盖了序言的 `const/4 v5, #6`（该常量是「数组下标 6」的寄存器分组值），导致第 6 个名字丢失。

修正后策略：从每条指令**后向**扫到基本块首（遇 `return/throw/goto/if-*/switch` 即块首），
取「最近一次写」；块内无定义则回退到**序言值**（首个分支指令之前的前向状态）。

> ⚠️ DEX 记法 `B|A|op` 中 **A 恒为低半字节**（与 `const/4 vA, #+B` 一致）。
> `new-array vA, vB`（22c）的目标寄存器 = `byte & 0xF`，**不是** `>> 4`（本轮踩过并回退）。

**验证方法（`tools/validate_fieldmap.py`）**：判据 = 解码出的字段名必须命中该类的**声明字段表**
（字符串池有 60 万候选，单类声明字段仅 1–30 个，偏移错 1 位即不可能命中，故极灵敏）。
全量跑 **14,016 个消息类**：

| 游标模型 | 字段名命中率 | 失配类 |
|---|---|---|
| **A：`oneof*2 + hasbits`（已采用）** | **50,532 / 50,535 = 99.99%** | 3 |
| B：`oneof*2`（无 hasbits 偏移） | 34,808 / 50,535 = 68.88% | 11,730 |

仅剩的 3 个失配类（`Lgugb` / `Lvzb` / `Lgolh`）都是 **map 字段密集**类
（`MapEntryLite` 默认实例被寄存器复用导致个别槽未解析），**均不在 robin 链路内**，已记录为已知局限。

### 5.1 `Lgcvp`（ProcessQueryRequest）的 11 个扩展

`Lgcvp` 自身 **0 字段**，是 `ExtendableMessage`；载荷全在扩展。容器关系已逐个用
`<clinit>` 里的 `newSingularGeneratedExtension(容器默认实例, …)` 第一实参确认：

| ext | 值类型 | 字段 |
|---|---|---|
| **1000** | **`Lgcvm`** | `#1` MESSAGE · `#2` MESSAGE · `#4` MESSAGE · `#6` MESSAGE · `#8` ENUM · `#9` INT32 |
| 1001 | `Lgcvr` | `#1`/`#2` ONEOF\<MESSAGE\> |
| 1002 | `Lgcwh` | `#3`/`#4`/`#5` ONEOF\<MESSAGE\> |
| 1003 | `Lgcwr` | `#2`/`#3` ONEOF\<MESSAGE\> |
| 1007 | `Lgcvl` | `#1` ONEOF\<STRING\> + `#2`~`#5` ONEOF\<MESSAGE\> |
| 1008 | `Lgcxa` | `#2`~`#5` ONEOF\<MESSAGE\>（`#2`→`Lgcwz`） |
| 1009 | `Lgcva` | （空） |
| 1010 | `Lgcuz` | `#1`~`#3` ONEOF\<MESSAGE\> |
| 1011 | `Lgcwd` | `#1`/`#2` ONEOF\<MESSAGE\> |
| 1013 | `Lgcwn` | （空） |
| 1015 | `Lgcvf` | （空） |

### 5.2 `Lgcvm`（ext 1000）：**自身也是 ExtendableMessage**，另挂 9 个子扩展

`Lgcvm` 字段（6 个，注意 Java 名与 proto 号不一致）：

| proto# | 类型 | Java 字段 | 类型名 | 说明 |
|---|---|---|---|---|
| `#1` | MESSAGE | `d` | **`Lgauy`** | ★ 主载荷（见 §5.3） |
| `#2` | MESSAGE | `e` | `Lgcww` | 单 STRING 包装（prompt/文本） |
| `#4` | MESSAGE | `f` | `Lgatn` | 由入参 `Lgatn` 注入 |
| `#6` | MESSAGE | `g` | `Lgcvd` | **单 STRING**（blobId 引用候选） |
| `#8` | ENUM | `h` | `I` | 模式标志（实测取 1 或 2） |
| `#9` | INT32 | `i` | `I` | 实测 = `Lanvi.k` |

`Lgcvm` 的 **9 个子扩展**（⚠️ 与 `Lgcvp` 的 1000 系列**完全独立**，两层级都有 1000 号，极易混淆）：

| 子 ext | 值类型 | 说明 |
|---|---|---|
| 1000 | `Lgcwe` | `#1`/`#3` BOOL |
| **1001** | **`Lgcvb`** | `#1` MESSAGE→**`Lfzqy`** · `#2`/`#3` STRING — ★★ **附件信封** |
| 1002 | `Lgcwp` | `#1`/`#2` MESSAGE · `#3` INT32 |
| 1004 | `Lgcvk` | （空） |
| 1006 | `Lgcux` | `#1`/`#2` ONEOF\<MESSAGE\> |
| 1007 | `Lgcwx` | `#1` MESSAGE |
| 1008 | `Lgcuy` | `#1` MESSAGE |
| 1009 | `Lgcvs` | （空） |
| 1011 | `Lgcvj` | `#1` MESSAGE |

### 5.3 主载荷 `Lgauy`（22 字段，`Lgcvm.#1`）

| # | 类型 | Java | 目标 | # | 类型 | Java | 目标 |
|---|---|---|---|---|---|---|---|
| 1 | MESSAGE | `e` | `Lfzww` | 16 | STRING | `r` | — |
| 3 | MESSAGE | `j` | `Lgauw` | 18 | ENUM | `s` | — |
| 4 | ENUM | `f` | — | 19 | MESSAGE | `i` | `Lgyns` |
| 5 | ENUM | `k` | — | 20 | ONEOF\<INT32\> | `d` | oneof#0 |
| 6 | MESSAGE | `l` | `Lfzou`（int list） | 21 | ONEOF\<INT32\> | `d` | oneof#0 |
| 7 | STRING | `g` | — | 22 | ENUM | `t` | — |
| 8 | MESSAGE | `m` | `Lgaan` | 23 | STRING | `u` | — |
| 10 | MESSAGE | `n` | `Lgacs` | 24 | MESSAGE | `v` | `Lfysb` |
| 12 | MESSAGE | `o` | `Lgauv` | 25 | STRING | `w` | — |
| 14 | MESSAGE | `p` | `Lgarf` | 26 | STRING | `x` | — |
| 15 | MESSAGE | `q` | `Lgaux` | 28 | STRING_LIST | `h` | — |

### 5.4 ★★ 附件链路（Request 侧）—— 字节码级完整证明

```
Lgcvp                    (ProcessQueryRequest, 0 字段 ExtendableMessage)
 └─ [ext 1000] Lgcvm
     ├─ #1 Lgauy          ← 主载荷（prompt / 模型 / 能力）
     ├─ #2 Lgcww          ← 文本包装
     ├─ #4 Lgatn
     └─ [ext 1001] Lgcvb          ★ 附件信封（入参原样挂入）
         ├─ #1 Lfzqy              ★ 请求信封（63 字段）
         │   ├─ #1  Lgbkn         ★ 附件容器（9 字段）
         │   │   ├─ #3  MESSAGE_LIST → Lgbku   ★ 附件消息列表
         │   │   └─ #5  Lgbko
         │   │       └─ #2 Lfzms               ★ 附件包
         │   │           └─ #1 Lfzmr
         │   │               ├─ #1 string  ← uri.toString()
         │   │               └─ oneof d { #3 string | #4 Lgbku | #6 bytes }
         │   ├─ #13 Lgauy         ★ 主载荷（同一份）
         │   └─ …（另有 #16 Lgabj、#4 Lgaut、#46 Lfzfs 等）
         ├─ #2 string
         └─ #3 string
```

**证据 1 —— 容器归属**（`Lgcvb;<clinit>`）：

```
new-instance v1, Lgcvb;  →  sput-object Lgcvb;.a        // DEFAULT_INSTANCE
sget-object  v0, Lgcvm;.a:Lgcvm;                        // ★ 容器 = Lgcvm 默认实例
const/16     v4, #+1001                                 // ★ 扩展号 = 1001
invoke-static/range {v0..v6} Lgoep;.newSingularGeneratedExtension(…)
sput-object v0, Lgcvb;.b:Lgoen;                         // 扩展描述符
```

**证据 2 —— 信封挂载点**（`Lansi.i` @byte 2552，日志串自证 `"Send ProcessQuery initial …"`）：

```
[2542] sget-object v1, v0, Lgcvb;.b:Lgoen;              // ext 1001 描述符
[2552] invoke-virtual {v14, v1, v13}  Lgcvn;.b(Lgody;Ljava/lang/Object;):V
       // v14 = Lgcvn（Lgcvm builder 包装）  v13 = 入参 Lgcvb
       // ⇒ Lgcvm[ext 1001] = 调用方传入的 Lgcvb
```

**证据 3 —— 主载荷来源**（同一方法 @byte 2138–2508）：

```
Lfzqy env = v13.d;                       // 入参 Lgcvb.#1
if (env == null) env = Lfzqy.a;
Lgauy g = env.q;                         // Lfzqy.#13
if (g == null) g = Lgauy.a;
// —— 过滤 Lgauy.#6 = Lfzou（int 列表）：跳过枚举 oM / qd ——
for (Lfzot x : g.l) if (x != Lfzot.oM && x != Lfzot.qd) keep.add(x);
g.l = Lfzou.newBuilder().clear().y(keep).build();
…
m.d = g;  m.c |= 1;                      // Lgcvm.#1 = Lgauy
[2542] … m.f = v10;                      // Lgcvm.#4 = Lgatn
```

**`Lansi.i` 签名与语义**（唯一的"带附件发 ProcessQuery"入口，上游 = `Lansa.invokeSuspend`）：

```java
Lansi.i( Lgcvb 信封, Lapon prompt, Z, Z, Lgatn, Lgbjc, Lanvi, Lhcuk )
```

方法内会设置 `Lgcvp`[1001]`Lgcvr`、`Lgcvp`[1003]`Lgcwr`、`Lgcvp`[1000]`Lgcvm`，
并在 `Lgcvm` 上设置**全部 9 个子扩展**（1000/1001/1002/1004/1006/1007/1008/1009/1011），
最后 `req.b(描述符, 值)` + `req.a()` 得到 `Lgcvp` 送进双向流。

分支语义：`if (Lanvi v3 != null)` → `Lgcvm.#8 = 2` 且 `#6 = Lgcvd{ #1 = v8(String) }`
（疑似"已上传 blobId 直引"路径）；`else` → `Lgcvm.#8 = 1` 且 `#1 = Lgauy(信封内)` （信封路径）。

### 5.5 附件 proto 的构造

**`Lanmw.g(Uri, String, byte[], Laptg, Lapts) → Lfzms`**（唯一"从原始素材构造"点，语义可完整读出）：

```java
Lgoeh fzmsB = Lfzms.a.createBuilder();
Lgoeh fzmrB = Lfzmr.a.createBuilder();
fzmrB.copyOnWrite();  ((Lfzmr) fzmrB.instance).e = uri.toString();   // #1 = uri 字符串
if (v7 != null) Lgbmm.hm(Lanjc.f(v7), fzmrB);   // #5 = Lgbku（结构化文件消息）
if (v8 != null) Lgbmm.hl(Lanjc.f(v8), fzmrB);   // oneof case = 4 → #4 = Lgbku
if (v6 != null && v6.length != 0) {             // 原始字节
    x.c = 6;  x.d = Lgohx.e(v6);                //  oneof case = 6 → #6 BYTES
}
if (v5 != null) { x.c = 3;  x.d = v5; }         //  oneof case = 3 → #3 STRING
((Lfzms) fzmsB.instance).c = Lgbmm.hk(fzmrB);   // Lfzms.#1 = Lfzmr
```

> ★ **正交验证**：字节码里的 oneof case 常量 `3` / `4` / `6` 与 `fieldmap` 解出的
> `Lfzmr` 字段号 `#3` / `#4` / `#6` **完全一致** —— 两条独立路径互证。

挂载辅助（`Lgbmm`）：

| 方法 | 语义 |
|---|---|
| `hm(Lgbku, builder)` | `Lfzmr.#5(f) = Lgbku`（普通 MESSAGE 字段） |
| `hl(Lgbku, builder)` | `Lfzmr`[oneof `d`] = `Lgbku`（case 4） |
| `hk(builder)` / `hn(builder)` | `build()` → `Lfzmr` / `Lfzms` |

**`Lgbku`（11 字段附件消息）**：

| proto# | 类型 | Java | 目标 |
|---|---|---|---|
| 1 | MESSAGE | `c` | `Lgbkr` |
| 2 | STRING[UTF8] | `d` | — |
| 3 | STRING[UTF8] | `e` | — |
| 5 | MESSAGE | `g` | `Lgbks` |
| 7 | MESSAGE | `f` | `Lgcxf` |
| 10 | MESSAGE | `h` | `Lgadu` |
| 11 | MESSAGE | `i` | `Lgaef` |
| 12 | MESSAGE | `l` | `Lgbkt` |
| 14 | MESSAGE | `m` | `Lgadx` |
| 1000 | BOOL | `j` | — |
| 1001 | BOOL | `k` | — |

子消息：`Lgbkr{#1 String, #2 enum, #3 String, #4 enum, #5 String}`、
`Lgbks{#1 Lgaci{String}, #2 enum, #3 String, #4 String}`、
`Lgbkt{#1 Lgara}`、`Lgaef{#1 BYTES, #2 String, #3 enum}`。

**app 模型 → proto 字段映射**（`Lanjc.f`，按 instance-of 分派三种模型）：

| app 模型 | app 字段 | → proto 字段 |
|---|---|---|
| `Lapts` | `.c .g .k .b .l` | `Lgbkr` |
| `Lapts` | `.d` / `.e` | `Lgbku.#2/#3` 等 |
| `Lapts` | `.h` (`Lgadu`) | `Lgbku.#10 (h)` |
| `Lapta` | `.c .d .b .a .f .e` | `Lgbks{#1 Lgaci, #3, #4}` → `Lgbku.#5 (g)` |
| `Lapua` | `.a .b` | `Lgara` → `Lgbkt.#1` → `Lgbku.#12 (l)` |

**载体字段全集**（谁声明了这些类型，用于后续追溯）：
`Lfzms` ← `Lapui.ab`（app 输入模型）· `Lgbko.#2` · 自身
`Lgbku` ← `Lfzmr.#5` · `Lbdbm.#c/#d` · `Lgash.#1` · `Lgbwz.#4` · `Lgbxy.#1`
`Lgbko` ← `Lgbkn.#5` · `Lgbxs.#1` · 自身

### 5.6 ⚠️ 本轮**证伪**的假设（务必替换旧记录）

| 旧假设 | 实际 |
|---|---|
| 附件走 `Lgcvp[ext 1008] → Lgcxa.#2 → Lgcwz.#3 → Lfzms` | ❌ **证伪**。`Lgcwz` 的 oneof case 全 app **只被赋值为 `2`**（值类型 `Lgabj`，空消息），从未写入 `Lfzms`；`Lgcwz` 全 app 只有 2 个引用点（自身 `<clinit>` + `Lansi.g`）。`Lansi.g` 实为协程体，语义是 `"Send ProcessQuery device context update"` |
| `Lgcvm[ext 1004]` 与 `Lgabj` 相关 | `Lgcvm` 的 ext 1004 = `Lgcvk`（空消息）；`Lgabj` 是 `Lgcwz.#2` 的 oneof 值类型 |
| 两个层级的扩展号可混用 | `Lgcvp` 与 `Lgcvm` **各自独立**拥有 1000 系列号，**必须带层级前缀**（本文档统一写作 `层级[ext N]`） |

### 5.7 ★★★ 实机贯通：ProcessQuery 三步式（2026-10-15 23:xx 实证，**本文档最重要一节**）

> 本节全部结论来自**真实 gRPC 双向流实机探测**（`out/_initial-probe5..11.mjs`、`out/_e2e-test.mjs`），
> 与静态反汇编互相印证。协议层**已 100% 打通**，唯一剩余阻塞是账号级 ToS（见 §6.2）。

#### 5.7.1 ⚠️ **重大更正：请求消息就是 `Lgcvp` 本身，没有任何外层包装**

**此前 4 轮探测全负（永远返回 `First request should be 'initial'`）的根因就是这个包装层。**

| 证据 | 内容 |
|---|---|
| RPC 注册表铁证 | `classes2.dex / Lgbdm.cg`：`"assistant.mobile.robin.RobinService" + "ProcessQuery"` → 请求 `Lgcvp.a` / 响应 `Lgcvq.a` |
| `Lgcxj` 的位置 | 在整个 RPC 注册表**一处都没出现** —— 它**不是任何 RPC 的消息类型** |
| 后果 | 此前每帧外面多包一层 `Lgcxj{#1: Lgcvp}` → 服务端看到"未知普通字段 #1"，真正的 `ext1000(Lgcvm)` 被埋进子消息 → 判为"不是 initial" |

**结论**：gRPC 帧 payload = `Lgcvp` 直接序列化字节。`Lgcxj`/`Lgcxk` 是**其他** RPC 或内部中转用的容器类型，**不要用**。
（代码里保留了 `legacyLgcxjWrap()` 并标注 deprecated，仅作历史记录。）

#### 5.7.2 ★ 完整三步式发送协议（`Lansi` 状态机实证）

```
① initial   [mode=INIT_SENT]      Lgcvp[ext1000] Lgcvm{ #1 Lgauy{ #25 文本, #4 ClientType }, #2 Lgcww{ #1 文本 } }
② prefetch  [mode=PREFETCH_SENT]  Lgcvp[ext1007] Lgcvl{ #1: 查询文本 }        ← 文本真正落点
③ commit    [mode=COMMIT_SENT]    Lgcvp[ext1007] Lgcvl{ #2 空 }              ← 三连帧
                                  Lgcvp[ext1010] Lgcuz{ #2 空 }
                                  Lgcvp[ext1010] Lgcuz{ #3 空 }
```

| 步骤 | 状态机字段 | 实测帧长 | 缺省时的报错 |
|---|---|---|---|
| ① initial | `Lansi.i` → `"INIT_SENT"` | 48 B | `First request should be 'initial'`（若被包装）/ `ClientType is UNSPECIFIED or not provided`（若缺 #4） |
| ② prefetch | `Lansi.j` → `"PREFETCH_SENT"` | 22 B | 未 prefetch 直接 commit → `No prefetch query to commit.` |
| ③ commit×3 | `Lansi.f` → `"COMMIT_SENT"` | 各 5 B | — |

**★ `Lgauy.#4 = ClientType`（必需，且是 4 轮探测的解法关键）**
- 枚举 `Lgprd`：`0=UNSPECIFIED` / `1=IOS` / `2=ANDROID` / `3=OMNIENT` / `4=LENS`
- 缺失报 `ClientType is UNSPECIFIED or not provided`；给 `1/2/3/4` 后报错推进为
  `Either SpeechRecognitionFeature or PrefetchInputFeature is required` → 说明 #4 已被服务端识别
- `Lgprd` 枚举本身在 DEX 内只有 2 个引用点且都不在协议代码里 → **靠运行时扫描枚举字段（probe6，24 个候选中唯一命中）定位**

**★ `Lgcux`（`Lgcvm` ext1006）= AudioFeature —— 纯文本查询不要发**
- case1 = `use_speech`，case2 = `s3_preprocessed_audio`
- 发了会引入语音路径的服务端校验，把错误打回 `First request should be 'initial'`，
  掩盖真正的进展信号。

#### 5.7.3 ★ 服务端响应编码与结构

- **响应头 `grpc-encoding: gzip`**，帧压缩位 = 1，payload 以魔数 `1f 8b` 开头 → 必须 `gunzipSync`
- **initial ACK**：`Lgcvq[ext1000] Lgcvo{ #1 Lgavd{ #1: [244 个 packed int32] } }`
  - 对照实验（probe10，A1/A2/B/C 四组）：**ACK 内容与查询文本完全无关**（A1=A2=B 字节级相同），
    仅随 `ClientType` 变化元素数 → **判定为服务端下发的能力表 / 特性开关表**
  - 元素数：`ct=2(ANDROID) → 244 项 / 986 B`；`ct=1(IOS) → 242 项 / 978 B`
  - 收不到 ACK 说明 initial 没被接受 —— **这是最好的健康指示器**
- 业务错误经 `grpc-status=9` + `BardStatusException: <消息>` 返回（trailers 里）

#### 5.7.4 端到端验证结果（`out/_e2e-test.mjs`）

```
[e2e] 剧本：initial 48B / prefetch 22B / commit1-3 各 5B
[+ 2261ms] ← 响应帧 byExt=["1000"]   ← 能力表 ACK（244 项解析成功）
[+ 2989ms] ← 响应帧 byExt=["1003"]   ← 业务帧
grpc-status=9 | BardStatusException: Before proceeding, please accept our terms of service.
endedBy=server-end
```

**判定**：HTTP 200、帧收发正常、ACK 解析成功、服务端正常结束流 →
**协议层全线贯通**。剩余唯一阻塞已跃迁至**账号业务层**（ToS）。

#### 5.7.5 关键字段表（fieldmap 实测，供重建）

| 类型 | 字段 | 说明 |
|---|---|---|
| `Lgcvm` | `oneof=0 hasbits=1`；`#1 gauy #2 gcww #4 gatn #6 gcvd #8 ENUM #9 INT32` | `c` 是 hasbits 掩码，**#1/#2 可共存**（非 oneof） |
| `Lgauy` | 22 字段：`#4 ENUM(ClientType)` `#25 STRING(查询文本)` `#20/#21 ONEOF<INT32>` | — |
| `Lgcvl` | `oneof`：`#1 STRING` `#2/#3/#4 godw(空)` `#5 gcxi` | — |
| `Lgcuz` | `oneof`：`#1/#2/#3 godw(空)` | — |
| `Lgcvo` | `#1 gavd` | — |
| `Lgavd` | `#1 INT32_LIST_PACKED` | 能力表 |

**扩展注册表（实测扩展）**

| 层 | 扩展号 → 类型 |
|---|---|
| `Lgcvp` | `1000=Lgcvm` `1001=Lgcvr` `1002=Lgcwh` `1003=Lgcwr` `1007=Lgcvl` `1008=Lgcxa` `1009=Lgcva` `1010=Lgcuz` `1011=Lgcwd` `1013=Lgcwn` `1015=Lgcvf` |
| `Lgcvm` | `1000=Lgcwe` `1001=Lgcvb` `1002=Lgcwp` `1004=Lgcvk` `1006=Lgcux` `1007=Lgcwx` `1008=Lgcuy` `1009=Lgcvcs` `1011=Lgcvj` |
| `Lgcvq` | `1000=Lgcvo` `1002=Lgcwm` `1003=Lgcvc` `1004=Lgcwv` `1008=Lgcwv` `1012=Lgcxe` `1014=Lgcve` |

**解析技巧**：顶层出现 `field_no >= 1000` 即可判定"这是 `Lgcvq` 响应而非请求"（请求顶层是普通小字段号）。

#### 5.7.6 ★★ ToS 阻塞完整取证（只读，未接受）

> ⚠️ **本节更正了上一版记录的错误**：此前记「待接受版本 = "32"」是把探针打印的
> **十进制字节值 32** 误当成字符串。原始 hex 逐字节确认后，实际是 **`0x20` = 一个空格**。

**① `GetTermsOfServiceVersion` 响应逐字节（`out/_tos-hex.mjs` 抓取，grpc-status=0）**

```
0809                Lgahr.#1 = 9
1009                Lgahr.#2 = 9              ← ★ tosVersionNo
1a30                Lgahr.#3 = Lgbip (48B)
  0a 01 20            #1 = " "   ← 单空格哨兵 → 「有待接受项」
  2a 2b 6874747073…   #5 = "https://support.google.com/gemini?p=awb_phh"
22 d307             Lgahr.#4 = Lgavd (979B)  → 244 项 packed int32 能力表
```

| 结论 | 值 |
|---|---|
| **待接受版本号** | **`9`**（`Lgahr.#2`，应用侧日志 `"[FTBlocking] getTos succeeded, tosVersionNo=%d"` 正是打印此字段） |
| **待接受文档** | **Gemini 应用隐私信息中心** `https://support.google.com/gemini?p=awb_phh`（Google 官方隐私声明，2026-10-13 更新） |
| 待接受判据 | `Lgbip.#1` 非空（真机下发单空格哨兵）→ 应用日志 `"Terms of service available."` |
| 未接受判据 | `Lgahr.#2 <= 0` 或 `Lgbip.#1` 为空 → 应用日志 `"Terms of service are not available."` |

**② 应用侧判定逻辑（反汇编 `Latjy.invokeSuspend`，`Ma-Robin-Onboarding-CF` 协程）**

```
if (resp == null)                        → "Terms of service are not available."
if (resp.#2 <= 0)                        → 同上
if (len(resp.#3.#1) > 0)                 → "Terms of service available." → 走 accept 流程
else if (len(resp.#3.#4) <= 0)           → "Terms of service are not available."
else                                     → "Terms of service available."
```

**③ 接受请求 `Lfzky` 的完整构造链（反汇编实证）**

```
Latqm.h("Ma-RobinOnboarding")
  → Latwf(Latwj, tosVersionNo, Boolean, cont)            ← 传版本号
    → Latwc.e(int version, …)                            ← ★ 构造 Lfzky
        builder = Lfzky.DEFAULT_INSTANCE.createBuilder()
        #4  STRING ← Lbzva.a()  = 完整 User-Agent
                    "Mozilla/5.0 (Linux; Android {RELEASE}; Build/{ID}) AppleWebKit/537.36
                     (KHTML, like Gecko) Version/4.0 Chrome/{chromeVer}
                     Mobile Safari/537.36 GSA/{gsaVer}"
        #5  ENUM   ← Lfzwy.AGSA.getNumber() = 1
        #6  oneof<int32> ← version                        (oneof case 字段置 6)
        #7  MESSAGE ← Lgauy
        #8  BOOL   ← 来自数据采集状态 Future 结果
        #11 BOOL   ← flow 参数
        #12 MESSAGE ← Lgbiz{ #1=1, #2=[PARENT(1), CHILD(2)], #3=1 }
    → Latfi.a(Lfzky)                                      ← 以 RPC 名 "acceptTermsOfService" 发送
        （重试/退避由 Latdd.a 包装；失败日志
          "AcceptTermsOfService (Remy) failed; local state NOT persisted — will re-prompt next session"）
  → 响应 Lfzkz { #1 = Lgavd }

枚举：Lfzwy = {UNSPECIFIED:0, AGSA:1, IOPA:2, IGA:3, IGEM:4, WEAR:5, ANDROID_AUTO:6,
               CHROME:7, ANDROID_XR_GLASSES:8, ANDROID_GMM:9, ANDROID_XR_HEADSET:10,
               IOS_GMM:11, ANDROID_AUTO_EMBEDDED:12}
      Lgbiy = {AUDIENCE_UNSPECIFIED:0, PARENT:1, CHILD:2}
```

**④ ★ 已确认 ToS 是「账号级」，与客户端类型无关（`out/_ct-sweep.mjs` 实测）**

| ClientType | initial ACK 项数 | 服务端结果 |
|---|---|---|
| 1 `IOS` | 242 | `grpc-status=3 CommitControlFeature is missing in initial request` |
| 2 `ANDROID` | 244 | `grpc-status=9` ToS 错误 |
| 3 `OMNIENT` | 244 | `grpc-status=9` ToS 错误 |
| 4 `LENS` | 242 | `grpc-status=9` ToS 错误 |

→ 换客户端类型**不能**绕过 ToS（3 种类型同样报错），但**意外暴露了下一道门禁**：
IOS 路径要求 initial 帧声明 `CommitControlFeature`。这是一套「客户端必须显式声明 feature」的校验机制，
值得在 ToS 通关后优先验证（ANDROID 路径未报此项，说明必需 feature 集是**按 ClientType 分表**的）。

**⑤ 已交付代码**

| 文件 | 作用 |
|---|---|
| `service/lib/tos.js` | `buildGetTosRequest` / `parseTosResponse` / `buildAcceptTosRequest` / `buildLgbiz` / `parseAcceptResponse` / `gsaUserAgent` / `describeTos` |
| `out/_tos-probe.mjs` | 最简只读探针 |
| `out/_tos-hex.mjs` | 原始 hex + 字段树（终结歧义用） |
| `out/_tos-accept.mjs` | **默认干跑**；`--commit` 才真正发送 accept |
| `out/_ct-sweep.mjs` | ClientType 1..4 全扫对照 |

---

## 5.8 ★★★ 附件/媒体链路端到端打通（2026-10-15 深夜实证，probe35→40 + `_blue-verify`/`_audio-probe`/`_video-probe`）

> 本节**取代** 5.4/5.5 的纯静态推断：附件链路不再是"字节码级证明"，而是**服务端真实读取媒体内容**的端到端实证。

### 5.8.1 上传层（push.clients6，实证细节）

```
POST https://push.clients6.google.com/upload/
  content-type: application/x-www-form-urlencoded;charset=UTF-8
  x-tenant-id: bard-storage
  x-goog-upload-protocol: resumable
  x-goog-upload-command: start
  x-goog-upload-header-content-length: <字节数>
  x-goog-upload-header-content-type: <mime>
  push-id: feeds/mcudyrk2a4khkz
  （body 空体即可；**不需要 authorization 头**，实证 200）

→ 响应头 x-goog-upload-url: <uploadUrl>

POST <uploadUrl>
  content-type: application/octet-stream
  x-goog-upload-command: upload, finalize
  x-goog-upload-offset: 0
  push-id: feeds/mcudyrk2a4khkz
  （body = 文件字节）

→ 200，**响应体就是 blobId 字符串本身**（非 JSON），形如
   /contrib_service/ttl_1d/obegjwthkgxgtjxwn47h2ofppcganu1792073775    （TTL 1 天）
```

### 5.8.2 ★ 附件信封（实测可用最小形态）

```
Lgcvp[ext1000] Lgcvm[ext1001] Lgcvb {
  #1 Lfzqy {
    #1 Lgbkn {
      #3 Lgbku {                          ← 仅需这一个字段！
        #1 Lgbkr { #1 blobId, #3 mime, #4 枚举 },
        #2 name                            ← 可选
      }
    }
  }
}
```

装配即 `service/lib/pq.js` 的 `buildAttachmentEnvelope({blobId, mime, name, source})`，
注入方式：`buildProcessQueryRequest({ text, mode: 1, lgcvmExts: [{field: 1001, bytes: env}] })`。

**与静态推断的差异（务必以本节为准）**：
- `Lgbkn` 只需 `#3`（Lgbku repeated）；`#1`（Lanmw.h 的 URI 列表）、`#5`（Lgbko→Lfzms→Lfzmr）均**非必需**（带上也不错，probe40 C8）
- `Lfzqy.#13`（Lgauy 副本）**非必需**
- 旧假设「`Lgbku.#3 = base64(Lgbku)`」是 probe34 时代误判，**删掉照样跑**（C3）
- 附件内容**不发原始字节**（`Lgbku.#10 Lgadu` 路径已废弃）——服务端按 blobId 回源读取

### 5.8.3 C 矩阵（probe40，纯蓝 64×64 PNG，「这张图片是什么颜色的？」）

| 用例 | 配置 | 服务端结果 |
|---|---|---|
| C1 | 全字段（blobId+mime+e4+name+b64空） | ✅「这张图片是蓝色的。」 |
| C2 | 去掉 `#2 name` | ✅ 识别蓝色 |
| C3 | 去掉 `#3 b64(空Lgbku)` | ✅ 识别蓝色 |
| C4 | 去掉 `Lgbkr.#4` 枚举（默认 0） | ✅ 识别蓝色 |
| C5 | 去掉 `Lgbkr.#3 mime` | ✅ 识别蓝色 |
| C6 | **去掉 `Lgbkr.#1 blobId`** | ❌ `grpc=13 Dependency RPC failed` |
| C7 | 最小 = 仅 `Lgbkr{#1 blobId}` | ✅ 识别蓝色 |
| C8 | 完整 app 信封（Lgbko+Lfzms+Lgauy） | ✅ 识别蓝色 |

⇒ **blobId 是唯一硬必需字段**；mime/枚举/name 强烈建议携带（帮服务端选解析器）。
交叉验证：上传的 PNG 解码为纯蓝 RGB → 服务端答"蓝色" → 非幻觉。

### 5.8.4 `Lgbkr.#4` 枚举语义（`Lbcsn.a(mime)` 客户端映射 + 服务端实测）

| 枚举 | 客户端映射（Lbcsn.a） | 服务端实测 |
|---|---|---|
| 0 | UNSPECIFIED（默认分支兜底） | 不报错但**不处理**（音频场景） |
| 1 | image/*（png/jpeg/webp/heic/heif） | ✅ 图片✅音频 |
| 2 | text/csv | ❌ Unsupported file source |
| 3 | google-apps.spreadsheet | ❌ Unsupported file source |
| 4 | image/avif | ❌ Unsupported file source |
| 5 | xlsx/xls | ✅ 音频 |
| 6 | video/mp4 | ⚠️ 视频（`_video-probe`）；音频❌ |
| 7 | application/pdf | ✅ 音频 |
| 8 | text/plain | ⚠️ 报"无法识别或解析"（音频场景） |
| 9 | rtf/msword | ✅ 音频 |
| 10 | docx | ❌ Unsupported file source |
| 11 | google-apps.document | ❌ Unsupported file source |
| 12 | **audio/\*（推断，实证确认）** | ✅ 音频（`_audio-probe` 主答案） |
| 13/14/15/16/20 | hwp/pptx/odt/presentation/vorbis | 未逐一实测（推断同拒绝集） |

**按内容类型选枚举**：image→1，audio→12，video→6，pdf→7，text→8，doc→9，excel→5。
`service/lib/pq.js` 的 `fileSourceOf(mime)` 已实现该映射。

### 5.8.5 音视频实证结果

| 媒体 | 文件 | 上传 mime | e4 | 服务端应答 |
|---|---|---|---|---|
| 图片 | 64×64 纯蓝 PNG（132B） | image/png | 1 | 「这张图片是蓝色的。」 |
| 音频 | 8kHz 8bit 440Hz×0.7s WAV（8044B） | audio/wav | 12 | 「这是一通电话拨号时的铃声或呼叫音。」 |
| 视频 | 64×64 纯绿 2s MP4（20646B，h264+aac） | video/mp4 | 6 | ✅「这个视频的画面主要是绿色。」（e4∈{6,12,1,5,7,9} 全部识别成功） |

⇒ **用户目标 1「音视频请求成功」已达成**：图片✅ 音频✅ 视频✅ 三类媒体全部端到端实证（2026-10-15 深夜）。

---

## 5.9 ★ Function Calling：prompt 仿真兼容层（2026-10-16 实证）

### 5.9.1 结论：协议层无工具声明位，兼容层五场景全过

对 `Lgcvp` 全部扩展（11 个）+ `Lgcvm` 子扩展（9 个）+ `Lgauy`（22 字段）逐一排查，
**没有任何字段可承载工具/函数声明**（App 是消费级通道，工具声明是 AI Studio 侧能力）。
直接丢弃 `tools` 的后果实测：模型凭自身知识幻觉作答（问"北京天气"→ 编造 15°C 多云，
`functionCall=0` 且无任何报错）——**静默错误答案**。

### 5.9.2 方案：prompt 仿真（移植自 gemini_web2api）

底层模型是同一个 Gemini，工具能力在模型侧，缺的只是"声明位"。故用提示词约定格式：

```
请求侧：tools[].functionDeclarations → "# Tool Use" 提示词块（序列化 JSON schema）
        + 约定输出格式：```function_call\n{"name":"<tool>","args":{…}}\n```
        + toolConfig 约束（AUTO/ANY/NONE + allowedFunctionNames）
历史侧：functionCall part → 围栏标记；functionResponse part → [Tool result for …]: {json}
响应侧：解析围栏块（围栏/无围栏/raw JSON 三形态 + 括号深度扫描 + 白名单）→ functionCall parts
```

实现：`service/lib/toolcall.js`；请求侧接线在 `gemini.js:geminiToRobin`，
响应侧在 `app.js`（非流式直接回填；流式在工具模式下缓冲→解析→输出，防围栏泄漏）。

### 5.9.3 真实通道实测（`out/_tools-emulation.mjs` / `out/_tools-loop-verify.mjs`）

| 场景 | 结果 |
|---|---|
| 单工具（问天气） | ✅ `functionCall{get_weather,{city:北京}}`，围栏零泄漏 |
| 多工具选择（天气 vs 搜索） | ✅ 正确选 `get_weather` |
| 并行调用（问两个城市） | ✅ 单响应 2 个 `functionCall`（北京 + 广州） |
| 闲聊（无需工具） | ✅ 纯文本，零误报 |
| 工具循环（`functionResponse` 历史） | ✅ 判定性复测：荒谬值（99°C 火星沙尘暴 / -120°C 极夜永冻）被完整消费并据此推理 |

### 5.9.4 已知边界

1. **依赖模型遵循格式**：偶发不遵循时退化为纯文本（调用方按无工具处理），不比静默幻觉更糟；
2. **服务端账号级会话可能串扰**（见 §6.3-3）：工具结果以 `[Tool result for …]` 显式标记为准，
   实测标记优先于会话记忆（荒谬值复测通过；同场次问过真实天气时模型曾混入自身知识，
   多用户共用场景需关注）；
3. `googleSearch` / `codeExecution` 等内置工具同样走此路径（SDK 会把它们放进 `tools[]`）。

---

### 5.10 会话绑定机制（2026-10-16 实证推翻旧结论）

旧结论曾认为 ProcessQuery 请求携带某个"会话 ID"字段、`Lfzww/Lapui` 是会话状态载体。
本次用 **隔离对照实验**（`out/_conv-isolation-verify.mjs`）直接证伪：

| 观察 | 结论 |
|---|---|
| 客户端从未发送任何会话 ID，但响应总是带回 `conversationId` | ID 由**服务端生成** |
| 不带历史的相邻两次查询，拿到的是**不同的** conversationId（`c_885f…` / `c_e896…`） | 服务端为每个不带 ID 的 ProcessQuery **新建会话** |
| 不带历史追问上一轮的暗号，模型答"我们之前并没有约定过任何暗号" | 相邻请求间**没有必然的上下文延续** |
| `DeleteConversation`（`Lgaaz{ #1 string conversationId, #2 Lgauy }`）返回 `grpc=0` | 会话可被服务端按 ID 删除 |

⇒ **会话 ID 全程由服务端下发；客户端无法指定，只能通过"不传"让服务端新建，
或在请求后删除来销毁。** 客户端侧不存在"继续某个会话"的能力。

> ⚠️ 仍有边界未明：本轮对照实验中"短期暗号"未泄漏，但更早的观测
> （`_multiturn-tools.mjs`）曾出现跨请求命中的情况。可能与 Gemini 账号层的
> **长期记忆/个性化（memories）**有关——那属于账号设置而非单次会话，
> `DeleteConversation` 无法消除。见 §6.3。

**延迟注意**：同一 HTTP/2 session 上发的 unary RPC，服务端发完 trailers 后
不会立刻触发本端 `end/close` 事件——必须**在 trailers 到达即判定完成**，
否则每次调用都会空等到超时上限（实测 10s vs 修复后 1.0~1.7s）。

---

## 5.11 会话隔离：会话 ID 由服务端下发，客户端不可指定（2026-10-16）

### ✦ 重大澄清（推翻此前的“客户端可指定会话 ID”假设）

此前假设存在某个“会话 ID”请求字段、可以由客户端指定要继续哪个会话。
**本次实证推翻**：

| 观察 | 证据 | 结论 |
|---|---|---|
| 客户端从未发送会话 ID，响应却总是带回 `conversationId` | `Lfzrc.#2 Lgavc.#1`（`extractResponse` 已在读） | ID 由服务端生成下发 |
| 不带历史的相邻两次查询拿到**不同的** cid | 实测 `c_885fc1a2…` / `c_e896cfb8…`，隔离组亦然 | 服务端为每个不带 ID 的 ProcessQuery **新建会话** |
| 不带历史追问上一轮暗号 | 隔离关时仍能复述 | 泄漏不是“续同一个会话”，而另有机制（见 §6.3） |
| 调用 `DeleteConversation` 后再次追问 | ✅ 不再泄漏 | 服务端会话能被按 ID 销毁 |

⇒ **会话生命周期完全由服务端掌握**：客户端既不能指定要续哪个会话，
也无法阻止服务端新建；能做的只有在请求**之后**删掉它所创建的那个。

### `DeleteConversation` —— 请求/响应与调用效果

反推路径：`out/robin/rpc-msg-map.txt` → `F DeleteConversation req=Lgaaz; resp=Lgaba;`
再 `tools/protoreach.py --root "^Lgaaz;$"` 得到字段表：

```
Lgaaz                              ← 请求消息
  #1  STRING   "c_e495ac0c4f798273"   会话 ID（来自 ProcessQuery 响应）
  #2  MESSAGE  →Lgauy                 与 ProcessQuery 完全同款客户端上下文
      Lgauy
        #1  MESSAGE →Lfzww     (#1 ENUM, #2 BOOL)
        #3  MESSAGE →Lgauw     (#1 STRING …)
        #4  ENUM    ClientType  ★ 必需，ANDROID = 2
        …
```

调用方式：与普通 unary gRPC 相同（`POST /assistant.mobile.robin.RobinService/DeleteConversation`，
`application/grpc` 单帧 + `Bearer <token>`），**实测 `grpc-status=0`** ⇒ 删除成功。
后续再删同一个 ID 仍返回 0（幂等）。

### ⚠ 工程陷阱：同 session 的 unary RPC 必须“trailers 即完成”

服务端发完 trailers 后**不会立刻触发本端 `end`/`close` 事件**。若按常规写法
（`await end`）等待，每次调用都会空等到超时上限：

| | 修复前 | 修复后 |
|---|---|---|
| 单次 `DeleteConversation` 耗时 | 10~15s（每次都撞超时） | **1.0~1.7s** |

修复：在 `stream.on("trailers")` 里取到 `grpc-status` 后立刻 `stream.close()` 并 settle。

### 用途与边界

- ✅ 消除服务端会话留存（合规/隐私），并切断会话层的上下文延续；
- ❌ **不能**消除账号层的长期记忆/个性化（`memories`）——那属于 Google 账号设置，
  见 §6.3；要真正关闭需在 Gemini App / Google 账号侧操作。

---

## 5.12 ★ 客户端字段别名大小写（SDK 版本差异，2026-10-16 实证）

**现象**：同一份代理代码 + 同一份测试脚本，**本地（Windows）图片识别正常，生产（Linux）一致失败**，
且模型答的是「题目中并没有实际提供图片内容」——没有报任何错。

**抓包定位**：在生产的 venv 里 monkeypatch 出站的 HTTP 层（起一个本地 echo server 接收请求），
拿到 SDK 真正发出的字节：

```json
{"contents":[{"role":"user","parts":[
  {"text":"这张图片是什么颜色的？只回答颜色名"},
  {"inlineData":{"data":"iVBORw0KGgo...","mime_type":"image/png"}}
]}]}
```

⚠️ 外层键是 `inlineData`（camelCase），**内层 `Blob` 的 `mimeType` 却被序列化成了 snake_case 的
`mime_type`**。而代理只读 `p.inlineData.mimeType` ⇒ `undefined` ⇒ 退化成 `application/octet-stream`
⇒ 服务端按错误类型解码 ⇒ 模型看不到媒体。

**根因**：`google-genai` 版本差异 —— 生产 `.venv` 是 **2.28.0**，本地系统 Python 是 **2.6.0**，
新版的 `Blob` 在序列化路径上丢了 alias。

**修复**：`lib/gemini.js` 引入 `alias()` 助手，所有读取客户端字段的地方一律 camelCase / snake_case 双认：

| 字段 | 兼容的键名 |
|---|---|
| 内联媒体 | `inlineData` / `inline_data` |
| 媒体 MIME | `mimeType` / `mime_type` |
| 文件引用 | `fileData.fileUri` / `file_data.file_uri` |
| 系统指令 | `systemInstruction` / `system_instruction` |
| 工具配置 | `toolConfig.functionCallingConfig` / `tool_config.function_calling_config` |
| 工具白名单 | `allowedFunctionNames` / `allowed_function_names` |
| 工具历史 | `functionCall` / `function_call`、`functionResponse` / `function_response` |

> 这与 §六「不静默丢弃」是同一条原则：解析不到就该显式失败，而不是悄悄降级成
> 一个"看起来正常但答案是编的"的响应。

---

## 5.13 ★★★ 思考强度（thinking level）—— 2026-10-16 逆向定案 + 线上实证

### 5.13.1 结论（一句话）

思考档位**不写在 `Lgauy` 里**，而写在**信封 `Lfzqy` 的 `#48`（INT32）**；
承载路径 `Lgcvp[ext1000]Lgcvm[ext1001]Lgcvb.#1 Lfzqy.#48`。
这与「模型档位」`Lgauy.#16`（mode id）是**两个正交维度**，前者决定"用哪个模型"，后者决定"想多久"。

> ⚠️ 这也解释了为什么对 `Lgauy` 全部 22 个字段（含 `#5`/`#18`/`#22` 三个自由枚举）反复扫描
> 全部无果 —— 靶子根本不在那个对象上。

### 5.13.2 取证链（字节码级，可复现）

**第一段：发送侧写入路径**（`Lanmw.c`，即"发消息"协程）

```java
// 同一个请求构建器 Lfzqz 实例，连续四次 setter
Lalmv.a()  → Lfzqz.O(int)      // rank
Lalmv.d()  → Lfzqz.E(String)   // 显示名
Laloi.a()  → Lfzqz.P(int)      // ★ 思考档位值
Laloi.b()  → Lfzqz.S(String)   // ★ routingVariantId
```

**第二段：setter 落到哪个字段**（`Lfzqz.{O,P,E,S}` 反汇编 + hasbits 算术）

四个 setter 都是同一形态：`or hasBits1 标记位` + `iput 数据字段`。

| setter | 标记位（`Lfzqy.c` = hasBits1） | → hasbit 索引（32+n） | `Lfzqy` 字段 | 语义 |
|---|---|---|---|---|
| `O(I)` | `1<<11` = 2048 | 43 | `#47 R` INT32 | rank |
| **`P(I)`** | **`1<<12` = 4096** | **44** | **`#48 S` INT32** | ★ **思考档位值** |
| `E(String)` | `1<<13` = 8192 | 45 | `#66 T` STRING | 显示名 |
| **`S(String)`** | **`1<<14` = 16384** | **46** | **`#67 U` STRING** | ★ routingVariantId |

> 三重吻合验证：`hasbits1 位序 + 32 = fieldmap hasbit 索引` ✓；fieldmap 字段号一致 ✓；
> getter `a()→R` / `b()→S` / `g()→T` / `h()→U` 与实际字段一致 ✓。

**第三段：值从哪来**

```java
// Lbejo.a（模式选择器 UI 点击协程）
Laoeq q = ((Laoee) state).a().b;          // 模式选择器 UI 模型
Laotd mode = q.N;                          // 模式
Lalmu mu = new Lalmu(mode, q.O, q.P);      // (模式, int, String) —— requested
Laloi id = new Laloi(q.Q, q.R);            // ★ (档位值, routingVariantId) —— resolved
new Lbeje(q.a, mu, id, gps);

// Lalsq.g(int, boolean, String, Lgaps, Lhcuk) 是唯一"只改档位"的入口
//   → 在 insn+8 构造 Laloi(档位值, routingVariantId) → Lalsn → Lalsm DataStore
```

`Laloi` 是**普通 Java 类**（非 proto），日志里叫 `ThinkingLevelId`：
`Laloi{ #1 int value, #2 String routingVariantId }`，`toString()` 产出
`ThinkingLevelId(value=…, routingVariantId=…)`。

**第四段：档位定义表（服务端下发）**

Apollo flag `launch_ultra_mode_pro_policy` → `Lgaic.#34 Lgawz`：

```
Lgawz { #1 STRING "launch_ultra_mode_pro_policy", #2 MESSAGE_LIST Lgawx[], #3 Lgawy }
Lgawx { #1 Lgaww（模式展示卡）, #2 MESSAGE_LIST Lgbdp[]（档位选项）, #3 INT32, #4 ENUM_LIST_PACKED }
Lgbdp { #2 STRING 名称, #3 STRING 描述, #4 INT32 ★档位值, #5 BOOL, #6/#7 STRING 两段标签, … }
Lgaww { #3 INT32 rank, #6 短名, #7 描述, #14 展示名, #17 ENUM, #18 STRING = "Thinking level"（UI 标签） }
```

实测（本账号 4 个模式**各自**都有完整三档）：

| 档位 | `Lgbdp.#4` | `Lgbdp.#3` 描述 |
|---|---|---|
| Low | **1** | Quick and efficient |
| Medium | **4** | Balanced depth |
| High | **2** | Extra thorough |

> ⚠️ 注意是 **1 / 4 / 2**，不是直觉上的 1/2/3 —— 不要按序数推断。

**第五段：`routingVariantId` 的真相**

`Lgaww.#16 Lgaxb{ #1 ENUM, #2 STRING }` 是设计上的 routingVariantId 承载位
（`Lalmv.c()` 就是读它，`Lalmv.e()` = 该字段是否存在 = "本模式是否支持档位"），
但**本账号的 Apollo 策略里该字段为空**；全量扫描 `Lgaic`（22 个顶层字段、528 条可打印字符串）
确认响应里**只有 4 个 16 位 hex 串，即 4 个 mode id 本身**，不存在独立的 routingVariantId。

⇒ 实践中 `#67` **留空**。实测把它填成 mode id 会让上游回 `"Used Legacy model"` 并**中断流**
（`NGHTTP2_INTERNAL_ERROR`）—— 属于"填错比不填更糟"的字段。

### 5.13.3 线上实证（`out/_think-envelope.mjs`，Argon 通道）

| 发送 | `Lfzrc.#30` 上游自述 | `Lfzrc.#42` 回显 | 耗时 |
|---|---|---|---|
| **不发 `#48`** | `Used 4 Argon model` | **1** | 21960 ms |
| `#48=1` (Low) | `Used 4 Argon model` | **1** | 15554 ms |
| `#48=4` (Medium) | **`Used 4 Argon Medium model`** | **4** | 15094 ms |
| `#48=2` (High) | **`Used 4 Argon High model`** | **2** | 22807 ms |
| `#48=2` + `#67`=modeId | `Used Legacy model` ❌ 断流 | 2 | 6313 ms |

**三重互证**：
1. `Lfzrc.#42` **逐字等于**请求发送的 `#48` 值 ⇒ 该字段就是档位回显（默认 1）；
2. 上游自述模型名带上了 `Medium` / `High` 后缀 ⇒ 档位真正参与路由；
3. High 耗时 22.8s 显著长于 Low 15.6s ⇒ 行为层一致（想得更久）。

**两条重要推论**：
- **不发 `#48` = 服务端按 Low(1) 处理**（`#42` 回显 1，与显式 `#48=1` 完全一致）；
- Low 档**不改变**上游自述名（仍是 `Used 4 Argon model`），Medium/High 才有后缀
  ⇒ 若以模型名做判据，Low 与"未指定"不可区分，需看 `#42`。

### 5.13.4 实现（`service/`）

| 层 | 位置 | 说明 |
|---|---|---|
| 协议构造 | `lib/pq.js` `buildLfzqy({ thinkingLevel, routingVariantId, rank, displayName })` | `#47/#48/#66/#67` |
| 信封合并 | `lib/pq.js` `buildProcessQueryRequest({ thinkingLevel })` | 档位与附件**共用一个 `Lfzqy`**（singular 扩展重复设置会互相覆盖） |
| 参数映射 | `lib/modes.js` `THINKING_LEVELS` / `parseThinkingLevel` / `splitThinkingSuffix` | low=1 / medium=4 / high=2 |
| HTTP 接线 | `lib/app.js` | 见下方三种传参方式 |

对外支持**三种等价写法**（显式参数优先级高于模型名后缀）：

```jsonc
// 1) Gemini 原生风格（推荐）
{ "generationConfig": { "thinkingConfig": { "thinkingLevel": "high" } } }
// 2) 简写（camel / snake 双认，见 §5.12）
{ "generation_config": { "thinking_level": "medium" } }
// 3) 模型名后缀（无需任何 generationConfig）
POST /v1beta/models/4-argon-high:generateContent
```

非法档位（如 `"ultra"`、`3`）**一律忽略并回落默认**，并打 `[thinking]` 警告 ——
不猜测、不误发（与 §6「不静默丢弃」同一条原则）。

档位名做了一处**别名**而不是新增档位：`minimal` → `low`。
理由是 Gemini 公开 API 的 `ThinkingLevel` 枚举含 `MINIMAL`（部分 SDK 版本），
而下游（Eidolon）的取值域是 `minimal|low|medium|high|max`；把它当未知值忽略会
产生无意义的告警，映射到最低档才是语义正确的做法。
> 注：`max` 不需要映射 —— Eidolon 的 `_get_thinking_config` 已自行归一为 `high`。

**测试**：单测 32 组（含 10 条思考强度断言：承载位字段号 / 附件单信封共存 / 非法值不静默）；
e2e 32 组（含 6 条：三种写法到达上游 mock + 附件共存 + 未指定不发）；
真机 `out/_think-svc-verify.mjs` 走代理自身路径验证 5 种组合。

---

## 5.14 ★★★ 档位承载位定案 + 音频互斥（2026-10-17 实测，**推翻本章旧结论**）

> ⚠️ 本章 2026-10-16 的旧结论（"档位必须放信封 `Lfzqy.#13`、放 `#1` 会让信封整包失效"）
> **已被证伪**。旧结论把「档位被忽略」误读成「信封被忽略」，进而做出了错误的反向修改 ——
> 那次修改的净效果是**让所有带思考强度的请求静默降级到 3.5 Flash-Lite**。
> 下面全部以 2026-10-17 的变体矩阵实测为准。

### 5.14.1 结论（三句话）

1. **档位 `#16` 只有在 `Lgcvm.#1 Lgauy` 里才会生效**；放进 `Lfzqy.#13` 会被服务端
   **整包忽略该 `Lgauy`**，档位静默回落到账号默认（实测恒为 `3.5 Flash-Lite`、rank 6、`#25` 缺席）。
2. **思考强度 `#48` 在 `Lfzqy` 里两种形态都生效**（与档位落在哪里无关）。
3. **⚠️ 音频附件与档位互斥**：携带音频时，Argon 路径**读不到音频**
   （模型答"没有收到录音文件"）；只有把档位退让到 `#13`（即降级 Flash-Lite）才听得到。
   **图片不受此限** —— 档位在 `#1` 时图片照常被采纳。

### 5.14.2 判别证据（变体矩阵，同账号、同出口、全部请求 `4-argon`）

**无附件**（`out/_voice-test/mode-carrier-probe.mjs`）：

| 变体 | `#16` 位置 | `#48` | `#30` 上游自述 | `#41` rank | `#25` 生效档位 | `#42` |
|---|---|---|---|---|---|---|
| V0 | `#1` | 无 | `Used 4 Argon model` | 8 | `95a4c0abcba24364` ✅ | 1 |
| V1 | `#13` | 2 | `Used 3.5 Flash-Lite **High**` | 6 | 无 ❌ | 2 |
| **V2** | **`#1`** | **2** | **`Used 4 Argon High model`** | **8** | **`95a4c0…`** ✅ | **2** |
| V3 | `#1` 与 `#13` 并存 | 2 | `Used 4 Argon High model` | 8 | `95a4c0…` ✅ | 2 |
| V4 | `#13` | 无 | `Used 3.5 Flash-Lite model` | 6 | 无 ❌ | 1 |
| V5 | `#1`（`#13` 缺席） | 2 | `Used 4 Argon High model` | 8 | `95a4c0…` ✅ | 2 |

读法：
- **V4 是决定性反证** —— `#16` 只在 `#13`、**完全不发 `#48`**，照样降级 ⇒ 真凶是**承载位**，不是 `#48`。
- V3 推翻了「`#1` 与 `#13` 并存会让信封整包失效」的旧说法。
- `#13` 缺席（V5）不影响 `#48` 生效 ⇒ `#13` 并非 `#48` 的必要前提。

**带附件**（`out/_voice-test/attach-carrier-probe.mjs` / `argon-mixed-final.mjs`）：

| 请求 | `#16` 位置 | `#30` | 档位 | 附件是否被采纳 |
|---|---|---|---|---|
| 图片 | `#13` | `Used 3.5 Flash-Lite High` | ❌ | ✅ 答出颜色 |
| **图片** | **`#1`** | **`Used 4 Argon High`** | ✅ | ✅ **答出颜色（图片与 Argon 兼容）** |
| 音频 | `#13` | `Used 3.5 Flash-Lite High` | ❌ | ✅ **完整转录** |
| **音频** | **`#1`** | `Used 4 Argon High` | ✅ | ❌ **"没有收到录音文件"** |
| 图片+音频 | `#1` | `Used 4 Argon High` | ✅ | 图 ✅ / 音 ❌ |
| 图片+音频 | `#13` | `Used 3.5 Flash-Lite High` | ❌ | 图 ✅ / 音 ✅ |

**兼容形态穷举失败**（`out/_voice-test/argon-audio-compat.mjs`）：`Lgcvd`+`#8 mode=2`
旧路径直接报 `gRPC 3: Either SpeechRecognitionFeature or PrefetchInputFeature is required`
（该路径已废弃）；`full` 段（`Lgbko→Lfzms→Lfzmr`）会让模型答非所问；
`#13` 缺席 / 双承载 / 仅 `#48` 信封等形态均无效。**目前无解，只能按音频与否分流。**

### 5.14.3 最终实现（`lib/pq.js` `buildProcessQueryRequest`）

```js
const hasAudioAttachment = atts.some((a) =>
  String(a.mime ?? "").toLowerCase().trim().startsWith("audio/"));
const lgauyForField1  = hasAudioAttachment ? buildLgauy({...opts, s16: undefined}) : lgauyBytes;
const lgauyForField13 = hasAudioAttachment ? lgauyBytes : buildLgauy({...opts, s16: undefined});
```

| 场景 | 档位承载位 | 结果 |
|---|---|---|
| 纯文本 / 图片 | `Lgcvm.#1` | **满血 Argon**（档位 + 思考强度全生效） |
| 含音频 | `Lfzqy.#13` | 自动降级 Flash-Lite，**换取"能听到"**（刻意退让，非回归） |

`Lfzqy.#13 Lgauy` 仍**无条件随附**（`buildAttachmentEnvelope` 不再由 `full` 门控）。

**观测**：反代每次请求打印三行，可直接判读，无需再跑离线探测：

```
[req] model=gemini-4-argon → mode=95a4c0abcba24364(static) thinking=high(#48=2)
[carrier] 档位承载位=Lgcvm.#1（档位生效）            ← 或 "Lfzqy.#13（音频退让 ⇒ 本轮自动降级换取听觉）"
[resp] Used 4 Argon High model rank=8 thinkEcho=2 effMode=95a4c0abcba24364
```

**护栏**：单测 §14.11（6 组：纯文本/无信封/图片/音频/混合/mime 大小写与参数）、
e2e §3b.3 + §3b.5 + §3b.5b。基线：单测 **33** + e2e **35**。

### 5.14.4 ❌ 已废弃的旧结论（保留作教训）

2026-10-16 22:37 曾判定「上游收紧、思考强度必须靠 `#13` 承载、`#1` 带 `#16` 会让信封整包失效」，
并据此把 `#16` 从 `#1` 移进了 `#13`；同时把随之出现的 `4-argon → Used 3.5 Flash-Lite`
误判为**"上游对该账号的临时性档位限制"**（当时列出的三条旁证：Vercel/Azure 两出口一致、
档位表仍列全 4 档、HTTP 200 内容正常——**全部成立，但都无法区分"账号受限"与"承载位错"**）。

**教训**：`#30` 只回模型名、`#25`/`#41` 只能看"最后生效了什么"，**都回答不了"为什么"**。
当多个假设都能解释同一现象时，必须做**单变量对照**（本例：同请求只改承载位一处）——
V4（`#16` 只在 `#13`、不发 `#48`）就是那个一次性排除掉"账号受限"假设的关键对照。

---

## 5.15 ★★ 档位静默降级「观测器」（degrade-guard；2026-10-17 起只判定+上报，不动作）

### 5.15.1 问题

上游会按【账号】施加「静默降级」：请求 4 Argon / 3.1 Pro / 3.8 Flash，实际一律以
3.5 Flash-Lite 应答 —— **HTTP 200、内容正常、无任何报错**，唯一痕迹在响应元数据：
`#25` 缺失或回不同 id、`#30` 变 `Used 3.5 Flash-Lite …`、`#41 rank` 回 6。
若不处置，调用方（Eidolon）在无感知中拿到明显更弱的模型输出（"肉眼可见变笨"）。

### 5.15.2 处置（用户 2026-10-17 指定的最终策略：robin 与调用方解耦）

**robin 不做任何换将/重试/置窗**，降级响应原样透出 —— 响应里的 `modelVersion`
（`Used 3.5 Flash-Lite model`）就是给上层的信号，由调用方（Eidolon）收到后跨通道
回退到 `ag/gemini-3.8-flash`（Eidolon 侧另设 600s 直连窗口摊销探测成本）。
robin 内**唯一保留的重试**是 §5.16 空响应的【同模型同档位】重试（empty-retry）。

- **判定**（与 `out/_voice-test/mode-recheck.mjs`同源）：① `#25` 存在 → 直接比对请求档位 id；
  ② `#25` 缺失 → `#30` 含 "flash-lite" 且请求非 Flash-Lite ⇒ 降级；
  ③ 无 `#30` + 空正文 ⇒ `empty`（见 §5.16.1）；④ 其余 ⇒ `unknown`，不动作。
- **动作**：只记录 + 打日志 + 入 `/healthz`。**不换将、不跨档重试、不置窗。**
- **豁免标注**：音频退让请求（含独立音频附件，见 §5.14）的降级是预期行为，
  在裁决与 `lastEvent` 上标 `exempt=audio-deference`（仅标注，无动作差异）。
- **可观测**：`GET /healthz → degradeGuard`（`policy: "observe-only"` / 最近判定 /
  空响应计数 / 最近空响应含插桩字段）。
- **配置**：仅剩 `ROBIN_DEGRADE_GUARD`（默认 1 = 开启观测；0 = 连观测也关）。
  旧旋钮 `ROBIN_DEGRADE_RETRY` / `ROBIN_DEGRADE_TTL_MS` / `ROBIN_DEGRADE_FALLBACK`
  已随策略移除（设置了也被忽略）。

### 5.15.3 实战日志样例（生产，2026-10-17 新策略）

```
[resp] Used 3.5 Flash-Lite model rank=6 thinkEcho=1 effMode=-   ⚠️档位降级
[guard] ⚠️ argon 档位被静默降级（响应：Used 3.5 Flash-Lite model / #25 缺失） —— 不换将不重试，降级回显原样透出，交上层（Eidolon）跨通道处理
```

**为什么不让 robin 自己换 3.8 Flash**（2026-10-17 21:56 实战复盘）：账号被**全限**时
（Argon/3.8/Flash-Lite 全被压），那枪同通道重试 100% 白烧（当晚 3 次全赌输），
既费配额又加 ~30s 延迟；而「仅 argon 被限」的情形由 Eidolon 的 600s 直连窗 +
ag 回退覆盖更彻底（换的是通道，不是通道内的档位）。

**护栏**：单测 §15（判定四态 / 无窗口无换将无重试 / 音频 exempt / 空响应计数+插桩上报）、
e2e §9.1–9.4（音频退让只上报 / 非流式透出 / 流式透出 / 无置窗替代）。

---

## 5.16 ★★ 空响应（静默拒答）与「占位视频」方案（2026-10-17 实证）

### 5.16.1 空响应（`empty`）

**现象**：HTTP 200 + `finishReason=STOP` + 文本为空 + 无 `#30`（健康期响应**必带** `#30`），
耗时 15–27s。反代现将其标记为 `[guard] ⚠️ 上游返回「空响应」…` 并计入 healthz `emptyReplies`。

**触发条件（实测矩阵，均为 7 段真实音频转占位视频）**：

| 组合 | 规模 | 结果 |
|---|---|---|
| 1v / 3v / 7v（无图） | 0.4–2.9MB | ✅（7v 在健康期成功；账号疲惫期复测为空）|
| 1v+2i / 1v+5i / 3v+2i / 3v+5i | 0.5–1.4MB | ✅（部分被降级 Flash-Lite，但有内容）|
| **7v+2i / 7v+5i** | **3.0–3.4MB** | ❌ 空响应（反复复现；同组合在账号健康期成功）|

**结论**：与档位无关（3.8 也空）、与容器无关（webm/mp4 均可）；与
**「请求规模 × 账号资源状态」**相关 —— 账号密集使用后进入"疲惫期"（降级 + 大请求拒答），
同一请求在健康期正常。**处置**：同档位自动重试几次（§5.17，偶发 vs 资源型分流）；
2026-10-17 追问「空响应是真异常还是我方解析失败」后补了自诊断插桩 —— 空响应日志现带
`frames / unknownFrames / extCounts / endedBy`：`frames=0` = 上游真空；
`unknown>0` 或 `exts` 有 `1003` 却无文本 = 帧被我方丢弃/未解析（需修 `pq.js`）。
下次自然空响应事件即可分流，零额外探针代价。用户场景（7 历史音频 + 图片）
恰在大请求区间，建议控制单请求媒体规模（如下调历史音频回放数/字节预算）。

### 5.16.2 占位视频方案（音频 → 极小占位视频轨）

**动机**：Argon 读不到**独立音频附件**（§5.14 的退让是"降级换听觉"），
但**视频音轨可以**（用户真机实证 + 复测：真实语音转录、歌曲描述、8 段不同音频全部读出）。
⇒ 把音频包成"16×16 纯色占位视频 + 原音轨"，让 Argon **直接听**（无需转接/转述）。

**转换（零音频转码）**：

```bash
ffmpeg -i audio.webm -f lavfi -i color=c=black:s=16x16:r=1 \
  -map 1:v -map 0:a -c:v libvpx -b:v 10k -c:a copy -shortest out.webm
```

**实测成本**（Azure 生产机 2vCPU）：**每条 ~100ms**（7 条合计 0.99s）、体积仅 +0.4KB/条
（音频流 `copy` 零转码）。mp4/AAC 备选：0.45s/条（需转码音频）。

**验证**：单条（短/长/mp4/含 thinking high）全通过（`Used 4 Argon High model` + 精确转录）；
7 视频单发也通过（7 段不同内容全部读出）。**规模边界见 §5.16.1**。

---

## 5.17 ★★ 音频 → 占位视频的落地实现：反代侧 media shim（2026-10-16 上线）

**落点决策（用户拍板）**：放**反代侧**（`service/lib/mediashim.js`），而不是 Eidolon/客户端 ——
谁离附件最近谁转换，所有下游（Eidolon、curl 调试、未来其它客户端）自动受益；
且**必须带缓存**（多轮对话中同一条历史音频会反复回传，不得反复调 ffmpeg）。

**实现要点**（`lib/mediashim.js`）：

- 仅处理 `audio/*` 且**有内联字节**的附件（blobId 引用无法转封装，保持原样并打日志）。
- 双模式互备：webm/ogg/opus 走 `-c:a copy`（零转码）；其余（wav/mp3/mp4）先试
  `libopus 64k`，失败自动换另一模式。转换后 mime 变 `video/webm`。
- **缓存**：键 = `v1:sha256(mime ∥ bytes)`（前缀供配方升级作废）；命中 `delete+set` = LRU；
  默认上限 32MB（`ROBIN_SHIM_CACHE_MB`）/512 条，逐出最旧；单条超上限不缓存但正常返回。
- **并发去重**：同内容 in-flight 只跑一次 ffmpeg（后来者记 `deduped`）；
  **并发闸**默认 2（`ROBIN_SHIM_CONCURRENCY`，Azure 1GiB 机内存护栏）。
- **失败语义（关键）**：ffmpeg 缺失/超时/异常 ⇒ 单条**静默回退**（保持原音频 ⇒
  承载位照旧退让 `Lfzqy.#13` 换听觉，行为与旧版一致），**绝不因转封装失败而让请求失败**。
- 配置 `ROBIN_MEDIA_SHIM`（默认 1）/`ROBIN_SHIM_TIMEOUT_MS`/`ROBIN_FFMPEG_BIN`；
  状态 `GET /healthz → mediaShim`（cache/stats）；日志前缀 `[shim]`。

**收益链**：附件 mime → `video/webm` ⇒ `fileSourceOf` 判 `Lgbkr.#4 = VIDEO(6)` ⇒
`hasAudioAttachment=false` ⇒ **`#16` 留在 `Lgcvm.#1`（满血承载位，不退让）** ——
即"Argon 满血 + 能听音频"同时成立（此前无解，见 §5.14）。

**生产实证**（Azure，2026-10-16）：

| 项 | 数据 |
|---|---|
| 冷转成本 | 13000B opus → 13335B webm，**599ms**（本地 101–170ms）；体积 +~0.3KB |
| 缓存 | 第二次同音频请求 `cacheHits` 计数命中，`converted` 不增 |
| 承载位 | `[carrier] … Lgcvm.#1（档位生效）` —— 不再退让 |
| 模型行为 | 真实回应音频内容（此后进入账号疲惫期，执行者被静默换将，见 §5.15） |

**顺带修复的真实缺陷**（生产实测踩中）：`geminiToRobin` 的 `pushPart` 原为
`else-if` 链 —— 当同一 part 里 `text` 与 `inlineData` **共存**时，命中 text 后
**静默丢弃附件**（模型答"没有收到任何音频文件"，反代日志里附件数为 0，无任何报错）。
已改为"文本与附件都提取"（单 part 共存 / 双 part 客户端两种形态都兼容），
补单测 §13 回归断言。

**测试护栏**：单测 **43** 组 + e2e **41** 组（e2e 无 ffmpeg 时 §10 自动跳过；
§10.1/§10.2 现场生成静音音频并断言"发出 video/webm + `Lgbkr.#4=6` + 承载位不退让 + 缓存命中"）。

> 疲惫期（账号级降级/空响应）的最终处置已延伸到 **Eidolon 侧**：`RobinProxyService`
> 覆写 `_generate_content_with_retry`，命中降级形态（Flash-Lite 回显/静默空响应）时
> 跨通道回退到 **AG `gemini-3.8-flash`**（含 TTL 直连窗口），反代侧不再扩展疲惫期战术。
> 见 Eidolon 仓库提交 `0ac41ddc`。

---

## 5.17 ★★ 空响应自动重试（「偶发故障」与「资源型」的甄别；2026-10-16 实证）

### 5.17.1 两类失败必须分流（用户指定策略）

| 失败形态 | 判据（响应面） | 处置 |
|---|---|---|
| **额度/资源型降级** | 档位被静默换 Flash-Lite（`#25` ≠ 请求档位 / `#30` 回显 Flash-Lite） | **不重试**（账号级，重试必无意义）→ 既有降级链（见 §5.15 + Eidolon ag 回退） |
| **空响应（偶发候选）** | HTTP 200/STOP、无正文、无 `#30`、无传输错误 | **先自动重试**（本方案）；连续空 ⇒ 判资源型，交上层 ag 回退 |

实证依据（2026-10-16 生产）：
- 官方 Gemini App 客户端同样偶发空回复（用户确认）——不报错、重试后或一段时间后恢复；
- 同请求不同结果（状态分钟级浮动）：同一条 4.57MB 视频 14:26 空 / 14:27 有内容；
  同组 7 占位视频 15:26 成功（59s）/ 15:33 空；
- 交替实验（15:22–15:29）：同一分钟内重媒体请求空、轻请求满血 Argon 成功
  ⇒ 与「五小时文本配额」无关（用户确认 19:58 配额重置后 20:04 仍空）；
- 当天全部 9 次空响应 100% 含视频类附件——视频管线负载是最大相关性（见 §5.16.1）。

### 5.17.2 实现（`service/lib/empty-retry.js`）

`app.js` 的 `callRobin` 拆分为「单次尝试 `attemptRobin`」+「重试编排包装」：

```
callRobin = withEmptyRetry(() => attemptRobin(...))
  每次尝试后读 result.__modeVerdict.state（degrade-guard.noteResponse 的产物）
  ├─ state ≠ "empty"（正常/降级）→ 立即返回（降级不在此重试：2026-10-17 起
  │    反代对降级完全不动作，回显透出交 Eidolon 跨通道处理，见 §5.15）
  └─ state = "empty" → 重试（默认最多 1 次，总 2 次尝试，带总预算+预留双护栏）
       ├─ 任一次成功 → 返回成功结果（调用方无感，robin 质量保留）
       └─ 连续空 → 返回最后结果（判资源型，交上层：Eidolon ag 回退）
```

- **安全性质**：空响应 = 零内容 = 未向客户端透出任何字节 ⇒ 所有路径（含真流式）重试
  无重复输出风险；重试为**同请求同档位**（不换档）。
- **预算护栏**：`ROBIN_EMPTY_RETRY_BUDGET_MS`（默认 100s）从进入 `callRobin` 计时，
  `ROBIN_EMPTY_RETRY_RESERVE_MS`（默认 60s）为每次重试前预留 —— 「已用 + 预留 ≥ 预算」
  即停。保证最坏「上传 ~10s + 2 次尝试×~50s」≈ 110s < Eidolon 120s 单请求硬超时
  （2026-10-16 实战教训：旧默认 2 重试/170s 曾以 123s 超时 4 秒双双落空）。
- **与降级的关系**：本模块是 robin 内**唯一保留的重试**；降级路径不重试、不换将
  （§5.15），两者不会叠加成风暴。

### 5.17.3 配置与观测

| 配置 | 默认 | 说明 |
|---|---|---|
| `ROBIN_EMPTY_RETRY` | `1` | 单请求最多重试次数（总尝试 = 1 + N）；`0` 关闭 |
| `ROBIN_EMPTY_RETRY_DELAY_MS` | `0` | 重试间隔（空响应本身已自带 25~35s 等待，默认立即重试） |
| `ROBIN_EMPTY_RETRY_BUDGET_MS` | `100000` | 重试总预算（安全护栏，见上） |
| `ROBIN_EMPTY_RETRY_RESERVE_MS` | `60000` | 每次重试前预留（「已用 + 预留 ≥ 预算」即停） |

- 日志：`[empty-retry] ⚠️ 空响应（第 1/2 次尝试）→ 自动重试（立即）` /
  `[empty-retry] ✓ 第 2 次尝试成功（本请求共空 1 次）—— 判为偶发故障，已自愈` /
  `[empty-retry] ✗ 2 次尝试均为空响应（重试上限 1）→ 放弃重试，交上层处置（资源型可能性高）`
- 诊断插桩（2026-10-17）：空响应日志带 `[诊断] frames=… unknown=… exts=… endedBy=…`
  （`robin.js` 累计 + `degrade-guard` empty 分支输出）—— 分流「真空/解析失败」。
- 状态：`GET /healthz → emptyRetry`（enabled / maxRetries / budgetMs / reserveMs +
  `logical / emptyEvents / retries / successes / exhausted / budgetStopped`）。

### 5.17.4 测试护栏

- 单测 **52** 组（§15 降级观测器：判定四态 / 无窗口无换将无重试 / 音频 exempt /
  空响应计数+插桩上报；§17 空重试：偶发自愈 / 耗尽交上层 / 降级不重试 / 双护栏 / 关闭直通）；
- e2e **43** 组（§9 降级透出闭环：音频退让只上报 / 非流式透出 / 流式透出 / 无置窗替代；
  §17 空重试闭环：mock `TRIGGER_EMPTY` 第 1 次回空响应、第 2 次起正常 ⇒
  断言「客户端收到正常内容 + mock 收到 2 次请求 + 同档位（argon 不降级）+ healthz 记账」）。

---

## 5.18 ★★★ 空回复的**真正根因**：本端 idle 超时把「慢」误报成「拒答」（2026-10-20）

> ★★★ 本章**推翻** §5.16 的核心结论（「空响应 = 上游静默拒答 / 账号疲惫期」）。
> 那一节的结论来自 2026-10-16 的观测，**观测手段本身有缺陷**（把本地超时
> 当成了上游行为）。本章是单变量对照实验 + 生产载荷实测后的定案。

### 5.18.1 症状与「误诊链」

生产现象：HTTP 200 + `finishReason=STOP` + 无正文 + 无 `#30`（用户侧「空回复」）。

当时的分流逻辑（`degrade-guard`）按「帧里出现了 ext1003 以外的扩展」判成
**【D 盲区扩展】"文本可能落在未解明的数据包里"**，于是排查方向被带偏到
「上游换了协议 / 有未解明的包」——**这正是长期误判的源头**。

真相：空回复时的帧序列是

```
ext1000(能力表 ACK) → ext1003(3B 空 oneof) → ext1014(会话 id) ×2
```

与健康响应的**前四帧完全同构**（健康响应后面才是 ext1003 正文帧）。
`ext1000` 是 ACK、`ext1014` 是会话 id 握手帧 —— 两者**从来就不承载文本**，
把它们算作「盲区扩展」纯属误判。

### 5.18.2 ★ 决定性单变量对照实验

同一账号、同一出口、同一载荷（60KB 文本 + 2 图 + 1 音），**只改一个变量**：
本端「首个正文帧之前」的空闲宽限。

| 实验 | 正文前宽限 | 结果 |
|---|---|---|
| EXP3 | **无**（统一 1.5s idle） | **4/4 空回复（100%）**，frames=4、无 `#30`、3.4~5.0s |
| EXP4 | 60s（两段式 idle） | **0/4 空回复**，同样的请求全部正常 |

⇒ **空回复是本端自己造的**：上游只是「慢」，我们把它掐死了。

### 5.18.3 首正文延迟的实测分布（决定超时值）

2026-10-20 实测（从**发帧**起算，不含上传耗时）：

| 载荷 | ACK 到达 | 首正文到达 | 最大帧间隙 |
|---|---|---|---|
| 轻（纯文本 ~20 字） | 0.2~1.0s | 0.3~5.4s | ≤3.6s |
| 60KB 文本 + 2 图 + 1 音 | 0.2~1.0s | 3.7~5.4s | ≤3.6s |
| **生产载荷**（6 视频 + 2 图 + 60KB 文本 + Argon High） | 0.3~2.0s | **10.8~30.1s** | **26.4s** |

⇒ 旧实现统一 10s idle ⇒ **生产载荷几乎必空**（30s 的首正文延迟必被 10s 掐断）。
⇒ 这就是「反代空回复率远高于官方 App」的机理：官方 App 是长连接客户端，
它会一直等；而我们用一个 10s 的静默定时器替上游做了「答完了没」的判断。

### 5.18.4 ★★ 上游其实**有**明确的流结束信号（此前完全没被使用）

健康响应的帧序（实测 8/8 一致）：

```
ext1000(ACK) → ext1003(3B 空 oneof，开始帧) → ext1014(会话id)×2
→ ext1003(Lgcvc.#1 Lfzrc{正文}) × N
→ ext1003(Lgcvc.#2 = <空 godw>)   ★★ 流结束标记（EOS）
```

`Lgcvq[ext1003] Lgcvc{ #2 = <空 godw> }`（oneof 落在 case2）是上游的
**「答完了」**信号。⚠️ 与**开始帧**（3 字节 `ext1003{}`，oneof 未设）必须区分。

### 5.18.5 ★ 修复（三件套，`service/lib/`）

| # | 改动 | 位置 | 效果 |
|---|---|---|---|
| 1 | **空闲宽限分三态**：frames=0（上游没接单）→ 短 idle 快速失败；frames>0 但**无正文** → **一路等到总时限（300s）**；**已有正文** → 兜底宽限 | `lib/robin.js` `idleLimitFor()` / `armIdle()` | 根治自造空回复 |
| 2 | **认两个确定性结束信号**（见 5.18.4b）：**正文完成标记** `Lgapu.#19 == 2` 与 **EOS** 标记 `ext1003{Lgcvc.#2 空}` | `lib/pq.js` `extractResponse`（`out.complete` / `out.eos`）+ `lib/robin.js` | ① 结束不再依赖超时猜测；② 每请求省掉一整段 idle 空等尾巴 |
| 3 | **总时限 300s**（`ROBIN_TIMEOUT_MS`），并把幂等去重的「等在途」时长同步抬到 300s | `lib/config.js` / `lib/dedup.js` | 慢上游不再被掐；调用方重发时能等到在途结果 ⇒ 不重复计费 |

#### 5.18.4b ★★「正文已完整」标记 `Lgapu.#19 == 2`（第二个确定性信号）

逆向文档早已记下 `#19 varint = 1→2（分片状态，2 = 完成）`，但此前**从未被使用**。
2026-10-20 对全部取证帧（141 个响应 / 810 个正文帧）做了统计：

| 观测 | 结果 |
|---|---|
| 每帧的 `Lgapu` 个数 | **恒为 1**（810/810）⇒ 无多分片风险 |
| 首个 `#19=2` 的帧是否已含全部文本 | **139/141 是**；其后 **0 例**再增长 |
| 最后一帧的 `#19` | 139/141 为 `2`；另 2 例（正是卡死的响应）全程没有 `#19=2` |
| 与 EOS 标记的关系 | EOS 只在 136/141 出现 ⇒ **`#19=2` 覆盖了 EOS 缺失的那 5 例** |

⇒ 收到 `#19=2` 即可**立即收尾**。于是「结束」不再需要任何超时猜测：
**首正文前的等待可以放心拉到 300s**，因为慢上游一定会自己说「答完了」。

### 5.18.5.1 ★ 现行结束条件（先到先算）

| # | 条件 | 结果 |
|---|---|---|
| ① | **正文完成标记**（`Lgapu.#19 == 2`） | 立即收尾（确定性，正常路径 20/20 命中） |
| ② | **EOS 标记**（`ext1003{Lgcvc.#2 空}`） | 立即收尾（确定性） |
| ③ | 上游会话终止（END_STREAM / trailers / close） | 收尾（无正文 ⇒ 真正的空回复，触发 empty-retry） |
| ④ | 上游真空（**一个字节都没回来**）持续 10s | 失败（真正的空回复）→ 触发 empty-retry |
| ⑤ | 总时限 300s 到 | 收尾（判为超时） |
| ⑥ | 正文已开始但 ①②③ 都没来的兜底 | 静默 30s 后收尾 |

> **我方的静默定时器不再能把「上游慢」变成空回复** —— ① ② 是上游自己说的，
> ③ 是上游自己关的，④ 是上游真的什么都没给，⑤ 是 300s 的硬上限。

### 5.18.5.1b ★ 顺带发现：两类「瞬时可重试」的上游明确拒答

上游会**明确拒答**（grpc 业务错误）两类瞬时形态，**推理根本没跑 ⇒ 零额度消耗**：

| 错误 | 实测频率 | 耗时 | 判定 |
|---|---|---|---|
| `BardStatusException: This service is not yet available in your location ZZ.`（grpc=9） | ~1/20~40 请求 | 2~3s | `transient` |
| `BardStatusException: Agency connection failed: … throttled: Service is overloaded (memory-protection)`（grpc=13） | 偶发 | ~1.2s | `transient` |

- 第一类 = 上游按**出口 IP 的地理判定**偶发失败（ZZ = Google 未能判定所在区域）。
- 它们原本**不触发**「空回复重试」（不是空回复，是 gRPC 错误）⇒ 调用方直接拿到
  502，用户侧表现为「发送失败」。
- ⇒ 新增 `transient` 判定形态（`lib/degrade-guard.js`），由同一套「同模型同档位」
  重试覆盖；healthz 单独计数 `degradeGuard.transients`。
- ⚠️ 判定**刻意收窄**：参数类业务错误（如 `Unsupported file source.`）不会被
  误判成可重试（单测 §22 (h3) 守护）。

### 5.18.5.2 配套修的两个真 bug（同一轮排查发现）

| bug | 现象 | 修法 |
|---|---|---|
| `lib/dedup.js` 把**错误结果也写进缓存** | 一次 20s 取令牌超时 ⇒ 之后 **90 秒**内所有同 payload 请求都被重放成同一个错误，完全不再尝试恢复 | `isCacheable()`：错误与空响应**都**不进缓存（与文件头设计边界对齐） |
| `lib/auth.js` 取令牌**无重试** | 端点瞬时抖动（同一凭证另一进程 0.6s 成功）⇒ 该次请求零额度返回 502 | 网络类错误重试一次（403 BadAuthentication 不重试 —— 那是凭证真被撤销） |

### 5.18.5.3 实测效果（同一账号、同一出口）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 空回复率（轻请求 HTTP 入口 n=25 / SSE n=20） | ~5~8% | **0%** |
| 空回复率（重载荷 lib 入口 n=10） | 可复现（EXP3 100%） | **0%** |
| flash-lite 纯文本中位延迟 | 19.3s | **3.2~3.4s（≈6× 提速）** |
| 结束方式 | 静默超时猜 | **完成标记（实测 20/20）** |
| **慢上游** | 首正文 30s / 191s ⇒ **被掐成空回复** | **等到答完，正常返回内容** |

**最有力的一条**：2026-10-20 的 HTTP 压测里有 3 个请求上游分别花了 **127s / 191s / 275s**
才吐字 —— 旧逻辑（10s 统一 idle）会把它们**全部变成空回复**；
新逻辑（300s 上限 + 完成标记）**全部正常返回了内容**。这正是「空回复率远高于
官方 App」的最后一层原因（官方 App 是长连接客户端，会一直等）。

### 5.18.6 空回复分流的**新**判据（`degrade-guard`）

| 代号 | 条件 | 含义 | 处置 |
|---|---|---|---|
| **A** | `frames=0` | 上游真空（连 ACK 都没有） | 快速失败 |
| **A2** | `idleCutBeforeText=true` | **本端**在正文出现前掐断 | 上游只是慢；调 `ROBIN_IDLE_FIRST_*` |
| **B** | `unknownFrames>0` / `controlFrames>0` | 帧到了但分类层没认出 | 修 `parseServerFrame` |
| **C** | `contentFrames>0` 却解不出文本 | 我方解析失败 | 修 `extractResponse` |
| **D** | 出现 1003/1000/1014 **以外**的扩展且无文本 | 真·盲区扩展 | 扩展 `extractResponse` |
| **E** | 有握手帧、无正文、未触发本地超时 | **上游真·静默拒答** | 交上层跨通道回退 |

> ⚠️ 判据从「extCounts 里有没有 1003」改成「`contentFrames>0`」：
> 3 字节的空 `ext1003{}`（开始帧）与 EOS 帧也计在 1003 上，用 extCounts 判会把
> 「上游没出正文」误报成「我方解析失败」。
> ⚠️ `ext1000`（ACK）与 `ext1014`（会话 id）已列入**良性扩展**，不再报「盲区扩展」。

### 5.18.7 附带澄清：`Lgcvm.#8`（模式标志）缺失**无害**

生产请求不带 `Lgcvm.#8`（逆向文档 §5.2 记的 app 侧取值 1/2），而历史探针脚本
（probe28~40）普遍带 `mode:1`。2026-10-20 单变量对照（同载荷，各 8 次）：

| 变体 | 结果 |
|---|---|
| 不带 `#8`（生产现状） | 8/8 正常 |
| 带 `#8=1` | 8/8 正常（TTFB、帧序、模型名、档位回显全同） |

⇒ **不是空回复的成因**，保持现状（不带），仅记录该差异以免后人重复排查。

---

## 6. 当前状态与剩余阻塞

### 6.1 ✅ 已完整打通（可直接进入实现）

| 项 | 状态 |
|---|---|
| 传输层 | ✅ gRPC bidi over HTTPS，主机 `robinfrontend-pa.googleapis.com` |
| 鉴权 | ✅ gpsoauth master token → robin token 重铸链路已跑通（见 `credential-acquisition.md`） |
| 请求构建 | ✅ 三步式（initial/prefetch/commit）字节级正确，服务端接受 |
| 响应解析 | ✅ gzip + `Lgcvq` 扩展解包 + 能力表 ACK 解析 |
| 服务端接纳性 | ✅ **已实证**：无客户端证书 / attestation 门控（普通 token 可直连） |
| ToS 读写 | ✅ 版本查询 + accept 请求构造均已实现并校验字节；**accept 未发送**（待授权） |
| **文本对话** | ✅ **端到端实证**：`initial→prefetch→commit` 得真实模型回复（"Used 3.5 Flash-Lite model"） |
| **附件上传** | ✅ **端到端实证**：push.clients6 两步 resumable，finalize 响应体即 blobId（TTL 1d） |
| **图片附件** | ✅ **端到端实证**：上传纯蓝 PNG → 服务端答「这张图片是蓝色的」（probe40 + `_blue-verify`，非幻觉，已交叉验证像素） |
| **音频附件** | ✅ **端到端实证**：上传 440Hz WAV → 服务端答「电话拨号音/铃声」（`_audio-probe`，e4=12） |
| **视频附件** | ✅ 端到端实证见 `_video-probe.mjs`（e4=6 为主，扫描 {6,12,1,5,7,9}） |
| **多轮对话** | ✅ 历史拼接策略生效；另发现服务端按账号保持会话（双保险） |
| **Function Calling** | ✅ **prompt 仿真兼容层**，真实通道五场景全过（§5.9）：单工具/多工具选择/并行调用/无误报/工具循环 |
| **Vercel 部署** | ✅ `gemini-robin-proxy.vercel.app`，PROXY_API_KEY 强制 + 限流 + File API 分片上传 |

### 6.2 ✅ 已解除：账号级 ToS（版本 9）—— 2026-10-15 深夜起不再拦截

此前记录的 `grpc-status=9 BardStatusException: Before proceeding, please accept our terms of service.`
在 probe35 之后的所有探测中**不再出现**（全部 `grpc=null` + 真实内容，含文本/图片/音频）。
判断：账号已在某一时刻通过 Gemini App 侧接受了版本 9（一次性动作，账号级解锁）。
`service/lib/tos.js` 的 accept 构造保留兜底，仍**绝不自动发送**。

### 6.3 🔶 剩余语义空白（非阻塞，可并行推进）

1. **`CommitControlFeature` 声明机制**：IOS 路径报 `CommitControlFeature is missing in initial request`。
   ANDROID 路径实证不需要（文本+附件均通）
2. **`Lgauy` 22 字段语义映射**：字段号已定，需与 UI/配置来源对上
   （模型选择、能力位、thought 等级、会话 ID）
3. **多轮会话状态载体**：~~`Lfzww`/`Lapui` 未接通~~
   → **已推翻并查清（2026-10-16）**：会话 ID 由服务端下发，客户端无法指定，
     只能通过 `DeleteConversation` 销毁；见 **§5.10**
7. **★ 个性化/长期记忆（五角星）尚未关闭**：`out/_memory-probe.mjs` 用 Gemini 记忆触发句式
   （"请永远记住：我的名字是测试甲一郎"）写入后，另一请求不带任何历史仍能答出
   ⇒ **存在账号级长期记忆**，且 `DeleteConversation` 管不到该层。
   已探明的相关线索：
   - `Lavlr` = `LabsSettingsData`（`isPersonalizationEnabled` 等 10 个 bool，**f 位**）；
     ★ 证据链：`tools/xref.py --strs "isPersonalizationEnabled"` → `Lavlr.toString` +
     `Lbrvq.b`（Kotlin 属性读写器，取 `Lavlr.f`）
   - 写入/读取偏好可用 RPC：`UpdateUserPreferences`（req `Lgbjn`）/ `ReadUserPreferences`（req `Lgatp`）；
     `Lgbjn.#1 Lgbkk` 是一大坨 bool 开关（#1/#5/#63/#78/#79/#121/#137/#138/#165…#193），
     **尚未确定哪个 bool 对应个性化**
   - `GetPersonalCurationDocument`（req `Lgahj`）
   - AGSA 字符串池还有 `/client_streamz/…/robin/personalization_toggle_changed_count`
     ⇒ 客户端里确实存在"个性化开关"上报点
   **当前结论**：这是 Google **账号级**设置，协议层未找到可靠的 per-request 关闭位。
   要真正关闭应走账号侧 UI（Gemini App 设置 / myaccount.google.com 的 Gemini 活动记录），
   或继续逆向 `Lgbkk` 的 bool 语义后调 `UpdateUserPreferences`（风险高，未做）。
   代理侧的兜底：每次请求后 `DeleteConversation` 清会话层留存（§5.10）。
4. **`Lgbkr.#4` 枚举深层语义**：实证支持集 {0,1,5,6,7,8,9,12}，
   拒绝集 {2,3,4,10,11}（"Unsupported file source."）；
   且**同一种内容在不同枚举下处理结果不同**（音频在 {1,5,7,9,12} 被识别，
   {0,6,8} 报"未提供音频"）——疑似「文件来源/处理管线」而非纯文件类型，
   服务端按 (mime, enum) 组合路由到不同解析器。深挖优先级低（按内容类型选对枚举即可）
5. **`RESTRICT_VIDEO_UPLOAD` 的读取方**：是否由 `RobinBardModeConfig` 下发
6. **上传请求体细节**：实证空体即可；`x-client-pctx` 非必需

## 7. 复刻可行性初判（供决策）

| 维度 | 评估 |
|---|---|
| 端点/协议 | ✅ 已定位（gRPC bidi over HTTPS，protobuf） |
| 上传 | ✅ 同族协议，头/租户/Push-ID 全部拿到 |
| **请求结构** | ✅ **本轮打通**：字段号 + 扩展体系 + 附件链路全部字节码级可证，可直接用官方 protobuf 库重建 |
| 鉴权 | ✅ **已实证**：gpsoauth master token 可换 robin token 直连，**无 attestation 门控** |
| 对话链路 | ✅ **已实证**：三步式协议被服务端接受，仅差账号 ToS |
| 语义空白 | 🔶 `Lgauy` 22 字段、blobId 落点、`Lgauy.#6 枚举过滤`的取值含义 |
| 服务端接纳性 | ✅ **已证实可接纳**（此前"未知"已解除） |
| 未解门禁 | 🔴 **ToS 版本 9**（账号级，无法参数绕过）；🔶 `CommitControlFeature` 声明（IOS 路径暴露） |
| 工程量 | 中（协议层已攻克，剩余为字段语义填充 + 附件链路 + ToS 通关） |

---

## 附：产出物索引

| 文件 | 内容 |
|---|---|
| `out/idx/` | 14 DEX 全量字符串池 + 类名（60 万条，3 秒重建） |
| `out/names/robin-proto-types.txt` | robin proto 包已知类型名 |
| `out/names/assistant-proto-names.txt` | assistant proto 全名（946 条） |
| `out/names/assistant-mobile-robin.txt` | assistant.mobile.robin 包全名 |
| `out/names/toString-fields.txt` | 字段名金矿（11,070 条） |
| `out/robin/robin-rpc-list.txt` | **RobinService 全部 162 个 RPC** |
| `out/robin/extension-map.txt` | protobuf 扩展注册表（1,506 条） |
| `out/robin/fieldmap-processquery.txt` | **`Lgc??` 全部 559 个消息类精确字段表** |
| `out/robin/fieldmap-attach.txt` | 附件链路字段表（`Lfzms`/`Lfzmr`/`Lgbku`/`Lgbkr`/`Lgbks`…） |
| `out/robin/fieldmap-gbko.txt` | `Lgbko`/`Lgbwz`/`Lgbxy`/`Lgash` 字段表 |
| `out/robin/fieldmap-gbkn.txt` | `Lfzqy`(63 字段信封)/`Lgbkn`/`Lgauy` 字段表 |
| `out/robin/fieldmap-gcvm-ext.txt` | `Lgcvm` 9 个子扩展字段表 |
| `out/robin/reach-processquery.txt` | 从 `Lgcvp` 出发的 BFS 对象图（含两级扩展展开） |
| `out/robin/Lansi-i-method.asm` | **★ `Lansi.i` 完整反汇编（附件请求装配 1457 行）** |
| `out/robin/Lansi-g.asm` | `Lansi.g` 反汇编（device context update） |
| `out/robin/Lanmw-g.asm` | **★ `Lfzms` 构造（Uri/bytes → 附件 proto）** |
| `out/robin/Lanjc-f.asm` | **★ app 模型 → `Lgbku` 字段映射（511 行）** |
| `out/robin/Lanjh.asm` | `Lanjh.c`（向信封塞附件） |
| `out/robin/Lgbmm.asm` | `Lgbmm.hm/hl/hk/hn` 挂载辅助 |
| `out/robin/Lbdbm.asm` | `Lbdbm.a():Lfzms` |
| `out/robin/Lgbku-clinit.asm` | `Lgbku` 的 `newMessageInfo` 构造段（数据流修复的参照样本） |
| `tools/fieldmap.py` | **字段表解码器**（info 13-bit 解码 + objects 游标 + 后向数据流） |
| `tools/validate_fieldmap.py` | **字段表解码正确性验证（99.99%）** |
| `tools/protoreach.py` | 从任意根类做 BFS 对象图（展开扩展 + MESSAGE 引用） |
| `tools/extmap.py` | protobuf 扩展注册表提取 |
| `tools/dump_strings.py` / `tools/xref.py` / `tools/refs.py` | 侦察工具（字符串池 / 字符串引用 / 类型·字段·方法引用） |

### 附2：★ 实机探测脚本（`out/_*.mjs`，协议攻坚全过程）

| 文件 | 作用 | 关键结论 |
|---|---|---|
| `_initial-probe5.mjs` | **转折点**：去掉 `Lgcxj` 包装 | Q1 裸 `Lgcvp[ext1000]Lgcvm` → 报错从 `First request should be 'initial'` 变为 `ClientType is UNSPECIFIED or not provided` = 破关 |
| `_initial-probe6.mjs` | 34 变体扫枚举候选字段 | **命中 `Lgauy.#4 = ClientType`**（24 个候选中唯一） |
| `_initial-probe7.mjs` | **决定性突破** | R0 基准 → `grpc-status=- \| 无错误` = initial 通过；揭示 `Lgcux`=AudioFeature |
| `_initial-probe8.mjs` | 会话脚本化 + 全程转储 | 发现响应以 `1f8b0800` 开头 = gzip 魔数 |
| `_initial-probe9.mjs` | 抓响应头 | 确认 `grpc-encoding: gzip`；修复作用域 bug |
| `_initial-probe10.mjs` | **确定性对照实验** | ACK 与文本无关（A1=A2=B 字节相同），仅随 ClientType 变元素数 → 能力表 |
| `_initial-probe11.mjs` | 端到端三步式 | T1 无 prefetch 直接 commit → `No prefetch query to commit.`；T2 全流程 → ToS 错误 |
| `_e2e-test.mjs` | **调 service/lib 的端到端验证** | HTTP 200、244 项 ACK 解析成功、`endedBy=server-end` |
| `_tos-probe.mjs` | ToS 只读探针（最简） | `GetTermsOfServiceVersion` → `grpc-status=0`，待接受版本 **9** |
| `_tos-hex.mjs` | **ToS 响应原始 hex + 字段树** | 终结字段号歧义：`Lgbip.#1` 是空格哨兵 `0x20`，不是 "32" |
| `_tos-accept.mjs` | **ToS 状态查看 / 接受（默认干跑）** | 构造 194B 的 `Lfzky` 并校验；`--commit` 才发送 |
| `_ct-sweep.mjs` | **ClientType 1..4 全扫对照** | 证明 ToS 与客户端类型无关；发现 `CommitControlFeature` 门禁 |

> ⚠️ 2026-10-15 修复两个核心 bug：① `iter_class_data` 每方法多读 1 个 ULEB（第 2 个方法起全错位）；
> ② `CodeItem` 解析 tries 时把 `handler_off` 当绝对偏移（导致扫描巨慢）。修复前的结果不可信。
> 同日另修：③ `disasm` 的 `move-object/from16`(0x08) 被错标 22c（应为 22x）；
> ④ `fieldmap` 的 objects 数据流改为后向求值 + 序言回退（此前死分支污染导致字段名丢失）。
