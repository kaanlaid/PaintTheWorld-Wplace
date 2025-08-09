;(()=>{'use strict';

/** WPlace Buddy — click-only + overlay + resize (v2) */
const CFG={
  canvasSelectors:['canvas#board','canvas.PixelCanvas','canvas[id*="canvas"]','canvas'],
  tickMs:350, cooldown:900, delay:{min:250,max:650},
  autoScale:true, storageKey:'wplace-buddy:settings:v3'
};

const S={
  root:null, ui:{}, canvas:null,
  ctxBoard:null, // {type:'2d'|'webgl', ctx}
  board:{w:0,h:0},
  running:false, last:0, q:[],
  template:{img:null,data:null,w:0,h:0,scale:1,nw:0,nh:0}, // nw/nh: UI hedef boyut
  overlay:{el:null},
  set:{
    selectors:[...CFG.canvasSelectors],
    tickMs:CFG.tickMs, cooldown:CFG.cooldown,
    dmin:CFG.delay.min, dmax:CFG.delay.max,
    mode:'click-only', // 'auto'|'click-only'  (varsayılan: click-only)
    ov:{on:false,alpha:0.4, offX:0, offY:0},
    aspectLock:true
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

/* template + resize */
async function setTemplate(img){
  const tW = S.board.w || img.width;
  const tH = S.board.h || img.height;

  // UI hedefleri
  let reqW = parseInt(S.ui.imgW?.value||'')||0;
  let reqH = parseInt(S.ui.imgH?.value||'')||0;

  // Auto fit, eğer kullanıcı değer girmediyse
  if ((!reqW || !reqH) && CFG.autoScale){
    const rw=tW/img.width, rh=tH/img.height;
    const sc=Math.min(rw,rh);
    reqW=Math.max(1,Math.round(img.width*sc));
    reqH=Math.max(1,Math.round(img.height*sc));
  }
  if(!reqW) reqW=img.width;
  if(!reqH) reqH=img.height;

  // UI’ı güncelle
  if(S.ui.imgW) S.ui.imgW.value=reqW;
  if(S.ui.imgH) S.ui.imgH.value=reqH;

  const data=draw(img, reqW, reqH);
  Object.assign(S.template,{img,data,w:reqW,h:reqH,scale:reqW/img.width,nw:reqW,nh:reqH});
  renderOverlay();
}

/* queue builders */
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=(Math.random()*(i+1))|0;[a[i],a[j]]=[a[j],a[i]];}return a;}

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
  const it=S.q.shift(); updQ(); if(!it){ status('Bitti! Kuyruk boş.'); set
