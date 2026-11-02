// service/lib/admin-page.js —— /admin 后台管理页（自包含 HTML，零外部资源）
//
// 布局与视觉沿用 login-page.js 的同一套变量，保持风格一致。
//
// ★ 安全约定：
//   · 页面**不含** ADMIN_KEY —— 登录后服务端下发的是 HMAC 签名 Cookie，
//     页面后续所有请求靠 Cookie 说话（HttpOnly，JS 也读不到）。
//   · 所有数据用 textContent 注入，不拼 innerHTML —— 上游返回的文本一律当不可信。

const STYLE = `
:root{
  --bg:#f7f5f1; --card:#ffffff; --ink:#1f1d1a; --muted:#6b6560;
  --line:#e5e0d8; --accent:#1a73e8; --accent-dk:#1557b0;
  --ok:#137333; --ok-bg:#e6f4ea; --err:#b3261e; --err-bg:#fce8e6;
  --warn:#8a5300; --warn-bg:#fef7e0; --code:#f2efe9;
}
*{box-sizing:border-box}
body{margin:0;padding:28px 16px 56px;background:var(--bg);color:var(--ink);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 20px;font-size:13.5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:14px}
.card h2{font-size:15px;margin:0 0 12px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:14px;align-items:start}
.card.span2{grid-column:1/-1}
button.btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;
  font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit}
button.btn:hover{background:var(--accent-dk)}
button.btn[disabled]{opacity:.5;cursor:not-allowed}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.ghost:hover{background:var(--code)}
label{display:block;font-size:13px;font-weight:600;margin:10px 0 5px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font-size:14px;
  font-family:inherit;background:#fdfcfa}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;white-space:nowrap;width:38%}
td{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;word-break:break-all}
.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.b-ok{background:var(--ok-bg);color:var(--ok)} .b-err{background:var(--err-bg);color:var(--err)}
.b-warn{background:var(--warn-bg);color:var(--warn)} .b-mute{background:var(--code);color:var(--muted)}
.bar{height:8px;border-radius:5px;background:var(--code);overflow:hidden;margin:5px 0 2px}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:5px}
.bar.hot>i{background:var(--err)} .bar.warm>i{background:#ef9f27}
pre.log{background:#1f1d1a;color:#e8e4dd;padding:12px 14px;border-radius:10px;overflow:auto;
  font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:340px;margin:0}
pre.log .lv-warn{color:#ffca6a} pre.log .lv-error{color:#ff8a80}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.mut{color:var(--muted);font-size:12.5px}
.err{color:var(--err);font-size:13px;margin-top:8px}
.ok{color:var(--ok);font-size:13px;margin-top:8px}
.foot{color:var(--muted);font-size:12px;text-align:center;margin-top:22px}
`;

/** 登录视图 */
function loginView() {
  return `
<div class="wrap" style="max-width:420px">
  <h1>Summeretto 后台</h1>
  <p class="sub">请输入 Admin Key（ADMIN_KEY）以进入管理后台</p>
  <div class="card">
    <label for="ak">Admin Key</label>
    <input id="ak" type="password" autocomplete="current-password" placeholder="ADMIN_KEY">
    <div class="row" style="margin-top:14px">
      <button class="btn" id="btn">进入后台</button>
    </div>
    <div class="err" id="msg"></div>
  </div>
  <p class="foot">登录后由服务端下发签名 Cookie（HttpOnly），页面不保存 Admin Key</p>
</div>
<script>
const ak=document.getElementById('ak'),btn=document.getElementById('btn'),msg=document.getElementById('msg');
async function go(){
  msg.textContent=''; btn.disabled=true;
  try{
    const r=await fetch('/admin/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({key:ak.value})});
    const j=await r.json();
    if(r.ok&&j.ok){location.reload();return;}
    msg.textContent=j.error||('HTTP '+r.status);
  }catch(e){msg.textContent='请求失败：'+e.message;}
  btn.disabled=false;
}
btn.addEventListener('click',go);
ak.addEventListener('keydown',e=>{if(e.key==='Enter')go();});
ak.focus();
</script>`;
}

/** 后台视图 */
function dashView() {
  return `
<div class="wrap">
  <h1>Summeretto 后台</h1>
  <p class="sub" id="hd">加载中…</p>

  <div class="grid">
    <div class="card">
      <h2>存活信息 <span id="vb"></span></h2>
      <table id="tLive"></table>
    </div>

    <div class="card">
      <h2>会话信息（HTTP/2） <span id="sb"></span></h2>
      <table id="tSess"></table>
    </div>

    <div class="card span2">
      <h2>额度信息
        <button class="btn ghost" id="bUsage">查询额度</button>
        <span class="mut" id="uAt"></span>
      </h2>
      <div id="usage"><p class="mut">尚未查询。点击「查询额度」向 GetUsageInfo 拉取账号剩余额度与重置时间。</p></div>
    </div>

    <div class="card">
      <h2>心跳测试
        <button class="btn ghost" id="bHb">执行心跳</button>
      </h2>
      <p class="mut">① PING 探 HTTP/2 传输层存活（半死连接只有它能暴露）<br>② GetUserStatus 端到端（令牌有效 + 上游可达）</p>
      <div id="hb"></div>
    </div>

    <div class="card">
      <h2>运行时开关</h2>
      <table id="tLim"></table>
    </div>

    <div class="card span2">
      <h2>最近日志
        <label class="row mut" style="margin:0;font-weight:400">
          <input type="checkbox" id="auto" style="width:auto;margin:0" checked> 每 5 秒自动刷新
        </label>
        <button class="btn ghost" id="bLogs">刷新</button>
      </h2>
      <pre class="log" id="logs"></pre>
    </div>
  </div>

  <p class="foot">
    <button class="btn ghost" id="bLogout">退出登录</button>
    · 日志环形缓冲仅存进程内，重启即清空
  </p>
</div>

<script>
const $=s=>document.querySelector(s);
const td=(t,v)=>{const tr=document.createElement('tr');const a=document.createElement('th');a.textContent=t;
  const b=document.createElement('td');b.textContent=v;tr.append(a,b);return tr;};
const badge=(el,txt,cls)=>{el.textContent=txt;el.className='badge b-'+cls;};
const num=v=>v===null||v===undefined?'—':v;
const dur=ms=>ms===null||ms===undefined?'—':(ms<1000?ms+' ms':(ms/1000).toFixed(1)+' s');
const pct=v=>v===null||v===undefined?'—':(Math.round(v*10)/10)+'%';

function badgeFor(v){
  if(v==='valid')return['正常','ok'];
  if(v==='unbound')return['未绑定','warn'];
  if(v==='expired'||v==='stale')return['失效','err'];
  return['未验证','mute'];
}

async function loadState(){
  let s;
  try{const r=await fetch('/admin/api/state');s=await r.json();}
  catch(e){$('#hd').textContent='状态获取失败：'+e.message;return;}
  if(!s.ok){$('#hd').textContent='未授权';return;}

  const c=s.credential||{};
  const [vt,vc]=badgeFor(c.verdict);
  badge($('#vb'),vt,vc);
  badge($('#sb'),s.session.alive?'存活':'无会话',s.session.alive?'ok':'warn');
  $('#hd').textContent='上游 '+s.upstream+' · 账号 '+(c.email||'—')+' · 运行时长 '+
    Math.floor(s.uptimeSec/3600)+'h'+Math.floor((s.uptimeSec%3600)/60)+'m';

  const L=$('#tLive');L.innerHTML='';
  L.append(
    td('服务',s.service),
    td('上游',s.upstream),
    td('凭证判定',c.verdict+'（'+(c.origin||'-')+'）'),
    td('主令牌',c.masterTokenTail||'—'),
    td('令牌剩余',dur(c.expiresInSec!=null?c.expiresInSec*1000:null)),
    td('铸造成功/失败',c.mintOk+' / '+c.mintFail),
    td('在途请求',s.inflight.inflight+'（峰值 '+s.inflight.peak+' · 累计 '+s.inflight.totalStarted+'）'),
    td('内存 RSS / 堆',s.memory.rssMb+' MB / '+s.memory.heapUsedMb+' MB'),
  );

  const S=$('#tSess');S.innerHTML='';
  const se=s.session;
  S.append(
    td('状态',se.alive?'存活':'未建立'),
    td('已存活',dur(se.ageMs)),
    td('建立于',se.bornAt||'—'),
    td('本连接请求数',se.requests+'（上限 '+se.limits.maxRequests+'）'),
    td('毒化 / 轮换',se.poisoned+' / '+se.rotated),
    td('心跳间隔 / 超时',dur(se.limits.pingIdleMs)+' / '+dur(se.limits.pingTimeoutMs)),
  );

  const M=$('#tLim');M.innerHTML='';
  const li=s.limits;
  M.append(
    td('入站上限',li.maxBodyBytes+' B'),
    td('附件上限',li.maxAttachments),
    td('会话隔离',li.isolateConversations?'开':'关'),
    td('限流',li.rateLimitMax+' req/min'),
    td('总时限 / 真空宽限',dur(li.robinTimeoutMs)+' / '+dur(li.robinIdleMs)),
    td('凭证落盘',li.credentialPersist?'开（.env）':'关'),
  );
}

async function loadLogs(){
  try{
    const r=await fetch('/admin/api/logs?limit=200');const j=await r.json();
    const pre=$('#logs');pre.innerHTML='';
    const lines=(j.entries||[]).slice().reverse();
    for(const e of lines){
      const sp=document.createElement('span');
      if(e.level==='warn')sp.className='lv-warn';else if(e.level==='error')sp.className='lv-error';
      sp.textContent=e.ts.slice(11,23)+' ['+e.level+'] '+e.text+'\\n';
      pre.append(sp);
    }
    if(!lines.length)pre.textContent='（暂无日志）';
  }catch(e){/* 忽略 */}
}

async function doHeartbeat(){
  const box=$('#hb');box.innerHTML='<p class="mut">执行中…</p>';
  try{
    const r=await fetch('/admin/api/heartbeat',{method:'POST'});
    const j=await r.json();
    const p=j.ping||{},u=j.upstream||{};
    box.innerHTML='';
    const t=document.createElement('table');
    t.append(
      td('① PING（传输层）',p.ok?('正常 · '+dur(p.ms)):('失败 · '+(p.error||'-'))),
      td('② 上游（端到端）',u.ok?('正常 · '+dur(u.ms)+(u.modeCount!=null?' · 档位 '+u.modeCount+' 项':'')):('失败 · '+(u.error||u.grpcMessage||'-'))),
      td('总耗时',dur(j.totalMs)),
    );
    box.append(t);
    const msg=document.createElement('div');
    msg.className=j.ok?'ok':'err';
    msg.textContent=j.ok?'心跳通过':'心跳异常';
    box.append(msg);
    loadState();
  }catch(e){box.innerHTML='<p class="err">心跳请求失败：'+e.message+'</p>';}
}

async function doUsage(){
  const box=$('#usage');box.innerHTML='<p class="mut">查询中…</p>';
  try{
    const r=await fetch('/admin/api/usage',{method:'POST'});
    const j=await r.json();
    box.innerHTML='';
    if(!j.ok){
      const p=document.createElement('p');p.className='err';
      p.textContent='查询失败：'+(j.error||'未知错误');box.append(p);return;
    }
    const pools=j.pools||[];
    if(!pools.length){const p=document.createElement('p');p.className='mut';p.textContent='未返回额度池';box.append(p);}
    for(const pool of pools){
      const wrap=document.createElement('div');wrap.style.margin='10px 0 16px';
      const h=document.createElement('div');
      h.textContent=(pool.type==='five_hour'?'5 小时窗口':'周窗口');
      const bar=document.createElement('div');bar.className='bar';
      const fill=document.createElement('i');
      const used=pool.usedPercent;
      if(used!=null){fill.style.width=Math.max(0,Math.min(100,used))+'%';}
      bar.append(fill);
      if(used!=null&&used>=90)bar.className='bar hot';else if(used!=null&&used>=70)bar.className='bar warm';
      const meta=document.createElement('div');meta.className='mut';
      meta.textContent='已用 '+pct(pool.usedPercent)+' · 剩余 '+pct(pool.remainingPercent)+
        ' · 重置 '+(pool.resetAt||'—');
      wrap.append(h,bar,meta);box.append(wrap);
    }
    $('#uAt').textContent='查询于 '+(j.checkedAt||'').slice(11,19);
  }catch(e){box.innerHTML='<p class="err">查询失败：'+e.message+'</p>';}
}

$('#bHb').addEventListener('click',doHeartbeat);
$('#bUsage').addEventListener('click',doUsage);
$('#bLogs').addEventListener('click',loadLogs);
$('#bLogout').addEventListener('click',async()=>{
  await fetch('/admin/logout',{method:'POST'});
  location.reload();
});
let timer=setInterval(()=>{loadState();loadLogs();},5000);
$('#auto').addEventListener('change',e=>{
  if(e.target.checked){timer=setInterval(()=>{loadState();loadLogs();},5000);}
  else{clearInterval(timer);}
});
loadState();loadLogs();
</script>`;
}

/**
 * 渲染 /admin 页面。
 * @param {object} [o]
 * @param {boolean} [o.authenticated] 是否已登录（决定给登录页还是后台）
 */
export function renderAdminPage({ authenticated = false } = {}) {
  const body = authenticated ? dashView() : loginView();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Summeretto 后台</title>
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}
