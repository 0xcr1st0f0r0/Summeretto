// service/lib/admin-page.js —— /admin 后台管理页（自包含 HTML，零外部资源）
//
// 布局与视觉沿用 login-page.js 的同一套暖色变量，保持风格一致。
// 结构：单列全宽卡片，自上而下 ——
//   额度信息 → 存活信息 → 会话信息 → 心跳测试 → 最近日志
//
// ★ 安全约定：
//   · 页面**不含** ADMIN_KEY —— 登录后服务端下发的是 HMAC 签名 Cookie，
//     页面后续所有请求靠 Cookie 说话（HttpOnly，JS 也读不到）。
//   · 所有数据用 textContent 注入，不拼 innerHTML —— 上游返回的文本一律当不可信。

const STYLE = `
:root{
  --bg:#f6f4f0; --card:#ffffff; --ink:#1c1a17; --muted:#736c64;
  --line:#e8e3db; --line-soft:#f0ece5; --accent:#1a73e8; --accent-dk:#1557b0;
  --ok:#137333; --ok-bg:#e6f4ea; --err:#b3261e; --err-bg:#fce8e6;
  --warn:#8a5300; --warn-bg:#fef7e0; --code:#f5f2ec; --dark:#211f1c;
}
*{box-sizing:border-box}
body{margin:0;padding:34px 20px 60px;background:var(--bg);color:var(--ink);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto}

/* ── 页头 ── */
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;
  flex-wrap:wrap;margin-bottom:22px}
h1{font-size:21px;margin:0 0 5px;letter-spacing:-.015em;font-weight:600}
.sub{color:var(--muted);margin:0;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.top-actions{display:flex;align-items:center;gap:14px;padding-top:4px}
.switch{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer;user-select:none}
.switch input{width:auto;margin:0;accent-color:var(--accent)}

/* ── 卡片（单列全宽）── */
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;
  padding:22px 24px;margin-bottom:16px;box-shadow:0 1px 2px rgba(28,26,23,.04)}
.card>h2{font-size:15px;margin:0 0 16px;font-weight:600;letter-spacing:-.005em;
  display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.card>h2 .spacer{flex:1}

/* ── 指标瓦片 ── */
/* 用「每格自带描边」而不是「背景色挖格线」：后者在瓦片数不整除列数时，
   末尾的空格子会露出容器底色，看着像没画完。 */
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px}
.tile{background:var(--card);border:1px solid var(--line-soft);border-radius:10px;padding:12px 14px}
.tile .k{display:block;font-size:11.5px;color:var(--muted);margin-bottom:3px;letter-spacing:.02em}
.tile .v{display:block;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  word-break:break-all;line-height:1.45}
.tile .v.dim{color:var(--muted)}

/* ── 徽章 ── */
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.b-ok{background:var(--ok-bg);color:var(--ok)} .b-err{background:var(--err-bg);color:var(--err)}
.b-warn{background:var(--warn-bg);color:var(--warn)} .b-mute{background:var(--code);color:var(--muted)}

/* ── 按钮 ── */
button{font-family:inherit}
button.btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:7px 15px;
  font-size:13px;font-weight:600;cursor:pointer}
button.btn:hover{background:var(--accent-dk)}
button.btn[disabled]{opacity:.45;cursor:not-allowed}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
button.ghost:hover{background:var(--code);color:var(--ink)}
button.ghost[disabled]{opacity:.45;cursor:not-allowed}

/* ── 额度 ── */
.pool{padding:14px 0;border-bottom:1px dashed var(--line)}
.pool:last-child{border-bottom:0;padding-bottom:2px}
.pool .pl{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:8px}
.pool .pn{font-size:14px;font-weight:600}
.pool .pr{font-size:13px;color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.bar{height:10px;border-radius:6px;background:var(--code);overflow:hidden}
.bar>i{display:block;height:100%;background:var(--accent);border-radius:6px;transition:width .35s ease}
.bar.warm>i{background:#ef9f27} .bar.hot>i{background:var(--err)}
.pool .meta{margin-top:7px;font-size:12.5px;color:var(--muted)}

/* ── 心跳结果 ── */
.hb-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line-soft)}
.hb-row:last-of-type{border-bottom:0}
.hb-row .lbl{flex:1;font-size:13.5px}
.hb-row .lbl small{display:block;color:var(--muted);font-size:12px;margin-top:1px}
.hb-row .ms{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;color:var(--muted)}

/* ── 日志 ── */
pre.log{background:var(--dark);color:#e8e4dd;padding:16px 18px;border-radius:12px;overflow:auto;
  font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:420px;margin:0;
  white-space:pre-wrap;word-break:break-all}
pre.log .lv-warn{color:#ffca6a} pre.log .lv-error{color:#ff8a80}
pre.log .lv-ts{color:#8f8a80}

/* ── 登录 ── */
.login{max-width:400px;margin:14vh auto 0}
label.lk{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input[type=password],input[type=text]{width:100%;padding:11px 13px;border:1px solid var(--line);
  border-radius:9px;font-size:14px;font-family:inherit;background:#fdfcfa}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}
.msg{color:var(--err);font-size:13px;margin-top:12px;min-height:18px}
.foot{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}
.mut{color:var(--muted);font-size:13px}
`;

/** 登录视图 */
function loginView() {
  return `
<div class="wrap login">
  <h1>Summeretto 后台</h1>
  <p class="sub">请输入 Admin Key 以进入管理后台</p>
  <div class="card" style="margin-top:20px">
    <label class="lk" for="ak">Admin Key</label>
    <input id="ak" type="password" autocomplete="current-password" placeholder="ADMIN_KEY">
    <div style="margin-top:16px"><button class="btn" id="btn">进入后台</button></div>
    <div class="msg" id="msg"></div>
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
  <header class="top">
    <div>
      <h1>Summeretto 后台</h1>
      <p class="sub" id="hd">加载中…</p>
    </div>
    <div class="top-actions">
      <label class="switch"><input type="checkbox" id="auto" checked>每 5 秒自动刷新</label>
      <button class="btn ghost" id="bLogout">退出登录</button>
    </div>
  </header>

  <section class="card">
    <h2>额度信息
      <span class="spacer"></span>
      <button class="btn ghost" id="bUsage">查询额度</button>
      <span class="mut" id="uAt"></span>
    </h2>
    <div id="usage"><p class="mut">尚未查询。点击「查询额度」向 GetUsageInfo 拉取账号剩余额度与重置时间。</p></div>
  </section>

  <section class="card">
    <h2>存活信息 <span id="vb"></span></h2>
    <div class="tiles" id="tLive"></div>
  </section>

  <section class="card">
    <h2>会话信息（HTTP/2） <span id="sb"></span></h2>
    <div class="tiles" id="tSess"></div>
  </section>

  <section class="card">
    <h2>心跳测试
      <span class="spacer"></span>
      <button class="btn ghost" id="bHb">执行心跳</button>
    </h2>
    <div id="hb"></div>
  </section>

  <section class="card">
    <h2>最近日志
      <span class="spacer"></span>
      <span class="mut" id="logInfo"></span>
      <button class="btn ghost" id="bLogs">刷新</button>
    </h2>
    <pre class="log" id="logs"></pre>
  </section>

  <p class="foot">日志环形缓冲仅存进程内存，重启即清空</p>
</div>

<script>
const $=s=>document.querySelector(s);
const dur=ms=>(ms===null||ms===undefined)?'—':(ms<1000?ms+' ms':(ms/1000).toFixed(1)+' s');
const pct=v=>(v===null||v===undefined)?'—':(Math.round(v*10)/10)+'%';

function tile(label,value,dim){
  const d=document.createElement('div');d.className='tile';
  const k=document.createElement('span');k.className='k';k.textContent=label;
  const v2=document.createElement('span');v2.className='v'+(dim?' dim':'');v2.textContent=value;
  d.append(k,v2);return d;
}
function badge(el,txt,cls){el.textContent=txt;el.className='badge b-'+cls;}
function badgeFor(v){
  if(v==='valid')return['正常','ok'];
  if(v==='unbound')return['未绑定','warn'];
  if(v==='expired')return['已过期','warn'];
  if(v==='stale')return['已失效','err'];
  return['未验证','mute'];
}
/** 判定值 → 中文（面板里别把 valid / stale 这类内部词直接甩给人看） */
const verdictText=v=>({valid:'正常',unbound:'未绑定',expired:'已过期',stale:'已失效',unverified:'未验证'}[v]||v||'—');

async function loadState(){
  let s;
  try{const r=await fetch('/admin/api/state');s=await r.json();}
  catch(e){$('#hd').textContent='状态获取失败：'+e.message;return;}
  if(!s.ok){$('#hd').textContent='未授权';return;}

  const c=s.credential||{};
  const [vt,vc]=badgeFor(c.verdict);
  badge($('#vb'),vt,vc);
  badge($('#sb'),s.session.alive?(s.session.connected?'存活':'建连中'):'无会话',
        s.session.alive?'ok':'warn');

  const up=Math.floor(s.uptimeSec/3600), mi=Math.floor((s.uptimeSec%3600)/60);
  $('#hd').textContent=(c.account||'未绑定账号')+' · '+s.upstream+' · 运行 '+up+'h'+mi+'m';

  const L=$('#tLive');L.innerHTML='';
  L.append(
    tile('凭证判定',verdictText(c.verdict)),
    tile('令牌剩余',dur(c.expiresInSec!=null?c.expiresInSec*1000:null)),
    tile('铸造成功 / 失败',(c.mintOk??0)+' / '+(c.mintFail??0)),
    tile('主令牌',c.masterTokenTail||'—'),
    tile('在途请求',s.inflight.inflight+'（峰值 '+s.inflight.peak+'）'),
    tile('累计请求',String(s.inflight.totalStarted)),
    tile('内存 RSS',s.memory.rssMb+' MB'),
    tile('模型档位',s.modes.count+' 项'),
  );

  const S=$('#tSess');S.innerHTML='';
  const se=s.session;
  S.append(
    tile('连接状态',se.alive?'存活':'未建立'),
    tile('已存活',dur(se.ageMs)),
    tile('本连接请求数',String(se.requests)),
    tile('毒化次数',String(se.poisoned)),
    tile('轮换次数',String(se.rotated)),
    tile('存活上限',dur(se.limits.maxAgeMs)),
  );
}

async function loadLogs(){
  try{
    const r=await fetch('/admin/api/logs?limit=200');const j=await r.json();
    const pre=$('#logs');pre.innerHTML='';
    const lines=(j.entries||[]).slice().reverse();
    for(const e of lines){
      const ts=document.createElement('span');ts.className='lv-ts';ts.textContent=e.ts.slice(11,23)+'  ';
      const sp=document.createElement('span');
      if(e.level==='warn')sp.className='lv-warn';else if(e.level==='error')sp.className='lv-error';
      sp.textContent=e.text+'\\n';
      pre.append(ts,sp);
    }
    if(!lines.length)pre.textContent='（暂无日志）';
    const b=j.buffer||{};
    $('#logInfo').textContent='缓冲 '+b.kept+'/'+b.max+' 条 · 累计 '+b.total+' 条';
  }catch(e){/* 忽略 */}
}

async function doHeartbeat(){
  const box=$('#hb');box.innerHTML='<p class="mut">执行中…</p>';
  try{
    const r=await fetch('/admin/api/heartbeat',{method:'POST'});
    const j=await r.json();
    const p=j.ping||{},u=j.upstream||{};
    box.innerHTML='';
    const mk=(ok,label,desc,ms,extra)=>{
      const row=document.createElement('div');row.className='hb-row';
      const l=document.createElement('div');l.className='lbl';l.textContent=label;
      const s=document.createElement('small');s.textContent=desc;l.append(s);
      const m=document.createElement('span');m.className='ms';m.textContent=ms;
      const b=document.createElement('span');b.className='badge b-'+(ok?'ok':'err');b.textContent=ok?'正常':'异常';
      row.append(l,m,b);return row;
    };
    box.append(
      mk(Boolean(p.ok),'① PING · 传输层存活','半死连接只有它能暴露（issue #4）',dur(p.ms)),
      mk(Boolean(u.ok),'② 上游 · 端到端','GetUserStatus：令牌有效 + 上游可达'+(u.modeCount!=null?' · 档位 '+u.modeCount+' 项':''),dur(u.ms)),
    );
    const tot=document.createElement('div');tot.className='hb-row';
    const tl=document.createElement('div');tl.className='lbl';tl.textContent='合计';
    const tm=document.createElement('span');tm.className='ms';tm.textContent=dur(j.totalMs);
    const tb=document.createElement('span');tb.className='badge b-'+(j.ok?'ok':'err');tb.textContent=j.ok?'通过':'异常';
    tot.append(tl,tm,tb);box.append(tot);
    loadState();
  }catch(e){box.innerHTML='<p class="msg">心跳请求失败：'+e.message+'</p>';}
}

async function doUsage(){
  const box=$('#usage');box.innerHTML='<p class="mut">查询中…</p>';
  try{
    const r=await fetch('/admin/api/usage',{method:'POST'});
    const j=await r.json();
    box.innerHTML='';
    if(!j.ok){
      const p=document.createElement('p');p.className='msg';p.textContent='查询失败：'+(j.error||'未知错误');box.append(p);return;
    }
    const pools=j.pools||[];
    if(!pools.length){const p=document.createElement('p');p.className='mut';p.textContent='未返回额度池';box.append(p);}
    for(const pool of pools){
      const w=document.createElement('div');w.className='pool';
      const top=document.createElement('div');top.className='pl';
      const nm=document.createElement('span');nm.className='pn';
      nm.textContent=pool.type==='five_hour'?'5 小时窗口':(pool.type==='weekly'?'周窗口':pool.type);
      const rt=document.createElement('span');rt.className='pr';
      rt.textContent='剩余 '+pct(pool.remainingPercent)+' · 已用 '+pct(pool.usedPercent);
      top.append(nm,rt);
      const bar=document.createElement('div');bar.className='bar';
      const fill=document.createElement('i');
      /* ★ 进度条按【剩余】填充：满额 = 满条。若按「已用」填充，
         额度充足时反而是空条，看着像坏了。 */
      const left=pool.remainingPercent;
      if(left!=null){fill.style.width=Math.max(0,Math.min(100,left))+'%';}
      const used=pool.usedPercent;
      if(used!=null&&used>=90)bar.className='bar hot';else if(used!=null&&used>=70)bar.className='bar warm';
      bar.append(fill);
      const meta=document.createElement('div');meta.className='meta';
      meta.textContent='重置时间 '+((pool.resetAt||'—').replace('T',' ').replace('.000Z','Z'));
      w.append(top,bar,meta);box.append(w);
    }
    $('#uAt').textContent='查询于 '+((j.checkedAt||'').slice(11,19));
  }catch(e){box.innerHTML='<p class="msg">查询失败：'+e.message+'</p>';}
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%231a73e8'/%3E%3C/svg%3E">
<title>Summeretto 后台</title>
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}
