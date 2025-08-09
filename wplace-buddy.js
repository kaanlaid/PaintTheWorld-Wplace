;(()=>{'use strict';

/** WPlace Buddy — click-only + overlay sürümü */
const CFG={
  canvasSelectors:['canvas#board','canvas.PixelCanvas','canvas[id*="canvas"]','canvas'],
  tickMs:350, cooldown:900, delay:{min:250,max:650},
  autoScale:true, storageKey:'wplace-buddy:settings:v2'
};

const S={
  root:null, ui:{}, canvas:null,
  ctxBoard:null, // {type:'2d'|'webgl', ctx}
  board:{w:0,h:0},
  running:false, last:0, q:[],
  template:{img:null,data:null,w:0,h:0,scale:1},
  overlay:{el:null},
  set:{
    selectors:[...CFG.canvasSelectors],
    tickMs:CFG.tickMs, cooldown:CFG.cooldown,
    dmin:CFG.delay.min, dmax:CFG.delay.max,
    mode:'auto', // 'auto'|'click-only'
    ov:{on:false,alpha:0.4, offX:0, offY:0}
  }
};

/* utils */
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ri=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const save=()=>{try{localStorage.setItem(CFG.storageKey,JSON.stringify(S.set));}catch{}};
const load=()=>{try{const x=localStorage.getItem(CFG.storageKey);if(x)Object.assign(S.set,JSON.parse(x));}catch{}};

function findAllRoots(doc=document){
  const roots=[doc];
  const crawl=root=>{
    for(const el of root.querySelectorAll('*')){
      if(el.shadowRoot){ roots.push(el.shadowRoot); crawl(el.shadowRoot); }
    }
  };
  crawl(doc);
  for(const f of doc.querySelectorAll('iframe')){
    try{ if(f.contentDocument){ roots.push(f.contentDocument); crawl(f.contentDocument); } }catch{}
  }
  return roots;
}

function findCanvas(){
  for(const sel of S.set.selectors){
    for(const r of findAllRoots()){
      const c=r.querySelector(sel);
      if(c && c.tagName==='CANVAS') return c;
    }
  }
  const cand=[];
  for(const r of findAllRoots()){
    for(const c of r.querySelectorAll('canvas')){
      try{ if(c.getContext && (c.width*c.height)>0) cand.push({c,a:c.width*c.height}); }catch{}
    }
  }
  cand.sort((a,b)=>b.a-a.a);
  return cand[0]?.c||null;
}

function getCanvasContext(){
  const c=findCanvas();
  if(!c) throw new Error('Kanvas bulunamadı.');
  S.canvas=c;

  // 2D?
  try{
    const ctx=c.getContext('2d');
    if(ctx){ S.ctxBoard={type:'2d',ctx}; S.board.w=c.width; S.board.h=c.height; return; }
  }catch{}

  // WebGL?
  try{
    const gl=c.getContext('webgl2',{preserveDrawingBuffer:true})||c.getContext('webgl',{preserveDrawingBuffer:true});
    if(gl){ S.ctxBoard={type:'webgl',ctx:gl}; S.board.w=c.width; S.board.h=c.height; return; }
  }catch{}

  throw new Error('2D context alınamadı.');
}

function getBoardImageData(){
  if(!S.ctxBoard) throw new Error('Canvas hazır değil');
  if(S.ctxBoard.type==='2d'){
    const {ctx}=S.ctxBoard; return ctx.getImageData(0,0,S.board.w,S.board.h);
  }
  if(S.ctxBoard.type==='webgl'){
    const gl=S.ctxBoard.ctx, w=S.board.w, h=S.board.h;
    const px=new Uint8Array(w*h*4);
    try{ gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px); }
    catch(e){ throw new Error('WebGL okunamadı (CORS).'); }
    const flip=new Uint8ClampedArray(w*h*4);
    for(let y=0;y<h;y++){ const src=(h-1-y)*w*4, dst=y*w*4; flip.set(px.subarray(src,src+w*4),dst); }
    return new ImageData(flip,w,h);
  }
}

function imgFromFile(f){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=fr.result;};fr.onerror=rej;fr.readAsDataURL(f);});}
function imgFromUrl(u){return new Promise((res,rej)=>{const im=new Image();im.crossOrigin='anonymous';im.onload=()=>res(im);im.onerror=rej;im.src=u;});}
function draw(img,w,h){const cv=document.createElement('canvas');cv.width=w;cv.height=h;const cx=cv.getContext('2d');cx.drawImage(img,0,0,w,h);return cx.getImageData(0,0,w,h);}

async function setTemplate(img){
  const tW=S.board.w||img.width, tH=S.board.h||img.height;
  let w=img.width,h=img.height,scale=1;
  if(CFG.autoScale && (img.width!==tW || img.height!==tH)){ const rw=tW/img.width, rh=tH/img.height; scale=Math.min(rw,rh); w=Math.max(1,Math.round(img.width*scale)); h=Math.max(1,Math.round(img.height*scale)); }
  const data=draw(img,w,h);
  Object.assign(S.template,{img,data,w,h,scale});
  renderOverlay();
}

function shuffle(a){for(let i=a.length-1;i>0;i--){const j=(Math.random()* (i+1))|0;[a[i],a[j]]=[a[j],a[i]];}return a;}

function buildClickOnlyQueue(){
  const t=S.template.data; if(!t) throw new Error('Şablon yok');
  const q=[]; const offX=S.set.ov.offX|0, offY=S.set.ov.offY|0;
  for(let y=0;y<t.height;y++){
    for(let x=0;x<t.width;x++){
      const i=(y*t.width+x)*4; const a=t.data[i+3]; if(a<10) continue;
      const r=t.data[i], g=t.data[i+1], b=t.data[i+2];
      const X=x+offX, Y=y+offY;
      if(X>=0 && Y>=0 && X<S.board.w && Y<S.board.h) q.push({x:X,y:Y,r,g,b});
    }
  }
  S.q=shuffle(q); updQ();
}

function computeDiffQueue(){
  if(S.set.mode==='click-only'){ buildClickOnlyQueue(); return; }
  try{
    const board=getBoardImageData();
    const t=S.template.data; if(!t) throw new Error('Şablon yok');
    const w=Math.min(board.width,t.width), h=Math.min(board.height,t.height);
    const q=[];
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const i=(y*board.width+x)*4, j=(y*t.width+x)*4;
        if(t.data[j+3]<10) continue;
        const br=board.data[i], bg=board.data[i+1], bb=board.data[i+2];
        const tr=t.data[j], tg=t.data[j+1], tb=t.data[j+2];
        const same=(Math.abs(br-tr)+Math.abs(bg-tg)+Math.abs(bb-tb))<10;
        if(!same) q.push({x,y,r:tr,g:tg,b:tb});
      }
    }
    S.q=shuffle(q); updQ();
  }catch(e){
    console.warn('[Buddy] diff mümkün değil:',e.message,'→ click-only');
    buildClickOnlyQueue();
  }
}

/* clicks */
function clickPixel(x,y){
  const rect=S.canvas.getBoundingClientRect();
  const cx=rect.left+(x+0.5)*(rect.width/S.canvas.width);
  const cy=rect.top +(y+0.5)*(rect.height/S.canvas.height);
  S.canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:cx+ri(-2,2),clientY:cy+ri(-2,2),bubbles:true}));
  S.canvas.dispatchEvent(new MouseEvent('click',{clientX:cx,clientY:cy,bubbles:true}));
}
async function placeNext(){
  if(!S.running) return;
  const now=Date.now(); if(now-S.last<S.set.cooldown) return;
  const it=S.q.shift(); updQ(); if(!it){ status('Bitti! Kuyruk boş.'); setRun(false); return; }
  if(S.set.dmin>S.set.dmax) S.set.dmax=S.set.dmin+50;
  await sleep(ri(S.set.dmin,S.set.dmax));
  clickPixel(it.x,it.y);
  S.last=Date.now();
}
let tick=null; function start(){ stop(); tick=setInterval(placeNext,S.set.tickMs); }
function stop(){ if(tick) clearInterval(tick); tick=null; }

/* overlay */
function ensureOverlay(){
  if(S.overlay.el) return S.overlay.el;
  const el=document.createElement('div');
  el.style.position='absolute'; el.style.pointerEvents='none';
  el.style.top='0'; el.style.left='0'; el.style.zIndex='2147483646';
  document.body.appendChild(el); S.overlay.el=el; return el;
}
function renderOverlay(){
  if(!S.template.img || !S.canvas) return;
  const el=ensureOverlay();
  if(!S.set.ov.on){ el.style.display='none'; return; }
  const rect=S.canvas.getBoundingClientRect();
  const img=S.template.img;
  el.style.display='block';
  el.style.width=rect.width+'px'; el.style.height=rect.height+'px';
  el.style.transform=`translate(${rect.left}px, ${rect.top}px)`;
  const scaleX=rect.width/(S.board.w||img.width);
  const scaleY=rect.height/(S.board.h||img.height);
  const s=Math.min(scaleX,scaleY);
  const w=(img.width*s)|0, h=(img.height*s)|0;
  el.style.backgroundImage=`url(${img.src})`;
  el.style.backgroundSize=`${w}px ${h}px`;
  el.style.backgroundRepeat='no-repeat';
  el.style.opacity=String(S.set.ov.alpha);
  el.style.backgroundPosition=`${(S.set.ov.offX*s)|0}px ${(S.set.ov.offY*s)|0}px`;
}
window.addEventListener('resize',renderOverlay);

/* UI */
function buildUI(){
  if(S.root) return;
  const host=document.createElement('div');
  host.style.position='fixed'; host.style.inset='auto 12px 12px auto';
  host.style.zIndex='2147483647'; document.body.appendChild(host);
  const sh=host.attachShadow({mode:'open'}); S.root=sh;
  const wrap=document.createElement('div');
  wrap.innerHTML=`
<style>
.panel{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;background:rgba(20,20,24,.95);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:12px;width:340px;box-shadow:0 8px 30px rgba(0,0,0,.45)}
.row{display:flex;gap:8px;align-items:center;margin:8px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.btn{cursor:pointer;user-select:none;text-align:center;padding:8px 10px;background:#6c8cff;border:none;border-radius:8px;color:#fff;font-weight:700}
.btn.sec{background:#2c2f36}.btn.red{background:#ff5d6c}
.small{font-size:12px;opacity:.9}
input[type="number"],input[type="text"]{background:#15171b;color:#fff;border:1px solid #2a2e37;border-radius:6px;padding:6px 8px}
input[type="file"]{color:#ddd}.badge{background:#2c2f36;padding:2px 6px;border-radius:999px;font-size:11px}
.sep{height:1px;background:#2a2e37;margin:10px 0}
.link{color:#8fb3ff;text-decoration:underline;cursor:pointer}
.q{font-weight:800}
</style>
<div class="panel">
  <div class="row" style="justify-content:space-between">
    <div style="font-weight:800">WPlace Buddy <span class="badge">beta</span></div>
    <button class="btn sec" id="xbtn">×</button>
  </div>
  <div class="small">Durum: <span id="status">Hazır</span></div>
  <div class="sep"></div>

  <div class="row">
    <input type="file" id="file" accept="image/png,image/jpeg,image/webp">
    <button class="btn sec" id="url">URL</button>
  </div>

  <div class="row">
    <button class="btn" id="diff">Farkı Hesapla</button>
    <div class="q" id="q">0</div>
  </div>

  <div class="grid">
    <div><label class="small">Tick (ms)</label><input type="number" id="tick" min="100" step="50"></div>
    <div><label class="small">Cooldown (ms)</label><input type="number" id="cd" min="200" step="50"></div>
    <div><label class="small">Gecikme Min</label><input type="number" id="dmin" min="0" step="10"></div>
    <div><label class="small">Gecikme Max</label><input type="number" id="dmax" min="0" step="10"></div>
  </div>

  <div class="grid" style="margin-top:6px">
    <div><label class="small">Ofset X</label><input type="number" id="ox" value="0"></div>
    <div><label class="small">Ofset Y</label><input type="number" id="oy" value="0"></div>
    <div><label class="small">Overlay %</label><input type="number" id="ov" min="0" max="100" value="40"></div>
    <div><label class="small">Mod</label><input type="text" id="mode" value="auto" title="auto | click-only"></div>
  </div>

  <div class="row"><button class="btn sec" id="ovtoggle">Overlay Aç/Kapat</button></div>

  <div class="row">
    <input type="text" id="sels" placeholder="Kanvas seçicileri (virgülle)">
  </div>

  <div class="row">
    <button class="btn" id="start">Başlat</button>
    <button class="btn red" id="stop">Durdur</button>
  </div>

  <div class="small">
    <span class="link" id="refresh">Kanvastan Yenile</span> ·
    <span class="link" id="save">Ayarları Kaydet</span>
  </div>
</div>`;
  sh.appendChild(wrap);

  const $=id=>sh.getElementById(id);
  S.ui={ status:$('status'), q:$('q'),
    file:$('file'), url:$('url'), diff:$('diff'),
    tick:$('tick'), cd:$('cd'), dmin:$('dmin'), dmax:$('dmax'),
    ox:$('ox'), oy:$('oy'), ov:$('ov'), mode:$('mode'), ovtoggle:$('ovtoggle'),
    sels:$('sels'), start:$('start'), stop:$('stop'), refresh:$('refresh'), save:$('save'), xbtn:$('xbtn')
  };

  // doldur
  S.ui.tick.value=S.set.tickMs; S.ui.cd.value=S.set.cooldown;
  S.ui.dmin.value=S.set.dmin; S.ui.dmax.value=S.set.dmax;
  S.ui.ox.value=S.set.ov.offX; S.ui.oy.value=S.set.ov.offY;
  S.ui.ov.value=Math.round(S.set.ov.alpha*100); S.ui.mode.value=S.set.mode;
  S.ui.sels.value=S.set.selectors.join(', ');

  // events
  S.ui.file.addEventListener('change',async e=>{
    const f=e.target.files?.[0]; if(!f) return;
    status('Şablon yükleniyor…'); const im=await imgFromFile(f); await setTemplate(im); status('Şablon yüklendi.'); });
  S.ui.url.addEventListener('click',async ()=>{
    const u=prompt('Şablon URL:'); if(!u) return;
    try{ status('Şablon indiriliyor…'); const im=await imgFromUrl(u); await setTemplate(im); status('Şablon yüklendi.'); }catch(err){ status('Hata: '+err.message); }
  });
  S.ui.diff.addEventListener('click',()=>{ try{ getCanvasContext(); computeDiffQueue(); status('Kuyruk hazır.'); }catch(err){ status(err.message); } });
  S.ui.ovtoggle.addEventListener('click',()=>{ S.set.ov.on=!S.set.ov.on; renderOverlay(); });
  ['tick','cd','dmin','dmax','ox','oy','ov','mode','sels'].forEach(k=>{
    S.ui[k].addEventListener('input',()=>{
      S.set.tickMs=parseInt(S.ui.tick.value||CFG.tickMs,10);
      S.set.cooldown=parseInt(S.ui.cd.value||CFG.cooldown,10);
      S.set.dmin=parseInt(S.ui.dmin.value||CFG.delay.min,10);
      S.set.dmax=parseInt(S.ui.dmax.value||CFG.delay.max,10);
      S.set.ov.offX=parseInt(S.ui.ox.value||0,10);
      S.set.ov.offY=parseInt(S.ui.oy.value||0,10);
      S.set.ov.alpha=Math.max(0,Math.min(1,(parseInt(S.ui.ov.value||40,10)/100)));
      S.set.mode=(S.ui.mode.value||'auto').trim();
      S.set.selectors=(S.ui.sels.value||'').split(',').map(s=>s.trim()).filter(Boolean);
      renderOverlay();
    });
  });
  S.ui.refresh.addEventListener('click',()=>{ try{ getCanvasContext(); status('Kanvas bulundu.'); renderOverlay(); }catch(err){ status(err.message);} });
  S.ui.save.addEventListener('click',()=>{ save(); status('Ayarlar kaydedildi.'); });
  S.ui.start.addEventListener('click',()=>{ try{ getCanvasContext(); computeDiffQueue(); setRun(true);}catch(err){ status(err.message);} });
  S.ui.stop.addEventListener('click',()=>setRun(false));
  S.ui.xbtn.addEventListener('click',()=>{ stop(); host.remove(); S.root=null; });
}

function status(s){ if(S.ui.status) S.ui.status.textContent=s; }
function updQ(){ if(S.ui.q) S.ui.q.textContent=String(S.q.length); }
function setRun(f){ S.running=f; if(f){ status('Çalışıyor…'); start(); } else { status('Durduruldu.'); stop(); } }

/* init */
function main(){
  load(); buildUI();
  try{ getCanvasContext(); status('Hazır – kanvas bulundu.'); }catch{ status('2D context alınamadı. (auto → click-only kullan)'); }
}
main();

})();
