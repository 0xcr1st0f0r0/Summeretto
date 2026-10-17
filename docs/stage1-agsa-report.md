# 阶段1 静态扫描报告：AGSA 真运行时 ★ 核心突破

**目标**：`com.google.android.googlequicksearchbox` v17.66.12.ve.arm64（versionCode 301820578）
**来源**：`d.apkpure.net`（APKPure XAPK，258,135,310 B）
**日期**：2026-10-15
**工具**：`tools/dexlib.py` + `tools/scan_nested_apk.py`（零依赖，流式扫描不解包）

---

## 1. 规模对比：43 倍确认

| | Shell APK (Gemini) | **AGSA (Google)** |
|---|---|---|
| APK | 5.08 MB | **245.5 MB** |
| DEX 数 | 3 | **14** |
| DEX 总量 | 3.91 MB | **~118 MB** |
| strings | 21,087 | **~542,000** |
| classes | 5,216 | **154,302** |
| 业务类 | 5 | 全部 |

壳包的 5 个业务类 vs AGSA 的 15.4 万类。**架构阻断得到实测确认**。

---

## 2. ★★★ 三个决定性发现

### 发现 1：视频 mime 白名单完整存在（18 条）

```
video/3gpp     video/3gpp2    video/mp2t      video/mp4       video/mp42
video/mp43     video/mp4v-es  video/mpeg      video/mpeg2     video/quicktime
video/webm     video/x-m4v    video/x-matroska  video/x-msvideo
video/mp4; codecs="avc1.640028"        ← 带 codec 参数的变体
video/mp4; codecs="av01.0.17M.10.0.110.09.16.09.0"   ← AV1
video/webm; codecs="vp9"  /  video/webm; codecs="vp9.2"
```

音频23 条：
```
audio/aac  audio/flac  audio/mpeg  audio/opus  audio/ogg  audio/wav  audio/webm
audio/mp4; codecs="mp4a.40.42"  audio/mp4; codecs="mp4a.40.5"  audio/mp4a-latm
audio/amr  audio/amr-wb  audio/3gpp  audio/x-wav  audio/webm; codecs="opus"
```

**结论**：音视频输入不是灰度，是产品承诺的稳定能力。而且**带 codec 参数的 mime 说明服务端要做解码协商**，
这不是客户端能伪造的——证明服务端确实处理视频流。

### 发现 2：上传机制 = Scotty uploader + resumable（与 web 通道同源）

```
https://push.clients6.google.com/upload/       ← 与 Nexus/Go 版逆向结论一致 ✓
https://content-push.googleapis.com/upload/    ← 旧端点
Scotty-Uploader-ResumableTransfer-%d
Scotty-Uploader-MultipartTransfer-%d
Scotty-Uploader-HttpUrlConnectionHttpClient-%d
TransferOptions[idleTimeout %d sec, resumableTransferThreshold=%d, digest=%s, crc32c=%s, forceMultipart=%s]
X-Goog-Upload-URL / X-Goog-Upload-Command / X-Goog-Upload-Protocol
X-Goog-Upload-Offset / X-Goog-Upload-Size-Received / X-Goog-Upload-Chunk-Granularity
X-Goog-Upload-Header-Content-Length
Failed to parse X-Goog-Upload-Size-Received header
bard-storage          ← tenant id，与 web 逆向结论一致 ✓
resumable
```

**这是本项目最重要的发现之一**：移动端上传走的是**和web 通道完全相同的 resumable 协议**，
同一个`push.clients6.google.com/upload/` 端点 + `bard-storage` tenant。
→ **web 通道的 1003 失败与移动端成功，差异一定在「上传之后的引用绑定」环节**，而非上传本身。

### 发现 3：对话走 ConversationMode（Live 流式），不是 batchexecute

完整日志前缀 `#CM#`（Conversation Mode），8380+ 条 FEATURE_GATE 命中。核心类：

```
ConversationModeControllerImplV3      ← 主控制器
ConversationModeClientConfig(clientType=...)
ConversationModeQuery(requestType=...)
ConversationModeFeatures(screenShare=...)
ConversationModeMetadataFlowResult(isBardModeActivityEnabled=...)
```

### 数据通道是双向流（**这是原生音视频的关键**）

```
#CM# Buffer is full, dropping inputs (PayloadType: %s)
       , pushPayloadType=
#CM# Attempting to send to a closed channel.
#CM# Cannot emit audio chunk, active stream is null.
#CM# Encoder: encoding PCM audio to Opus            ← 客户端 Opus 编码
#CM# Encoding using Opus frame duration: %sms (requested target duration: %sms).
#CM# Audio stream clock drift: audioElapsed=%s, wallElapsed=%s, drift=%s, rate=%.3f ms/s
#CM# Audio start time is unknown. Not sending the current stream.
#CM# Awaiting server ChatId for %s...
#CM# Created session / created session   (serverChatId, clientControllerId)
#CM# Creating new turn for user message
#CM# Completed empty model message
#CM# Emitting initial text input to Live session      ← "Live session"
```

服务端下行消息类型：
```
#CM# Bonobo: Received ConversationStarted
#CM# Bonobo: Received ConversationMetadataUpdate
#CM# Bonobo: Received TitleUpdate
#CM# Bonobo: Received ChatHistoryOutput without payload.
#CM# Bonobo: Received ConversationMessageUpdate without message content.
#CM# Bonobo: applyHistoryUpdates
#CM# Bonobo: no completed turn to update. Ignoring ModelMessage.
#CM# Bonobo: updating last completed turn in-place for ModelMessage %s
#CM# ContextOutput payload not set
#CM# ConversationStateOutput: %s. Mapped to %s at %d
```

**协议形态**：客户端持续推 `PayloadType` 封装的 chunk（音频=Opus，视频/屏幕=原始帧），
服务端回 `ConversationStarted` → `ConversationMetadataUpdate` → 流式内容 → `TitleUpdate`。
**这是"持续会话 + 服务端主动推送"模型**，与 web 的一次性 `batchexecute` 完全不同。

---

## 3. ★ 视频输入的具体实现路径（`PendingAttachment` 类族）

```
PendingAttachment                              ← 密封类层次
├── LocalFile
│   ├── Meta
│   │   ├── VideoMeta            ★ 视频元数据
│   │   ├── ChromeWebPage
│   │   └── NoMeta
│   └── UploadSource
│       ├── Default
│       ├── ScreenContext
│       └── ShareSheet
├── LocalImage
│   ├── Metadata
│   └── UploadSource (Default / ShareSheet / ScreenContext / CircleToGemini)
├── LocalVideo                            ★ 本地视频
├── MapExploration
├── NotebookFile
├── Link
│   └── Meta
│       ├── YoutubeVideoMeta★ YouTube 视频（不是文件上传）
│       ├── GmailMeta
│       └── GoogleMapsMeta
├── ResponseQuote / UserSelection / Likeness
└── MediaTemplate
    └── Metadata (ImageGen / MusicGen / Veo / None)
```

关键配套类：
```
AttachmentDataService
AttachmentCreationDataService (+ ConfigViewModel / ImagesViewModel / TempUriViewModel)
FileUploadConsentViewModel              ← 上传前用户同意
AttachmentsViewModel / AttachmentOptionsViewModel
RobinRouterArgs$FullScreen$AttachmentPicker
VideoTrimmerViewModel                   ← ★ 视频裁剪器（客户端）
MediaTranslationViewModel
```

遥测（**揭示了上传的分类统计**）：
```
/client_streamz/mobile_assistant/robin/file_upload/file_upload_fragment_result
/client_streamz/mobile_assistant/robin/file_upload/image_attachment_upload_result
```
→ `file_upload` 与 `image_attachment_upload` 是**两条不同的遥测路径**，
说明视频/音频走 `file_upload`，图片走 `image_attachment_upload`。

**结论**：移动端视频输入 = 上传拿到 ref → 作为 `LocalFile`/`VideoMeta` 注入对话 → 服务端解析。
与 web 通道的 file_refs 机制**同构**，差别在绑定进payload 的方式。

---

## 4. 认证层

```
Error creating OAuth2 access token for gRPC calls    ← ★ 证实走 OAuth2 + gRPC
Interrupted while getting OAuth2 token for gRPC calls
Fetching authorization token / Add authorization token
Failed to build authorization header.
OAuth2Credentials instance does not support refreshing the access token.
GetTokenRequest supports only one token type per request...
OAUTH2_COOKIE_REFRESH_SUCCESSFUL / _INTERNAL_ERROR / _RECOVERABLE_FAILURE
SAPISID                                       ← 同时存在（web 通道凭证）
^aas_et/  (未在 AGSA 出现，属 GMS 侧)
```

→ **移动端同时具备 OAuth2(ya29) 与 SAPISID 两条凭证路径**。
这是可行的关键：不需要 Play Integrity 通过的 master token 提取，
OAuth2 token 由 GMS 正常签发。

---

## 5. gRPC service（已定位到 2 个真实 full-method-name）

```
assistant.frontend.v1.CloudArbitrationFrontendProxyService/SendArbitrationRequest
assistant.proactive.v1.ProactiveBackend/Sync
```

Android Service（IPC，非网络）：
```
assistant.mobile.robin.RobinService              ← 主对话 IPC
assistant.mobile.robin.notify.GeminiNotifyService
assistant.nucleus.gallium.NucleusService
assistant.motion.MotionSignalsService
assistant.reminders.bridge.AssistantRemindersBridgeService
```

⚠️ **关键判断**：`RobinService` 是**绑到 GMS 的 Android Service**（binder IPC），
真正的网络请求由 GMS 进程发出。AGSA 侧只有 proto 定义 + 序列化代码。
→ **反代不能走 RobinService binder，必须找到 GMS 的网络层。**

---

## 6. proto 命名空间（`assistant.api.*`）—— 反推 payload 的蓝图

```
assistant.api.client_input.*    TextInputParam / FormInput / IntentInput / TapInput
                               UrlIntentInput / LocationSelectionContent / WorkflowTriggerInput
                               MessageNotification{Read,Reply,Tap}Param / NotificationRequestParam
                               UpdateFormFieldVisibility / SliceDialogInfoInput / WidgetDialogInfoInput
                               WarmerWelcomeInput / IntentUpdateInput

assistant.api.client_op.*       ChatMessageArgs / Text/ShowTextArgs / SpeechOutputArgs
                               PlayMediaArgs + Properties / MediaInitiationOpResult
                               VideoCallArgs + VideoCallProperties   ← 视频通话
                               GACSExecuteArgs / GACSTtsArgs
                               FetchAssistDataResult / ClientReconnectResult
                               ShowHtmlImmersive / ShowSliceCard / ShowNativeForm ...
assistant.api.client_op.core.*  DismissAssistantArgs / KeyboardUpdateArgs
assistant.api.client_op.ui.*    ShowHtmlImmersive / ShowInterpreter / ShowAppWidget / ShowWithApp
                               ExitNativeForm / KeepScreenContents / SetUserQuery
assistant.api.params.*          MessageParams / MediaParams / QueryContextParams / ConversationStateParams
                               ConversationOngoingStateParam / DeviceCapabilities / DeviceProperties
                               InterpreterParams / NgaParam / LanguageParams / SnapshotParams ...
assistant.api.proto.*           AssistantPhotosClientOp.DownloadPhotosArgs
assistant.api.settings.*        DeviceConfig
assistant.api.dialog_state.values.Person
```

另有 `ConversationParams with ContextKey %s had no Protobuf type.` 表明
**上下文是 proto map**（key → ContextValue）。

---

## 7. 其他有用的端点与字符串

```
https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent
https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-lite:generateContent
https://gemini.google.com/mcpframe            ← MCP 帧协议！
https://g.co/gemini/share/%s
https://gemini.google.com/apps / /extensions / /gems/create
gemini.google.com/immersive-view
autopush-notifications-pa.googleapis.com:443notifications-pa.googleapis.com:443
arstreamingsession-pa.googleapis.com:443      ← 流式会话！
https://accountlinking-pa.googleapis.com/*
```

⚠️ 注意：AGSA 里出现的 Gemini 模型是 **2.5 Flash / 2.5 Flash-Lite**，
**没有 argon / Gemini 4**。移动端 Gemini 4 的模型标识应该在服务端或 GMS 侧下发，
客户端可能不硬编码。

---

## 8. 下一步（阶段2：反推参数构造）

### 8.1 最高优先级：定位网络层
目标：找到 AGSA → GMS binder 传的确切 payload。
- `RobinService` 的 AIDL/接口定义（`IClientInputCallback` 之类）
- `ClientInput` proto 的**字段编号**（从 `@Protobuf(tag=...)` 注解可提取！）

⚡ **突破口**：AGSA 里有 `Field has no @Protobuf config`、`@Protobuf(tag=...` 字符串，
说明用的是 protobuf-lite 注解。**从注解可恢复字段编号**，无需 proto 文件。

### 8.2 需要新增的解析能力
1. `code_item` 解析 → 读方法字节码里的 `const-string` 引用，把字符串用回其所属方法/类
   （当前只有全局字符串池，丢失了归属关系）
2. `@Protobuf` 注解扫描 → 恢复 message 字段编号
3. AIDL stub 接口提取 → 确认 binder 方法签名
4. native `.so` 字符串扫描（AGSA 含 .so，可能藏 proto descriptor）

### 8.3 待验证假设
| 假设 | 验证方式 |
|---|---|
| 视频走 `file_upload` → 上传后注入 `LocalFile`+`VideoMeta` | 从 `AttachmentDataService` 方法字节码还原 |
| 移动端上传与 web 通道同端点，那 1003 差异在 payload 绑定 | 对比 `LocalFile` 的 ref 注入格式 vs web 的 `inner[0][3]` |
| argon 在移动端可用但标识不在客户端 | 查 GMS 侧或服务端下发配置 |

---

## 9. 产出清单

| 文件 | 内容 |
|---|---|
| `out/agsa-scan/*.FEATURE_GATE.txt` | 8,340 条（含全部 #CM# / Robin / Bonobo 日志） |
| `out/agsa-scan/*.GRPC_KNOWN.txt` | 13,428 条 |
| `out/agsa-scan/*.VIDEO_MIME.txt` / `.AUDIO_MIME.txt` | 18 / 23 条 ★ |
| `out/agsa-scan/*.UPLOAD.txt` | 18 条 ★ 上传协议 |
| `out/agsa-scan/*.AUTH.txt` | 52 条 ★ 认证 |
| `out/agsa-scan/*.urls.txt` | 959 条 |
| `out/agsa-scan/*.paths.txt` | 2,622 条 |
| `out/agsa-scan/*.classes.txt` | 154,302 条 |
| `out/agsa-scan/*.classes.txt` | 154,302 条 |