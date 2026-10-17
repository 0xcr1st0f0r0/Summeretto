/*
 * extract-robin-token.js —— Robin 凭证（OAuth access token）提取器 [Frida]
 * ============================================================================
 *
 * 目标：从 Google 官方 app（AGSA / Gemini）进程里截获 scope =
 *       https://www.googleapis.com/auth/assistant 的 OAuth2 access token（ya29.*）。
 *
 * 逆向依据（全部来自静态分析，见 docs/credential-acquisition.md）：
 *   - Robin gRPC 的鉴权头是 `authorization: Bearer <token>`（构造点 Lbcvm，classes.dex）
 *   - token 由 GMS 的 AANG API（com.google.android.gms.auth.aang.GetTokenRequest）签发
 *     · GetTokenRequest  = Parcelable，跨进程 Binder 传给 GMS Core
 *     · GetTokenResponse = Parcelable，字段 a:String 就是 token 本体
 *   - 回退路径 FallbackGoogleTokenProvider → android.accounts.AccountManager
 *
 * 前提：root 设备 / 可 root 的模拟器 + frida-server（与架构匹配）
 *
 * 用法（示例）：
 *   # 1. 列出进程，找到 AGSA 主进程名
 *   frida-ps -U | grep -i -E "google|velvet"
 *
 *   # 2. attach 并注入（推荐 spawn 模式，覆盖启动早期）
 *   frida -U -f com.google.android.googlequicksearchbox -l extract-robin-token.js --no-pause
 *   #    或对已运行进程
 *   frida -U -n <进程名> -l extract-robin-token.js
 *
 *   # 3. 在设备上正常使用 Gemini / Assistant 发起一次对话，脚本会截获 token
 *   # 4. token 同时写到 /data/local/tmp/robin-token.json
 *
 * 多进程说明：AGSA 是多进程架构（VelvetMultiprocessRoot_Application）。
 *   若主进程没截到，对下列进程名逐个 attach 重试（用 frida-ps 确认实际名字）：
 *     com.google.android.googlequicksearchbox
 *     com.google.android.googlequicksearchbox:search
 *     com.google.android.googlequicksearchbox:interactor
 *     com.google.android.gms            ← 也可直接 hook GMS（所有 token 请求的总入口）
 */

'use strict';

const OUT_FILE = '/data/local/tmp/robin-token.json';
const TOKEN_PREFIX = 'ya29.';          // Google OAuth2 access token 前缀
const DEBUG_VERBOSE = false;           // true = 打印所有 Parcel 字符串（调试用，会刷屏）

const seen = new Set();
const results = [];
let outWritable = true;

// ─────────────────────────────── 输出层 ───────────────────────────────

function writeOut() {
  if (!outWritable) return;
  try {
    const f = new File(OUT_FILE, 'w');
    f.write(JSON.stringify(results, null, 2));
    f.flush();
    f.close();
  } catch (e) {
    outWritable = false;   // 无写权限时静默降级（控制台输出仍有效）
  }
}

function record(token, source, extra) {
  if (typeof token !== 'string') return;
  token = token.trim();
  if (!token.startsWith(TOKEN_PREFIX)) return;
  if (seen.has(token)) return;
  seen.add(token);

  const entry = Object.assign({
    token: token,
    source: source,
    capturedAt: new Date().toISOString(),
    tokenLength: token.length,
  }, extra || {});
  results.push(entry);

  console.log('\n' + '='.repeat(72));
  console.log('[★ TOKEN 截获]  来源: ' + source);
  console.log('  token  : ' + token.slice(0, 32) + '…（共 ' + token.length + ' 字符）');
  if (extra && extra.scope) console.log('  scope  : ' + extra.scope);
  if (extra && extra.account) console.log('  account: ' + extra.account);
  console.log('  已写入 : ' + OUT_FILE + '（共 ' + results.length + ' 条）');
  console.log('='.repeat(72) + '\n');

  writeOut();
  send({ type: 'robin-token', entry: entry });   // 同时发给 frida 宿主
}

// ─────────────────────── 通用：反射 dump 对象字段 ───────────────────────
// 注意：AANG 类是 R8 混淆过的（字段名 a/b/c…），按名字硬编码会在版本间失效，
//      因此这里用反射枚举全部字段，只按“值是否 ya29.”筛选。

function scanFieldsForToken(obj, label, extra) {
  try {
    const cls = obj.getClass();
    let cur = cls;
    while (cur) {
      const fields = cur.getDeclaredFields();
      for (const f of fields) {
        try {
          f.setAccessible(true);
          const v = f.get(obj);
          if (v === null) continue;
          const s = String(v);
          if (s.indexOf(TOKEN_PREFIX) === 0) {
            record(s, label + '.' + f.getName(), extra);
          }
        } catch (e) { /* 忽略单个字段 */ }
      }
      cur = cur.getSuperclass();
      if (cur && String(cur.getName()).indexOf('java.lang.Object') === 0) break;
    }
  } catch (e) { /* 忽略 */ }
}

// ────────────────────── 策略 S1：Parcel 读取侧兜底 ──────────────────────
// 最稳（系统类，跨版本不变）：token 从 GMS 跨进程返回时必经 Parcel.readString。

function hookParcel() {
  try {
    const Parcel = Java.use('android.os.Parcel');
    Parcel.readString.implementation = function () {
      const s = this.readString();
      if (s && s.length > 20 && s.indexOf(TOKEN_PREFIX) === 0) {
        record(s, 'Parcel.readString');
      } else if (DEBUG_VERBOSE && s && s.length > 20) {
        console.log('[Parcel] ' + s.slice(0, 120));
      }
      return s;
    };
    console.log('[+] S1 挂载 : android.os.Parcel.readString（ya29 前缀过滤）');
  } catch (e) {
    console.log('[-] S1 失败 : ' + e.message);
  }
}

// ──────────── 策略 S2：AANG GetTokenResponse（跨进程响应对象）────────────
// 类名不会混淆（AIDL 兼容性要求），字段名会混淆 → 用反射扫描。

function hookAangResponse() {
  let ok = false;
  try {
    const Cls = Java.use('com.google.android.gms.auth.aang.GetTokenResponse');
    Cls.$init.overloads.forEach(function (ov) {
      ov.implementation = function () {
        const ret = ov.apply(this, arguments);
        scanFieldsForToken(this, 'GetTokenResponse<' + arguments.length + '>');
        return ret;
      };
    });
    console.log('[+] S2 挂载 : GetTokenResponse.*<init>（反射扫字段）');
    ok = true;
  } catch (e) {
    // 类还没加载 —— 稍后重试
  }
  if (!ok) setTimeout(hookAangResponse, 2000);
}

// ───────── 策略 S3：GoogleAuthUtil（经典公开 API + 回退路径）─────────

function hookGoogleAuthUtil() {
  let ok = false;
  try {
    const GAU = Java.use('com.google.android.gms.auth.GoogleAuthUtil');
    // getToken(Context, Account, String) / getToken(Context, Account, String, Bundle)
    ['getToken', 'getTokenWithDetails'].forEach(function (mname) {
      if (!GAU[mname]) return;
      GAU[mname].overloads.forEach(function (ov) {
        ov.implementation = function () {
          const args = Array.prototype.slice.call(arguments).map(function (a) {
            try { return a === null ? 'null' : String(a); } catch (e) { return '?'; }
          });
          console.log('[GAU.' + mname + '] args: ' + args.join(' | ').slice(0, 240));
          const ret = ov.apply(this, arguments);
          if (typeof ret === 'string') {
            const scope = args.find(function (a) { return a.indexOf('oauth2:') === 0; }) || '';
            record(ret, 'GoogleAuthUtil.' + mname, { scope: scope });
          } else if (ret) {
            scanFieldsForToken(ret, 'GoogleAuthUtil.' + mname + '→ret');
          }
          return ret;
        };
      });
    });
    console.log('[+] S3 挂载 : GoogleAuthUtil.getToken*');
    ok = true;
  } catch (e) { /* 未加载，重试 */ }
  if (!ok) setTimeout(hookGoogleAuthUtil, 2000);
}

// ────── 策略 S4：AccountManager 回退路径（FallbackGoogleTokenProvider）──────

function hookAccountManager() {
  let ok = false;
  try {
    const AM = Java.use('android.accounts.AccountManager');
    AM.getAuthToken.overloads.forEach(function (ov) {
      ov.implementation = function () {
        const args = Array.prototype.slice.call(arguments).map(function (a) {
          try { return a === null ? 'null' : String(a); } catch (e) { return '?'; }
        });
        console.log('[AccountManager.getAuthToken] ' + args.join(' | ').slice(0, 200));
        const ret = ov.apply(this, arguments);
        // 该 API 返回 Bundle/Future，token 在调用方解包 —— 这里只记录调用，token 由 S1 兜底
        if (ret) scanFieldsForToken(ret, 'AccountManager.getAuthToken→ret');
        return ret;
      };
    });
    console.log('[+] S4 挂载 : AccountManager.getAuthToken*');
    ok = true;
  } catch (e) { /* 系统类一般都会在 —— 失败属异常 */ }
  if (!ok) setTimeout(hookAccountManager, 2000);
}

// ────────────────────── 策略 S5：AGSA 内部 CallCredentials ──────────────────────
// Lbcvm（classes.dex）= 组装 `Bearer %s` 的 CallCredentials。类名为 R8 短名，
// 仅在同一 APK 版本内有效（17.66.12）。用类加载事件延迟命中。

function hookRobinteropCredentials() {
  let ok = false;
  try {
    const C = Java.use('bcvm');   // Lbcvm; → Frida 里去掉 L / ;
    C.c.overloads.forEach(function (ov) {
      ov.implementation = function () {
        const ret = ov.apply(this, arguments);
        console.log('[bcvm.c] CallCredentials 取 token 调用');
        if (ret) scanFieldsForToken(ret, 'bcvm.c→ret');
        return ret;
      };
    });
    console.log('[+] S5 挂载 : bcvm.c（Robin CallCredentials，17.66.12 专用）');
    ok = true;
  } catch (e) { /* 类名随版本变化，失败可忽略 */ }
  if (!ok) setTimeout(hookRobinteropCredentials, 3000);
}

// ─────────────────────────────── 启动 ───────────────────────────────

Java.perform(function () {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Robin Token 提取器 —— 目标 scope: .../auth/assistant          ║');
  console.log('║  输出文件: ' + OUT_FILE);
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('[*] 进程: ' + Process.arch + ' / pid=' + Process.id);

  hookParcel();
  hookAangResponse();
  hookGoogleAuthUtil();
  hookAccountManager();
  hookRobinteropCredentials();

  console.log('\n[*] 全部策略已就位。现在在设备上使用 Gemini / Assistant 发一条消息…\n');
});
