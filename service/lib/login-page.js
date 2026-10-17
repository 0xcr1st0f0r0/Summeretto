// service/lib/login-page.js —— /login 凭证绑定页（自包含 HTML，零外部资源）
//
// 这是"网页登录拿 Robin 凭证"的落地界面：
//   用户在真实浏览器里登录 Google → 复制 oauth_token cookie → 粘到本页 →
//   服务端 exchange_token 换 master token → 立刻验证能否换出 ya29.* → 展示结果。
//
// 页面本身不含任何密钥；提交时把 Admin Key 放在 x-admin-key 请求头里。

import { buildLoginUrl, CLIENT_SIG, EMBEDDED_REAUTH_URL } from "./gpsoauth.js";

const STYLE = `
:root{
  --bg:#f7f5f1; --card:#ffffff; --ink:#1f1d1a; --muted:#6b6560;
  --line:#e5e0d8; --accent:#1a73e8; --accent-dk:#1557b0;
  --ok:#137333; --ok-bg:#e6f4ea; --err:#b3261e; --err-bg:#fce8e6;
  --warn:#8a5300; --warn-bg:#fef7e0; --code:#f2efe9;
}
*{box-sizing:border-box}
body{margin:0;padding:32px 16px 64px;background:var(--bg);color:var(--ink);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:760px;margin:0 auto}
h1{font-size:24px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 28px;font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin-bottom:16px}
.step{display:flex;gap:14px;align-items:flex-start;margin-bottom:22px}
.step:last-child{margin-bottom:0}
.num{flex:0 0 28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;margin-top:2px}
.body{flex:1;min-width:0}
.body h3{margin:0 0 6px;font-size:16px;font-weight:600}
.body p{margin:0 0 10px;color:var(--muted);font-size:14px}
a.btn,button.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;
  padding:10px 18px;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer}
a.btn:hover,button.btn:hover{background:var(--accent-dk)}
button.btn[disabled]{opacity:.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.ghost:hover{background:var(--code)}
label{display:block;font-size:13px;font-weight:600;margin:12px 0 5px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;
  font-family:inherit;background:#fdfcfa}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
code{background:var(--code);padding:2px 6px;border-radius:5px;
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:14px;
  overflow-x:auto;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:10px 0}
.hint{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:10px 14px;font-size:13px;margin:12px 0}
.note{font-size:13px;color:var(--muted)}
.res{border-radius:10px;padding:14px 16px;margin-top:14px;font-size:14px;display:none}
.res.ok{background:var(--ok-bg);color:var(--ok);display:block}
.res.err{background:var(--err-bg);color:var(--err);display:block}
.res h4{margin:0 0 8px;font-size:15px}
.res p{margin:0 0 8px;color:inherit}
details{margin-top:10px}
summary{cursor:pointer;color:var(--accent);font-size:13px;font-weight:600}
table{border-collapse:collapse;font-size:13px;margin:8px 0;width:100%}
td{padding:4px 10px 4px 0;vertical-align:top}
td:first-child{color:var(--muted);white-space:nowrap}
.tag{display:inline-block;background:var(--code);border-radius:5px;padding:1px 7px;font-size:12px;color:var(--muted)}
hr{border:0;border-top:1px solid var(--line);margin:20px 0}
`;

/** 服务端渲染的绑定页。 */
export function renderLoginPage({ service = "summeretto", adminEnabled = true } = {}) {
  const loginUrl = buildLoginUrl();
  const reauthUrl = `${EMBEDDED_REAUTH_URL}?tmpl=new_account`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Robin 凭证绑定 · ${service}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <h1>Robin 凭证绑定</h1>
  <p class="sub">一次性网页登录 → 换长期 master token → 服务端自动续期访问令牌。全程不依赖手机。</p>

  ${
    adminEnabled
      ? ""
      : `<div class="card"><div class="hint">当前实例未配置 <code>ADMIN_KEY</code>，绑定端点已禁用。请先在环境变量里设置 <code>ADMIN_KEY</code> 后重启服务。</div></div>`
  }

  <div class="card">
    <div class="step">
      <div class="num">1</div>
      <div class="body">
        <h3>在浏览器里登录 Google 账号</h3>
        <p>用<strong>你要绑定的那个谷歌账号</strong>登录。这是 Google 官方给 Android 设备留的嵌入式登录页
        （<code>flowName=EmbeddedSetupAndroid</code>），账号密码只交给 Google，不经过本服务。</p>
        <a class="btn" href="${esc(loginUrl)}" target="_blank" rel="noopener">打开 Google 登录页</a>
        <button class="btn ghost" type="button" id="copyurl" style="margin-left:8px">复制链接</button>
        <div class="hint">
          ⚠️ <strong>请复制链接，到系统浏览器（Edge / Chrome）的<u>无痕窗口</u>里打开</strong>。
          不要把链接在「应用内预览面板 / 聊天工具的内置浏览器 / 桌面应用内嵌 WebView」里打开 ——
          Google 会把这类容器判定为「不安全的浏览器」，并在<strong>提交账号密码之后</strong>跳出拦截页。
        </div>
        <details>
          <summary>看到「此浏览器或应用可能不安全」？（点这里排障）</summary>
          <p class="note">这是 Google 在<strong>提交凭据那一刻</strong>做的容器可信度判定，与本服务无关。按顺序试：</p>
          <p class="note"><strong>① 换干净容器</strong>：按 <code>Ctrl+Shift+N</code> 开无痕窗口（默认禁用扩展）→
          粘贴上面的链接 → 重新登录。若是从本应用的预览面板里点开的链接，这一步基本就能解决。</p>
          <p class="note"><strong>② 用一键脚本</strong>（推荐；自动开专用窗口 + 自动抓 <code>oauth_token</code>，
          不用开 F12）：<br><code>node tools/browser-login.mjs --email 你的邮箱@gmail.com</code></p>
          <p class="note"><strong>③ 仍被拦截</strong>：加 <code>--ua magic</code>，让浏览器复刻 microG 同款设备指纹
          （真机 Android WebView + <code>MinuteMaid</code> 魔术标记，microG 用它通过 Google 放行）：<br>
          <code>node tools/browser-login.mjs --email 你的邮箱@gmail.com --ua magic</code></p>
        </details>
        <details>
          <summary>登录页一直转圈 / 打不开？</summary>
          <p class="note">登录完成、点过「I agree」之后，页面停在加载动画上是<strong>正常现象</strong>——
          此时 cookie 已经写好了，直接进入第 2 步即可。（一键脚本会自动处理这一步）</p>
          <p class="note">若该页提示不可用，可改试重认证入口：<br><code>${esc(reauthUrl)}</code></p>
        </details>
      </div>
    </div>

    <div class="step">
      <div class="num">2</div>
      <div class="body">
        <h3>复制 <code>oauth_token</code> cookie</h3>
        <p>在登录页所在标签按 <code>F12</code> 打开 DevTools → <strong>Application</strong>（Chrome/Edge）
        或 <strong>存储</strong>（Firefox）→ <strong>Cookies</strong> → <code>https://accounts.google.com</code>，
        找到名为 <code>oauth_token</code> 的那一条，复制它的 <strong>Value</strong>。</p>
        <details>
          <summary>也可以直接在 Console 里一行取出来</summary>
          <pre>document.cookie.match(/(?:^|;\\s*)oauth_token=([^;]+)/)?.[1]</pre>
          <p class="note">注意：<code>oauth_token</code> 是<strong>高敏感凭证</strong>，等价于账号的长期登录态。
          只粘贴到你自己部署的服务里。</p>
        </details>
      </div>
    </div>

    <div class="step">
      <div class="num">3</div>
      <div class="body">
        <h3>粘贴并绑定</h3>
        <form id="f">
          <label for="email">谷歌账号邮箱</label>
          <input id="email" type="email" autocomplete="username" placeholder="you@gmail.com" required>

          <label for="token">oauth_token</label>
          <input id="token" type="text" autocomplete="off" spellcheck="false" placeholder="粘贴 cookie 值" required>

          <label for="key">Admin Key（本服务的 <code>ADMIN_KEY</code>）</label>
          <input id="key" type="password" autocomplete="off" placeholder="仅用于本次请求头，不会存到页面" required>

          <label for="aid">androidId（可选，16 位十六进制）</label>
          <input id="aid" type="text" autocomplete="off" spellcheck="false" placeholder="留空即自动生成">

          <div style="margin-top:16px">
            <button class="btn" id="go" type="submit">开始绑定</button>
          </div>
        </form>
        <div class="res" id="res"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h3 style="margin:0 0 8px;font-size:15px">它是怎么工作的</h3>
    <pre>网页登录  ── oauth_token ──▶  POST android.clients.google.com/auth
                              (ACCESS_TOKEN=1, service=ac2dm)
                                    │
                                    ▼
                            master token  oauth2rt_1/…   ← 长期有效
                                    │
                        按需（约每小时）│  EncryptedPasswd=&lt;master&gt;
                                        │  app=com.google.android.googlequicksearchbox
                                        │  client_sig=${CLIENT_SIG}
                                        ▼
                            ya29.…  ──▶  Robin gRPC 的 Bearer</pre>
    <p class="note">服务端声称自己是 AGSA（Google 搜索/助手 app）。之所以能通过校验，是因为
    AGSA 的签名证书与 GMS Core 是<strong>同一张 Google 平台证书</strong>
    （SHA-1 <code>${CLIENT_SIG}</code>，可由 <code>tools/apksig.py</code> 从 APK 实测复现）。</p>
  </div>
</div>

<script>
var LOGIN_URL = ${JSON.stringify(loginUrl)};
var f = document.getElementById('f');
var res = document.getElementById('res');
var go = document.getElementById('go');

var cu = document.getElementById('copyurl');
if (cu) cu.addEventListener('click', function () {
  var done = function () {
    cu.textContent = '已复制';
    setTimeout(function () { cu.textContent = '复制链接'; }, 1500);
  };
  var manual = function () { window.prompt('手动复制：', LOGIN_URL); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(LOGIN_URL).then(done, manual);
  } else {
    manual();
  }
});

f.addEventListener('submit', async function (e) {
  e.preventDefault();
  go.disabled = true;
  go.textContent = '绑定中…';
  res.className = 'res';
  res.style.display = 'none';
  res.textContent = '';

  var payload = {
    email: document.getElementById('email').value.trim(),
    oauthToken: document.getElementById('token').value.trim(),
    androidId: document.getElementById('aid').value.trim() || undefined
  };

  try {
    var r = await fetch('/admin/gpsoauth', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-key': document.getElementById('key').value
      },
      body: JSON.stringify(payload)
    });
    var j = await r.json();
    if (r.ok && j.ok) {
      showOk(j);
    } else {
      showErr((j && (j.error || j.message)) || ('HTTP ' + r.status));
    }
  } catch (err) {
    showErr('请求失败：' + err.message);
  } finally {
    go.disabled = false;
    go.textContent = '开始绑定';
  }
});

function showOk(j) {
  var origin = location.origin;
  res.className = 'res ok';
  res.innerHTML =
    '<h4>绑定成功，访问令牌已可正常换取</h4>' +
    '<table>' +
    '<tr><td>账号</td><td><code>' + esc(j.email || '') + '</code></td></tr>' +
    '<tr><td>androidId</td><td><code>' + esc(j.androidId || '') + '</code></td></tr>' +
    '<tr><td>服务</td><td><code>' + esc(j.service || '') + '</code></td></tr>' +
    '<tr><td>访问令牌</td><td><span class="tag">' + esc(j.tokenTail || '') + '</span></td></tr>' +
    '</table>' +
    '<p><strong>下一步（重要）：</strong>本次绑定只存活到本进程结束。要让它在重启 / 冷启动后依然有效，' +
    '请把下面的值写进服务端环境变量。</p>' +
    '<pre>' + esc('GSA_EMAIL=' + (j.email || '') + '\\nGSA_MASTER_TOKEN=' + (j.masterToken || '') + '\\nGSA_ANDROID_ID=' + (j.androidId || '')) + '</pre>' +
    '<details open><summary>或者直接注入当前实例（立即生效，重启即失效）</summary><pre>' +
    esc("curl -X POST " + origin + "/admin/gpsoauth -H 'x-admin-key: <ADMIN_KEY>' \\\\\\n" +
        "     -H 'content-type: application/json' \\\\\\n" +
        "     -d '{\\"email\\":\\"" + (j.email || '') + "\\",\\"oauthToken\\":\\"<粘贴 oauth_token>\\"}'") +
    '</pre></details>' +
    '<p class="note">master token 等价于该账号的长期凭证，请按密码级别保管。</p>';
}

function showErr(msg) {
  res.className = 'res err';
  res.innerHTML = '<h4>绑定失败</h4><p>' + esc(msg) + '</p>' +
    '<p class="note">常见原因：oauth_token 复制不全或已过期（重新走第 1 步）、账号邮箱填错、' +
    '或网络无法到达 android.clients.google.com。</p>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
</script>
</body>
</html>`;
}

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
