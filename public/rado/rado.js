/* Rado Social Hub — shared shell: API helper, auth guard, sidebar, floating buttons */
(function(){
const W=window;
W.$=(s,r)=>(r||document).querySelector(s);
W.esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
W.naira=n=>'₦'+Number(n||0).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
W.token=()=>{try{return localStorage.getItem('rsh_token')||localStorage.getItem('token')||''}catch(e){return ''}};
W.saveSession=(d)=>{try{localStorage.setItem('rsh_token',d.token);localStorage.setItem('token',d.token);if(d.user)localStorage.setItem('rsh_user',JSON.stringify(d.user))}catch(e){}};
W.logout=()=>{try{localStorage.removeItem('rsh_token');localStorage.removeItem('token');localStorage.removeItem('rsh_user')}catch(e){}location.replace('/login')};
W.api=async(url,method,body)=>{
  const h={'Content-Type':'application/json'};const t=token();if(t)h.Authorization='Bearer '+t;
  const r=await fetch(url,{method:method||'GET',headers:h,body:body?JSON.stringify(body):undefined});
  let d={};try{d=await r.json()}catch(e){}
  if(r.status===401&&t){logout();throw new Error('Session expired')}
  if(!r.ok)throw new Error(d.error||d.message||'Request failed');
  return d;
};
let BRAND={name:'Rado Social Hub'};
const NAV=[
 ['Dashboard','/dashboard','▦'],['Products','/products','🛒'],['Categories',null,'☰','cats'],['SMS Numbers','/sms','📞'],
 ['Wallet',null,'👛','wallet'],['Orders','/orders','↺'],['Account','/profile','◉'],['API','/api-access','🔑']];
W.logoHtml=()=>`<a class="logo" href="/dashboard"><img src="/rado/rado-logo.png" alt="Rado Social Hub"></a>`;
W.initShell=async function(active,opts){
  opts=opts||{};
  if(!token()){location.replace('/login');return null}
  document.title=(opts.title||active)+' — Rado Social Hub';
  const path=location.pathname;
  let cachedUser=null,cachedCats=[];
  try{cachedUser=JSON.parse(localStorage.getItem('rsh_user')||'null')}catch(e){}
  try{cachedCats=JSON.parse(localStorage.getItem('rado_cats')||'[]')}catch(e){}
  const catsHtml=c=>(Array.isArray(c)?c:[]).map(x=>`<a href="/products?category=${encodeURIComponent(x.name)}">${esc(x.name)}</a>`).join('')||'<a href="/products">All products</a>';
  const nav=NAV.map(([label,href,ic,key])=>{
    if(!key)return `<a href="${href}" class="${path===href?'on':''}"><span class="ic">${ic}</span>${label}</a>`;
    const subs=key==='cats'?catsHtml(cachedCats)
      :`<a href="/deposit">Fund Naira</a><a href="/fund-crypto">Fund Crypto</a><a href="/transactions">Transactions</a>`;
    const on=key==='wallet'&&['/deposit','/fund-crypto','/transactions'].includes(path);
    return `<button class="nv ${on?'on open':''}" data-tg="${key}"><span class="ic">${ic}</span>${label}<span class="chev">⌄</span></button><div class="sub ${on?'open':''}" id="sub-${key}">${subs}</div>`}).join('');
  /* Build the header, menu, support icons and name chip IMMEDIATELY (before any network call) so they show with the page. */
  document.body.insertAdjacentHTML('afterbegin',
   `<header class="topbar">${logoHtml()}<button class="burger" id="burger" aria-label="Menu">☰</button></header>
    <aside class="drawer" id="drawer"><button class="x" id="dx" aria-label="Close">✕</button>${logoHtml()}<nav class="nav">${nav}<a href="#" id="lo"><span class="ic">⇥</span>Logout</a></nav></aside>
    <div class="userchip" id="userchip"${cachedUser&&cachedUser.name?'':' style="display:none"'}><span class="uic">◉</span><span id="uname">${esc(cachedUser&&cachedUser.name||'')}</span></div>`);
  const dr=$('#drawer');$('#burger').onclick=()=>dr.classList.add('open');$('#dx').onclick=()=>dr.classList.remove('open');
  document.querySelectorAll('[data-tg]').forEach(b=>b.onclick=()=>{b.classList.toggle('open');$('#sub-'+b.dataset.tg).classList.toggle('open')});
  $('#lo').onclick=e=>{e.preventDefault();logout()};
  floatingButtons();
  const wp=document.createElement('script');wp.src='/welcome-popup.js?v=2';wp.defer=true;document.head.appendChild(wp); // join-WhatsApp popup (admin controlled)
  /* Now fetch fresh data in parallel and refresh what was drawn. */
  const catsP=api('/api/rado/products/categories').catch(()=>null);
  let user=null;
  try{user=await api('/api/user/me')}catch(e){return null}
  try{localStorage.setItem('rsh_user',JSON.stringify(user))}catch(e){}
  const un=$('#uname');if(un){un.textContent=user.name||'';$('#userchip').style.display=user.name?'':'none'}
  catsP.then(c=>{if(!Array.isArray(c))return;try{localStorage.setItem('rado_cats',JSON.stringify(c))}catch(e){}const el=$('#sub-cats');if(el)el.innerHTML=catsHtml(c)});
  return user;
};
W.floatingButtons=async function(){
  let cached=null;try{cached=JSON.parse(localStorage.getItem('rado_links')||'null')}catch(e){}
  if(cached)drawFabs(cached);
  let l={};try{l=await fetch('/api/public/site-links').then(r=>r.json())}catch(e){}
  if(!cached||JSON.stringify(cached)!==JSON.stringify(l)){try{localStorage.setItem('rado_links',JSON.stringify(l))}catch(e){}drawFabs(l)}
};
function drawFabs(l){
  document.querySelectorAll('.fab').forEach(e=>e.remove());
  const wa=l.whatsappChatLink||(l.whatsappNumber?'https://wa.me/'+l.whatsappNumber:'');
  const tg=l.telegramLink&&!/t\.me\/$/.test(l.telegramLink)?l.telegramLink:'';
  W.RADO_LINKS={wa,tg};
  let h='';if(wa)h+=`<a class="fab wa" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg viewBox="0 0 24 24" width="56%" height="56%" fill="#fff" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg></a>`;
  if(tg)h+=`<a class="fab tg" href="${esc(tg)}" target="_blank" rel="noopener" aria-label="Telegram"><svg viewBox="0 0 24 24" width="56%" height="56%" fill="#fff" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg></a>`;
  document.body.insertAdjacentHTML('beforeend',h);
}
})();
(function(){
window.loadOrders=async function(){
  const out=[];
  try{(await api('/api/user/purchases')).forEach((p,i)=>out.push({id:'P'+String(p.logId||i).slice(-6).toUpperCase(),date:p.purchasedAt,status:'completed',total:p.pricePaid,title:p.logTitle,details:[p.logDetails,p.toolLink].filter(Boolean).join('\n')}))}catch(e){}
  try{(await api('/api/rado/numbers/my-orders')).forEach(n=>out.push({id:'N'+String(n.id).slice(-6).toUpperCase(),date:n.createdAt,status:n.status,total:n.sellPrice,title:'SMS number '+n.phoneNumber,details:n.code?'Code: '+n.code:'Waiting for code'}))}catch(e){}
  return out.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0));
};
window.orderRow=function(r,withView){const i=(window.__rows||[]).indexOf(r);
  return `<tr><td>${esc(r.id)}</td><td>${r.date?new Date(r.date).toLocaleDateString():''}</td><td><span class="pill ${esc(r.status)}">${esc(r.status)}</span></td><td>${naira(r.total)}</td>${withView?`<td><button class="btn" style="padding:6px 12px;font-size:14px" data-v="${i}">View</button></td>`:''}</tr>`};
})();

/* Maintenance notice: shows a slim bar only while the owner has a maintenance switch on (Control room). */
(function(){
  if (window.__opsNotice) return; window.__opsNotice = 1;
  function run(){
    fetch('/api/ops/status', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(s){
      if (!s || !(s.site || s.deposits || s.orders || s.numbers)) return;
      var what = s.site ? 'The site' : [s.deposits && 'Deposits', s.orders && 'Orders', s.numbers && 'SMS numbers'].filter(Boolean).join(', ');
      var text = s.message || (what + (s.site ? ' is under maintenance. Please check back soon.' : ' paused for maintenance. Please check back soon.'));
      var bar = document.createElement('div');
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'background:#b45309;color:#fff;text-align:center;padding:8px 12px;font:600 13px/1.4 system-ui,sans-serif;position:relative;z-index:50';
      bar.textContent = text;
      document.body.insertBefore(bar, document.body.firstChild);
    }).catch(function(){});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
