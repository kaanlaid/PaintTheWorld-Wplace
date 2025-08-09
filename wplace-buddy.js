;(()=>{ 'use strict';

/**
 * WPlace Buddy – lightweight pixel bot + UI
 * Çalıştığı yerler: wplace.live ve benzer piksel kanvas sayfaları
 * Özellikler:
 *  - Shadow DOM UI (çakışmasız)
 *  - Görsel şablon yükleme (dosyadan veya URL’den)
 *  - Kanvastan anlık görüntü alıp fark (diff) hesabı
 *  - Kuyruk + cooldown + rasgele gecikme ile gerçek tıklama
 *  - Çoklu site desteği: ayarlanabilir seçiciler
 */

const CFG = {
  // Kanvas ve palet için olası seçiciler (gerektikçe ekleyebilirsin)
  canvasSelectors: [
    'canvas#board', 
    'canvas.PixelCanvas', 
    'canvas[id*="canvas"]',
    'canvas'
  ],
  // Renk paleti: wplace paleti farklıysa UI’dan güncelleyebilirsin.
  // Varsayılan: 24-bit → doğrudan hedef piksel rengini uygular (tam eşleşme yoksa en yakın rengi seçmeye geçer)
  palette: null, // null => serbest renk; array of [r,g,b] vererek sabit palet kullanabilirsin
  // Yerleştirme gecikmesi (insansı davranış): ms
  delayMs: { min: 250, max: 650 }, // her tıklama arasında
  // Toplu yerleştirme intervali (kuyruk tarama)
  tickMs: 350,
  // Cooldown (sitenin izin verdiği hızdan daha sık denememek için koruma)
  globalCooldownMs: 900, 
  // Şablon görseli kanvasa uysun diye otomatik ölçekleme (yakın boyuta fit)
  autoScale: true,
  // Örnek tıklama stratejisi: gerçek mouse olayları
  clickStrategy: 'dom-click', // ileride 'api' vb. eklersin
  // Yerel ayarlar anahtarı
  storageKey: 'wplace-buddy:settings:v1'
};

const state = {
  root: null,
  ui: {},
  ctxBoard: null,
  canvas: null,
  running: false,
  lastAction: 0,
  queue: [],
  template: {
    image: null,
    data: null,
    width: 0,
    height: 0,
    scale: 1
  },
  board: {
    width: 0,
    height: 0
  },
  settings: {
    selectors: [...CFG.canvasSelectors],
    palette: CFG.palette,
    autoScale: CFG.autoScale,
    tickMs: CFG.tickMs,
    delayMin: CFG.delayMs.min,
    delayMax: CFG.delayMs.max,
    cooldown: CFG.globalCooldownMs,
  }
};

/* ---------- Yardımcılar ---------- */

const sleep = ms => new Promise(r=>setTimeout(r, ms));
const randInt = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;

function saveSettings(){
  try{ localStorage.setItem(CFG.storageKey, JSON.stringify(state.settings)); }catch{}
}
function loadSettings(){
  try{
    const raw = localStorage.getItem(CFG.storageKey);
    if(raw){
      const s = JSON.parse(raw);
      Object.assign(state.settings, s||{});
    }
  }catch{}
}

function findCanvas(){
  for(const sel of state.settings.selectors){
    const c = document.querySelector(sel);
    if(c && c.getContext) return c;
  }
  return null;
}

function getCanvasContext(){
  const c = findCanvas();
  if(!c) throw new Error('Kanvas bulunamadı. Ayarlardan seçicileri güncelleyin.');
  const ctx = c.getContext('2d');
  if(!ctx) throw new Error('2D context alınamadı.');
  state.canvas = c;
  state.ctxBoard = ctx;
  state.board.width = c.width;
  state.board.height = c.height;
}

function getBoardImageData(){
  return state.ctxBoard.getImageData(0,0,state.board.width,state.board.height);
}

function loadImageFromFile(file){
  return new Promise((resolve,reject)=>{
    const fr = new FileReader();
    fr.onload = ()=>{
      const img = new Image();
      img.onload = ()=>resolve(img);
      img.onerror = e=>reject(e);
      img.src = fr.result;
    };
    fr.onerror = e=>reject(e);
    fr.readAsDataURL(file);
  });
}

function loadImageFromUrl(url){
  return new Promise((resolve,reject)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = ()=>resolve(img);
    img.onerror = e=>reject(e);
    img.src = url;
  });
}

function drawToCanvas(img, w, h){
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const cx = cv.getContext('2d');
  cx.drawImage(img, 0, 0, w, h);
  return cx.getImageData(0,0,w,h);
}

function nearestColor(r,g,b, palette){
  let best = null, bestD=1e9, idx=-1;
  for(let i=0;i<palette.length;i++){
    const [pr,pg,pb] = palette[i];
    const d = (r-pr)*(r-pr) + (g-pg)*(g-pg) + (b-pb)*(b-pb);
    if(d<bestD){ bestD=d; best=[pr,pg,pb]; idx=i; }
  }
  return {rgb:best, index:idx};
}

// Şablon/board farkı: sadece farklı pikselleri kuyruklar
function computeDiffQueue(){
  if(!state.template.data) throw new Error('Şablon yüklenmemiş.');
  const board = getBoardImageData();
  const t = state.template.data;
  const w = Math.min(board.width, t.width);
  const h = Math.min(board.height, t.height);

  const q = [];
  const pal = state.settings.palette; // optional

  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const i = (y*board.width + x)*4;
      const br=board.data[i], bg=board.data[i+1], bb=board.data[i+2], ba=board.data[i+3];

      const j = (y*t.width + x)*4;
      const tr=t.data[j], tg=t.data[j+1], tb=t.data[j+2], ta=t.data[j+3];

      if(ta<10) continue; // şablon bu pikseli boş bırakmışsa

      // hedef renk
      let rr=tr, rg=tg, rb=tb;
      if(pal && pal.length){
        ({rgb:[rr,rg,rb]} = nearestColor(tr,tg,tb,pal));
      }

      const same = (Math.abs(br-rr)+Math.abs(bg-rg)+Math.abs(bb-rb))<10 && ba>0;
      if(!same){
        q.push({x,y,r:rr,g:rg,b:rb});
      }
    }
  }
  state.queue = shuffle(q);
  updateQueueCount();
}

function shuffle(arr){
  // hızlı tamamlamak için satır-sütun gezmek de olur; burada rastgele sırayla “insansı” görünüm
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}

function setPixelDomClick(x,y,r,g,b){
  // Gerçek bir kullanıcı gibi: kanvas üzerine tıklama + (varsa) renk seçimi.
  // 1) Rengi set etmek için sitede bir palet UI’si varsa, bunun seçicisini ayarlara ekleyip burada kullanabilirsin.
  // 2) Şimdilik doğrudan kanvasa tıklayıp sitedeki varsayılan akışı tetikliyoruz.
  const rect = state.canvas.getBoundingClientRect();

  const cx = rect.left + (x + 0.5) * (rect.width / state.canvas.width);
  const cy = rect.top  + (y + 0.5) * (rect.height / state.canvas.height);

  // mouse move (hafif)
  state.canvas.dispatchEvent(new MouseEvent('mousemove',{clientX:cx+randInt(-2,2),clientY:cy+randInt(-2,2),bubbles:true}));
  // click
  state.canvas.dispatchEvent(new MouseEvent('click',{clientX:cx,clientY:cy,bubbles:true}));

  // Not: Bazı sitelerde renk ayrı seçilir. UI’dan “Renk seçimi: otomatik” kapatıp palet seçiciyi manuel bağlayabilirsin.
  // İleri seviye entegrasyonda burada renk seçme adımı eklenir.
}

async function placeNext(){
  if(!state.running) return;
  const now = Date.now();
  if(now - state.lastAction < state.settings.cooldown) return; // global cooldown

  const item = state.queue.shift();
  updateQueueCount();
  if(!item){
    log('Tebrikler! Kuyruk boş – şablon tamam.');
    setRunning(false);
    return;
  }

  if(state.settings.delayMin>state.settings.delayMax) state.settings.delayMax = state.settings.delayMin+50;
  const delay = randInt(state.settings.delayMin, state.settings.delayMax);
  await sleep(delay);

  // Şimdilik DOM click stratejisi
  setPixelDomClick(item.x, item.y, item.r, item.g, item.b);

  state.lastAction = Date.now();
}

let _tickTimer=null;
function startTicker(){
  stopTicker();
  _tickTimer = setInterval(placeNext, state.settings.tickMs);
}
function stopTicker(){
  if(_tickTimer) clearInterval(_tickTimer);
  _tickTimer=null;
}

/* ---------- UI ---------- */

function buildUI(){
  if(state.root) return;
  const host = document.createElement('div');
  host.id='wplace-buddy-root';
  host.style.all='initial';
  host.style.position='fixed';
  host.style.inset='auto 12px 12px auto';
  host.style.zIndex='2147483647';
  document.body.appendChild(host);

  const shadow = host.attachShadow({mode:'open'});
  state.root = shadow;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        background: rgba(20,20,24,.9);
        color: #fff;
        border: 1px solid rgba(255,255,255,.15);
        border-radius: 10px;
        padding: 12px;
        width: 320px;
        box-shadow: 0 8px 30px rgba(0,0,0,.4);
      }
      .row { display:flex; gap:8px; align-items:center; margin:8px 0; }
      .row > * { flex:1; }
      .btn {
        cursor:pointer; user-select:none; text-align:center; padding:8px 10px;
        background:#6c8cff; border:none; border-radius:8px; color:#fff; font-weight:600;
      }
      .btn.sec { background:#2c2f36; }
      .btn.red { background:#ff5d6c; }
      .small { font-size:12px; opacity:.9; }
      input[type="number"], input[type="text"] {
        background:#15171b; color:#fff; border:1px solid #2a2e37; border-radius:6px; padding:6px 8px;
      }
      input[type="file"] { color:#ddd; }
      .muted{opacity:.8}
      .badge{background:#2c2f36;padding:2px 6px;border-radius:999px;font-size:11px}
      .grid{display:grid;grid-template-columns:1fr 1fr; gap:8px}
      .qcount{font-weight:700}
      .link{color:#8fb3ff;text-decoration:underline;cursor:pointer}
      .sep{height:1px;background:#2a2e37;margin:10px 0}
    </style>
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <div style="font-weight:800">WPlace Buddy <span class="badge">beta</span></div>
        <button class="btn sec" id="closeBtn">×</button>
      </div>

      <div class="small muted">Durum: <span id="status">Hazır</span></div>

      <div class="sep"></div>

      <div class="row">
        <input type="file" id="fileInput" accept="image/png,image/jpeg,image/webp">
        <button class="btn sec" id="urlBtn">URL</button>
      </div>

      <div class="row">
        <button class="btn" id="computeBtn">Farkı Hesapla</button>
        <div class="qcount" id="qCount">0</div>
      </div>

      <div class="grid">
        <div>
          <label class="small">Tick (ms)</label>
          <input type="number" id="tickMs" min="100" step="50">
        </div>
        <div>
          <label class="small">Cooldown (ms)</label>
          <input type="number" id="cooldownMs" min="200" step="50">
        </div>
        <div>
          <label class="small">Gecikme Min</label>
          <input type="number" id="delayMin" min="0" step="10">
        </div>
        <div>
          <label class="small">Gecikme Max</label>
          <input type="number" id="delayMax" min="0" step="10">
        </div>
      </div>

      <div class="row">
        <input type="text" id="selectors" placeholder="Kanvas seçicileri (virgülle)">
      </div>

      <div class="row">
        <button class="btn" id="startBtn">Başlat</button>
        <button class="btn red" id="stopBtn">Durdur</button>
      </div>

      <div class="small muted">
        <span class="link" id="refreshBtn">Kanvastan Yenile</span> · 
        <span class="link" id="saveBtn">Ayarları Kaydet</span>
      </div>
    </div>
  `;
  shadow.appendChild(wrap);

  state.ui = {
    status: shadow.getElementById('status'),
    qCount: shadow.getElementById('qCount'),
    fileInput: shadow.getElementById('fileInput'),
    urlBtn: shadow.getElementById('urlBtn'),
    computeBtn: shadow.getElementById('computeBtn'),
    tickMs: shadow.getElementById('tickMs'),
    cooldownMs: shadow.getElementById('cooldownMs'),
    delayMin: shadow.getElementById('delayMin'),
    delayMax: shadow.getElementById('delayMax'),
    selectors: shadow.getElementById('selectors'),
    startBtn: shadow.getElementById('startBtn'),
    stopBtn: shadow.getElementById('stopBtn'),
    refreshBtn: shadow.getElementById('refreshBtn'),
    closeBtn: shadow.getElementById('closeBtn'),
    saveBtn: shadow.getElementById('saveBtn'),
  };

  // Varsayılanları doldur
  state.ui.tickMs.value = state.settings.tickMs;
  state.ui.cooldownMs.value = state.settings.cooldown;
  state.ui.delayMin.value = state.settings.delayMin;
  state.ui.delayMax.value = state.settings.delayMax;
  state.ui.selectors.value = state.settings.selectors.join(', ');

  // Events
  state.ui.fileInput.addEventListener('change', async (e)=>{
    const f = e.target.files?.[0];
    if(!f) return;
    try{
      setStatus('Şablon yükleniyor…');
      const img = await loadImageFromFile(f);
      await setTemplateImage(img);
      setStatus('Şablon yüklendi.');
    }catch(err){ setStatus('Şablon yüklenemedi: '+err.message); }
  });

  state.ui.urlBtn.addEventListener('click', async ()=>{
    const url = prompt('Şablon görsel URL:');
    if(!url) return;
    try{
      setStatus('Şablon indiriliyor…');
      const img = await loadImageFromUrl(url);
      await setTemplateImage(img);
      setStatus('Şablon yüklendi.');
    }catch(err){ setStatus('Yükleme hatası: '+err.message); }
  });

  state.ui.computeBtn.addEventListener('click', ()=>{
    try{
      getCanvasContext();
      computeDiffQueue();
      setStatus('Fark hesaplandı.');
    }catch(err){ setStatus(err.message); }
  });

  state.ui.refreshBtn.addEventListener('click', ()=>{
    try{
      getCanvasContext();
      setStatus('Kanvas tazelendi.');
    }catch(err){ setStatus(err.message); }
  });

  state.ui.saveBtn.addEventListener('click', ()=>{
    applyUiSettings();
    saveSettings();
    setStatus('Ayarlar kaydedildi.');
  });

  state.ui.startBtn.addEventListener('click', ()=>{
    applyUiSettings();
    try{
      getCanvasContext();
    }catch(err){ setStatus(err.message); return; }
    setRunning(true);
  });

  state.ui.stopBtn.addEventListener('click', ()=>setRunning(false));
  state.ui.closeBtn.addEventListener('click', ()=>{ stopTicker(); host.remove(); state.root=null; });
}

function applyUiSettings(){
  state.settings.tickMs = parseInt(state.ui.tickMs.value||CFG.tickMs,10);
  state.settings.cooldown = parseInt(state.ui.cooldownMs.value||CFG.globalCooldownMs,10);
  state.settings.delayMin = parseInt(state.ui.delayMin.value||CFG.delayMs.min,10);
  state.settings.delayMax = parseInt(state.ui.delayMax.value||CFG.delayMs.max,10);
  state.settings.selectors = (state.ui.selectors.value||'').split(',').map(s=>s.trim()).filter(Boolean);
}

function setStatus(s){ if(state.ui.status) state.ui.status.textContent = s; }
function updateQueueCount(){ if(state.ui.qCount) state.ui.qCount.textContent = String(state.queue.length); }
function log(...a){ console.log('[WPlaceBuddy]',...a); }

async function setTemplateImage(img){
  // Kanvas boyutu yoksa yine de yükleyelim; diff’te kırparız.
  const targetW = state.board.width || img.width;
  const targetH = state.board.height || img.height;

  let w=img.width, h=img.height, scale=1;
  if(CFG.autoScale && (img.width!==targetW || img.height!==targetH)){
    // basit “fit” ölçekleme (aspect korunarak)
    const rw = targetW/img.width, rh = targetH/img.height;
    scale = Math.min(rw,rh);
    w = Math.max(1, Math.round(img.width*scale));
    h = Math.max(1, Math.round(img.height*scale));
  }
  const data = drawToCanvas(img, w, h);
  state.template.image = img;
  state.template.data = data;
  state.template.width = w;
  state.template.height = h;
  state.template.scale = scale;
}

/* ---------- Çalıştırma ---------- */

function setRunning(flag){
  state.running = flag;
  if(flag){
    setStatus('Çalışıyor…');
    startTicker();
  }else{
    setStatus('Durduruldu.');
    stopTicker();
  }
}

/* ---------- Başlat ---------- */

function main(){
  loadSettings();
  buildUI();
  try{
    getCanvasContext();
    setStatus('Hazır – kanvas bulundu.');
  }catch{
    setStatus('Kanvas henüz bulunamadı. Ayarlardan seçici girin, sonra “Kanvastan Yenile” deyin.');
  }
}

main();

})(); 
