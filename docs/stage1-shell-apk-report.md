# 阶段1 静态扫描报告：Gemini Shell APK

**目标**：`com.google.android.apps.bard` v1.0.971139365（versionCode 341）
**来源**：`d.apkpure.net`（APKPure XAPK），解包后 base APK 5,080,199 B
**日期**：2026-10-15
**工具**：本项目自研零依赖解析器 `tools/dexlib.py` + `tools/axml.py`

---

## 1. 结论：壳包确认无任何网络栈

扫描21,087 条字符串，**协议层命中全部为 0**：

| 规则 | 命中 | 说明 |
|---|---|---|
| gRPC full-method-name | **0** | 无 `pkg.Service/Method` |
| proto message 全名 | **0** | 无 `pkg.Message` |
| batchexecute / RPC ID | **0** | — |
| 上传协议（contrib_service / push.clients6 / resumable） | **0** | — |
| **video/* mime** | **0** | — |
| **audio/* mime** | **0** | — |
| OAuth（ya29 / aas_et / gpsoauth） | **0** | — |

DEX 规模：

| DEX | 大小 | strings | types | methods | classes |
|---|---|---|---|---|---|
| classes.dex | 0.48 MB | 3,368 | 1,509 | 4,668 | 560 |
| classes2.dex | 3.10 MB | 15,658 | 5,614 | 27,626 | 4,268 |
| classes3.dex | 0.33 MB | 2,061 | 661 | 3,519 | 388 |
| **合计** | 3.91 MB | 21,087 | 7,784 | 35,813 | 5,216 |

**5,216 个类定义全是 AndroidX / Play Core / Phenotype / 小组件框架噪声**，
业务类仅 5 个（`shellapp/` 全部）。

---

## 2. 业务类清单（全部）

```
com.google.android.apps.bard.shellapp.BardEntryPointActivity          ← 主入口
com.google.android.apps.bard.shellapp.ErrorActivity
com.google.android.apps.bard.shellapp.InAppReviewActivity
com.google.android.apps.bard.shellapp.RememberThisShareTargetActivity
com.google.android.apps.bard.shellapp.VisualInterpreterShortcutActivity
com.google.android.apps.bard.widget.RobinToolBarAppWidgetReceiver
com.google.android.apps.bard.widget.RobinWidgetEntryPointActivity
com.google.android.apps.bard.Bard_Application
com.google.android.apps.bard.shellapp.config.AgsaConfig              ← 只是版本检查器
```

---

## 3. ★ 关键发现：manifest 直接证实音视频入口存在

`BardEntryPointActivity` 的 intent-filter 里**显式声明**了音视频：

```xml
<intent-filter>
  <action android:name="android.intent.action.SEND" />
  <category android:name="android.intent.category.DEFAULT" />
  <data android:mimeType="image/*" />
  <data android:mimeType="audio/*" />     ← 音频入口
  <data android:mimeType="video/*" />     ← 视频入口
  <data android:mimeType="text/plain" />
  <data android:mimeType="text/csv" />
  <data android:mimeType="application/pdf" />
  <data android:mimeType="application/rtf" />
  <data android:mimeType="application/vnd.ms-excel" />
  <data android:mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
  <data android:mimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
  <data android:mimeType="application/vnd.google-apps.spreadsheet" />
  <data android:mimeType="application/vnd.google-apps.document" />
</intent-filter>
<intent-filter>   ← SEND_MULTIPLE 同样含audio/* video/*
  <action android:name="android.intent.action.SEND_MULTIPLE" />
  ...
</intent-filter>
```

**这条证据链的价值**：
1. 音视频输入能力是**产品明确承诺的功能**，不是灰度实验 —— 用户实测与代码声明一致
2. 壳包接收 `ACTION_SEND` + `EXTRA_STREAM`（URI），随后转交 AGSA
3. 所以**协议定义在 AGSA 侧**，我们要找的东西一定在 `com.google.android.googlequicksearchbox`

### manifest 其他关键属性
```
min_sdk = 32target_sdk = 37
usesCleartextTraffic = False          ← 只允许 HTTPS
extractNativeLibs = False
appComponentFactory = androidx.core.app.CoreComponentFactory
permissions = [WAKE_LOCK, ACCESS_NETWORK_STATE, GET_PACKAGE_SIZE]   ← 仅 3 个，无网络/存储权限
```

---

## 4. 壳包 → AGSA 的跳转契约

| 项| 值 |
|---|---|
| 目标包 | `com.google.android.googlequicksearchbox`（Google 搜索App / AGSA） |
| 函数 | `getBardDeepLinkIntent` |
| 落地 URL | `https://bard.google.com/android?source=bardshell` |
| 带 feature | `https://bard.google.com/android?source=bardshell&feature=<FEATURE>` |
| 视觉解释 | `...&feature=accessibility_vi` |
| 商店落地页 | `https://gemini.google.com/gemini/download/mobile`（autoVerify=true） |
| 遥测 | `/client_streamz/bard_shell_app_android/gemini_shell_app_invocation` |
| | `/client_streamz/bard_shell_app_android/trigger_agsa` |

### 版本门控字符串（反代不需要，但说明依赖强度）
```
AGSA_DISABLED
FAILURE_AGSA_VERSION_TOO_LOW
UPDATE_AGSA / Update AGSA
agsa_application_build
AGSA disabled
```
壳包会**检查 AGSA 版本并要求更新**—— 这条对"真机跑"是个坑（必须装匹配版本 AGSA）。

### 内部代号确认
- **Robin** = assistant surface / widget（`RobinToolBarAppWidget`、`RobinWidgetEntryPointActivity`）
- **VisualInterpreter (VI)** = 无障碍视觉解释（类名 `VisualInterpreterShortcutActivity`，日志 `/accessibility_vi`）
- widget 需要 `feature` extra：`"Widget tap: feature=%s gridSize=%s"`

---

## 5. 下一步（阶段1 续）

已下载 **AGSA `Google_17.66.12.ve.arm64` XAPK（258,135,310 B）**，
下一步：对 AGSA 做同样的 DEX 字符串扫描，重点找：

1. gRPC service/method（proto full name）
2. 音视频 mime 白名单（应有 video/mp4 等具体项）
3. 附件上传端点与 header
4. batchexecute RPC ID
5. 认证链路（master token / ya29 / OAuth）

若AGSA 走 gRPC（NotebookLM 已证明 Google app 的 gRPC 逆向可行），
则用 notebooklm 的方法面枚举法：
```
strings libflutter_artifacts.so | grep -oE '/[a-z][a-z0-9_.]+\.[A-Z][A-Za-z0-9]+/[A-Z][A-Za-z0-9]+'
```
但 AGSA 是 **native Kotlin 而非 Flutter** —— 可能直接 `strings` + DEX 就能扫到，
不需要 blutter。这是相对 NotebookLM 的**优势**。

---

## 6. 工具产出

| 文件 | 说明 |
|---|---|
| `tools/dexlib.py` | 零依赖 DEX 解析器（string/type/proto/field/method/class 全池提取） |
| `tools/axml.py` | 零依赖 AXML 解析器（manifest intent-filter / meta-data 提取） |
| `tools/stage1_scan.py` | 阶段1 扫描驱动 |
| `out/scan/*.txt` | 本次扫描全部产出 |