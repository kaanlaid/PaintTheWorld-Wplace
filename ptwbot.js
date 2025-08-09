<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Gelişmiş WPlace Auto Pixel Bot</title>
<style>
  /* Temel stil ve responsive panel */
  body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    background: #222;
    color: #eee;
    margin: 0; padding: 0;
  }
  #botPanel {
    position: fixed;
    top: 10px; right: 10px;
    width: 350px;
    max-width: 90vw;
    background: #111;
    border-radius: 8px;
    box-shadow: 0 0 12px #000;
    padding: 15px;
    z-index: 999999;
  }
  #botPanel h2 {
    margin-top: 0; font-size: 1.3rem; text-align: center;
  }
  #botPanel label {
    display: block; margin: 10px 0 5px;
  }
  #botPanel input[type="file"] {
    width: 100%;
  }
  #botPanel button {
    width: 48%;
    margin: 5px 1%;
    padding: 10px;
    font-weight: 600;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    background: #28a745;
    color: white;
    transition: background 0.3s;
  }
  #botPanel button:hover:not(:disabled) {
    background: #218838;
  }
  #botPanel button:disabled {
    background: #666;
    cursor: not-allowed;
  }
  #progressBarContainer {
    background: #333;
    border-radius: 5px;
    overflow: hidden;
    margin-top: 10px;
    height: 20px;
  }
  #progressBar {
    background: #28a745;
    height: 100%;
    width: 0;
    transition: width 0.3s ease;
  }
  #logOutput {
    height: 100px;
    overflow-y: auto;
    background: #111;
    border: 1px solid #444;
    padding: 5px;
    font-size: 0.85rem;
    margin-top: 10px;
    white-space: pre-wrap;
  }
  #canvasPreview {
    display: block;
    margin: 10px auto;
    max-width: 100%;
    border: 1px solid #444;
  }
  #positionSelector {
    margin-top: 10px;
  }
  #botPanel .smallBtn {
    width: 100%;
    background: #007bff;
  }
  #botPanel .smallBtn:hover:not(:disabled) {
    background: #0056b3;
  }
  /* Light theme */
  body.light {
    background: #eee;
    color: #222;
  }
  body.light #botPanel {
    background: #fff;
    color: #222;
    box-shadow: 0 0 10px #aaa;
  }
  body.light #progressBarContainer {
    background: #ddd;
  }
  body.light #progressBar {
    background: #007bff;
  }
  body.light #logOutput {
    background: #fafafa;
    border-color: #ccc;
  }
  body.light button {
    background: #007bff;
    color: white;
  }
  body.light button:hover:not(:disabled) {
    background: #0056b3;
  }
</style>
</head>
<body>
  <div id="botPanel">
    <h2>WPlace Auto Pixel Bot</h2>
    <label for="imageLoader">Resim Yükle</label>
    <input type="file" id="imageLoader" accept="image/*" />
    <canvas id="canvasPreview" width="300" height="300" style="display:none;"></canvas>
    <label for="resizeWidth">Genişlik (px)</label>
    <input type="number" id="resizeWidth" min="1" max="300" value="50" />
    <label for="resizeHeight">Yükseklik (px)</label>
    <input type="number" id="resizeHeight" min="1" max="300" value="50" />
    <button id="btnResize">Boyutlandır</button>

    <label for="positionSelector">Başlangıç Pozisyonu Seç</label>
    <button id="btnSelectPos" class="smallBtn">Pozisyon Seç</button>
    <div id="posStatus">Pozisyon: Seçilmedi</div>

    <button id="btnStart">Başlat</button>
    <button id="btnPause" disabled>Duraklat</button>
    <button id="btnStop" disabled>Durdur</button>

    <label for="dryRunMode">Simülasyon Modu (API isteği atılmaz)</label>
    <input type="checkbox" id="dryRunMode" />

    <div id="progressBarContainer"><div id="progressBar"></div></div>
    <div id="logOutput"></div>

    <label for="themeToggle">Tema</label>
    <button id="themeToggle" class="smallBtn">Aç / Kapat</button>
  </div>

<script>
(() => {
  // Temel durum değişkenleri
  let image = null;
  let resizedWidth = 50;
  let resizedHeight = 50;
  let pixelData = null;
  let pixelQueue = [];
  let isRunning = false;
  let isPaused = false;
  let startX = null;
  let startY = null;
  let dryRun = false;
  let charges = 0;
  let cooldown = 0;

  const API_BASE = "https://backend.wplace.live";

  // DOM elementleri
  const imageLoader = document.getElementById("imageLoader");
  const canvasPreview = document.getElementById("canvasPreview");
  const ctx = canvasPreview.getContext("2d");

  const resizeWidthInput = document.getElementById("resizeWidth");
  const resizeHeightInput = document.getElementById("resizeHeight");
  const btnResize = document.getElementById("btnResize");

  const btnSelectPos = document.getElementById("btnSelectPos");
  const posStatus = document.getElementById("posStatus");

  const btnStart = document.getElementById("btnStart");
  const btnPause = document.getElementById("btnPause");
  const btnStop = document.getElementById("btnStop");

  const dryRunModeCheckbox = document.getElementById("dryRunMode");
  const progressBar = document.getElementById("progressBar");
  const logOutput = document.getElementById("logOutput");

  const themeToggle = document.getElementById("themeToggle");

  // Tema toggle fonksiyonu
  function toggleTheme() {
    document.body.classList.toggle("light");
  }
  themeToggle.onclick = toggleTheme;

  // Loglama fonksiyonu
  function log(msg) {
    const time = new Date().toLocaleTimeString();
    logOutput.textContent += `[${time}] ${msg}\n`;
    logOutput.scrollTop = logOutput.scrollHeight;
  }

  // Rastgele gecikme
  function randomDelay(minMs, maxMs) {
    return new Promise(res => setTimeout(res, minMs + Math.random() * (maxMs - minMs)));
  }

  // Renk mesafesi - CIEDE2000 (basit versiyon - Euclidean)
  function colorDistance(c1, c2) {
    return Math.sqrt(
      Math.pow(c1.r - c2.r, 2) +
      Math.pow(c1.g - c2.g, 2) +
      Math.pow(c1.b - c2.b, 2)
    );
  }

  // En yakın rengi paletten bul
  function findNearestColor(pixel, palette) {
    let minDist = Infinity;
    let nearestColor = palette[0];
    for (const color of palette) {
      const dist = colorDistance(pixel, color);
      if (dist < minDist) {
        minDist = dist;
        nearestColor = color;
      }
    }
    return nearestColor;
  }

  // Renk kodu dönüşümü (örnek: {r:255,g:0,b:0} -> "#ff0000")
  function rgbToHex({r,g,b}) {
    return "#" + [r,g,b].map(x => x.toString(16).padStart(2,"0")).join("");
  }

  // Paleti web sayfasından al (örnek, kendi sitende farklı olabilir)
  function getColorPalette() {
    // Bu örnekte basit 16 renk paleti
    return [
      {r:0,g:0,b:0},      // siyah
      {r:255,g:255,b:255},// beyaz
      {r:255,g:0,b:0},    // kırmızı
      {r:0,g:255,b:0},    // yeşil
      {r:0,g:0,b:255},    // mavi
      {r:255,g:255,b:0},  // sarı
      {r:255,g:165,b:0},  // turuncu
      {r:128,g:0,b:128},  // mor
      {r:0,g:255,b:255},  // cam göbeği
      {r:192,g:192,b:192},// gri
      {r:128,g:128,b:128},// koyu gri
      {r:255,g:192,b:203},// pembe
      {r:165,g:42,b:42},  // kahverengi
      {r:0,g:128,b:0},    // koyu yeşil
      {r:255,g:215,b:0},  // altın
      {r:173,g:216,b:230} // açık mavi
    ];
  }

  // Resmi canvas’a yükle ve boyutlandır
  function loadImageToCanvas(file, width, height) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        canvasPreview.width = width;
        canvasPreview.height = height;
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        image = img;
        resolve();
      };
      img.onerror = e => reject(e);
      img.src = URL.createObjectURL(file);
    });
  }

  // Piksel verisini al (r,g,b,a)
  function getPixelData() {
    const imgData = ctx.getImageData(0, 0, canvasPreview.width, canvasPreview.height);
    return imgData.data;
  }

  // Piksel kuyruk oluştur (şeffaf ya da beyaz olmayan pikseller)
  function buildPixelQueue() {
    pixelQueue = [];
    const width = canvasPreview.width;
    const height = canvasPreview.height;
    const data = getPixelData();

    for (let y=0; y < height; y++) {
      for (let x=0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = data[idx], g = data[idx+1], b = data[idx+2], a = data[idx+3];
        if (a < 128) continue; // şeffaf
        if (r>250 && g>250 && b>250) continue; // beyaz piksel atla
        pixelQueue.push({x,y,color:{r,g,b}});
      }
    }
    log(`${pixelQueue.length} geçerli piksel kuyruklandı.`);
  }

  // API’ye pixel gönderme
  async function paintPixel(x, y, hexColor) {
    if (dryRun) {
      log(`[Simülasyon] Piksel boyanıyor: (${x},${y}) renk: ${hexColor}`);
      return true;
    }
    try {
      // Örnek endpoint. Sen kendi backend'ine göre düzenle.
      const response = await fetch(`${API_BASE}/s0/pixel/${startX+x}/${startY+y}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({color: hexColor})
      });
      if (!response.ok) {
        log(`Hata: API cevap kodu ${response.status}`);
        return false;
      }
      const json = await response.json();
      if (json.error) {
        log(`API hata mesajı: ${json.error}`);
        return false;
      }
      log(`Piksel başarıyla boyandı: (${startX+x},${startY+y})`);
      return true;
    } catch(e) {
      log(`İstek hatası: ${e.message}`);
      return false;
    }
  }

  // Rastgele yavaşlatma ve fare hareketi simülasyonu (sadece delay)
  async function humanLikeDelay() {
    await randomDelay(400,1200);
  }

  // Ana işlem döngüsü
  async function processPixels() {
    if (pixelQueue.length === 0) {
      log("İşlenecek piksel kalmadı, işlem tamamlandı.");
      isRunning = false;
      btnStart.disabled = false;
      btnPause.disabled = true;
      btnStop.disabled = true;
      return;
    }
    while(isRunning && !isPaused && pixelQueue.length > 0) {
      const pix = pixelQueue.shift();
      const nearest = findNearestColor(pix.color, getColorPalette());
      const hexColor = rgbToHex(nearest);

      await humanLikeDelay();

      const success = await paintPixel(pix.x, pix.y, hexColor);
      if (!success) {
        // Başarısızsa kuyruğa geri koy
        pixelQueue.push(pix);
        log("Başarısız boyama, tekrar deneniyor...");
        await randomDelay(3000, 6000);
      }

      const progressPercent = ((pixelQueue.length === 0) ? 100 : Math.round(100 * (1 - pixelQueue.length / (canvasPreview.width * canvasPreview.height))));
      progressBar.style.width = `${progressPercent}%`;
    }
  }

  // Pozisyon seçme - Basit: kullanıcı inputu veya fixed koordinat (geliştirilebilir)
  function selectPosition() {
    // Burada kullanıcının pozisyon seçmesi için arayüz açılabilir.
    // Örnek olarak 0,0 seçiyoruz
    startX = 0;
    startY = 0;
    posStatus.textContent = `Pozisyon: (${startX}, ${startY}) seçildi`;
  }

  // Eventler
  imageLoader.onchange = async (e) => {
    if (!e.target.files.length) return;
    const file = e.target.files[0];
    resizedWidth = Number(resizeWidthInput.value);
    resizedHeight = Number(resizeHeightInput.value);
    await loadImageToCanvas(file, resizedWidth, resizedHeight);
    canvasPreview.style.display = "block";
    buildPixelQueue();
  };

  btnResize.onclick = () => {
    if (!image) {
      alert("Önce resim yükleyin!");
      return;
    }
    resizedWidth = Number(resizeWidthInput.value);
    resizedHeight = Number(resizeHeightInput.value);
    ctx.clearRect(0, 0, canvasPreview.width, canvasPreview.height);
    ctx.drawImage(image, 0, 0, resizedWidth, resizedHeight);
    buildPixelQueue();
  };

  btnSelectPos.onclick = () => {
    selectPosition();
  };

  btnStart.onclick = () => {
    if (!startX && !startY) {
      alert("Lütfen başlangıç pozisyonu seçin!");
      return;
    }
    if (!pixelQueue.length) {
      alert("İşlenecek piksel yok!");
      return;
    }
    isRunning = true;
    isPaused = false;
    btnStart.disabled = true;
    btnPause.disabled = false;
    btnStop.disabled = false;
    processPixels();
  };

  btnPause.onclick = () => {
    isPaused = true;
    btnPause.disabled = true;
    btnStart.disabled = false;
  };

  btnStop.onclick = () => {
    isRunning = false;
    isPaused = false;
    pixelQueue = [];
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled = true;
    progressBar.style.width = "0%";
    log("İşlem durduruldu ve kuyruk sıfırlandı.");
  };

  dryRunModeCheckbox.onchange = (e) => {
    dryRun = e.target.checked;
    log(`Simülasyon modu ${dryRun ? "aktif" : "pasif"}`);
  };

  // Başlangıç teması: koyu
  document.body.classList.remove("light");
})();
</script>
</body>
</html>
