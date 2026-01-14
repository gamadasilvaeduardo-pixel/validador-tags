// ====== CONFIG ======
const DEFAULT_API_URL = "https://script.google.com/macros/s/AKfycbyOgDi-hPNxHOfwTp66Ks1lKKcQ4LsOS9HquvZ8iBqeU3YVxz2gwnTWeUk9HcACvH8X0A/exec";
const SYNC_MINUTES_DEFAULT = 60;

// ====== STATE ======
const $ = (id) => document.getElementById(id);

const state = {
  apiUrl: localStorage.getItem("apiUrl") || DEFAULT_API_URL,
  deviceId: localStorage.getItem("deviceId") || crypto.randomUUID(),
  base: new Map(), // tag -> {status,setor,classe}
  queue: [], // eventos pendentes [{...}]
  currentTag: null,
  allowActions: false,

  cam: {
    stream: null,
    detector: null,
    running: false,
    lastValue: "",
    lastAt: 0,
  },

  lastSyncAt: localStorage.getItem("lastSyncAt") || "",
};

localStorage.setItem("deviceId", state.deviceId);

// ====== UI HELPERS ======
function log(msg) {
  const el = $("log");
  el.textContent = `[${new Date().toLocaleString()}] ${msg}\n` + el.textContent;
}
function setNet() {
  $("net").textContent = navigator.onLine ? "ONLINE" : "OFFLINE";
}
function setFila() {
  $("filaCount").textContent = String(state.queue.length);
}
function setLastSync(ts) {
  state.lastSyncAt = ts || "";
  localStorage.setItem("lastSyncAt", state.lastSyncAt);
  $("lastSync").textContent = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : "-";
}
function saveQueue() {
  localStorage.setItem("queue", JSON.stringify(state.queue));
  setFila();
}
function loadQueue() {
  try { state.queue = JSON.parse(localStorage.getItem("queue") || "[]"); }
  catch { state.queue = []; }
  setFila();
}
function saveBaseCache() {
  const arr = Array.from(state.base.entries());
  localStorage.setItem("baseCache", JSON.stringify(arr));
}
function loadBaseCache() {
  try {
    const arr = JSON.parse(localStorage.getItem("baseCache") || "[]");
    state.base = new Map(arr);
  } catch {
    state.base = new Map();
  }
}

// ====== GEO ======
async function getGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: "", lon: "", accuracy: "" });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      }),
      () => resolve({ lat: "", lon: "", accuracy: "" }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}

// ====== BASE ======
async function atualizarBase() {
  const url = `${state.apiUrl}?action=base`;
  log(`Baixando base: ${url}`);
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Falha ao baixar base");

  state.base.clear();
  for (const t of (data.tags || [])) {
    const tag = String(t.tag || "").trim();
    if (!tag) continue;
    state.base.set(tag, {
      status: String(t.status || "PENDENTE"),
      setor: String(t.setor || ""),
      classe: String(t.classe || "")
    });
  }
  saveBaseCache();
  log(`Base OK. Tags ativas: ${state.base.size}`);
}

// ====== TAG LOAD / UI ======
function showTag(tag) {
  state.currentTag = tag;
  $("tagLida").value = tag || "";
  const info = state.base.get(tag);
  if (!info) {
    $("statusAtual").textContent = "NAO CADASTRADA";
    $("setorAtual").textContent = "-";
    $("classeAtual").textContent = "-";
    // não cadastrada: permite tratar mesmo assim (você decide depois)
    state.allowActions = true;
    $("revalBox").style.display = "none";
    $("acoesBox").style.display = "block";
    return;
  }

  $("statusAtual").textContent = info.status || "PENDENTE";
  $("setorAtual").textContent = info.setor || "-";
  $("classeAtual").textContent = info.classe || "-";

  if ((info.status || "PENDENTE") !== "PENDENTE") {
    // pede confirmação de revalidar
    state.allowActions = false;
    $("acoesBox").style.display = "none";
    $("revalBox").style.display = "block";
  } else {
    state.allowActions = true;
    $("revalBox").style.display = "none";
    $("acoesBox").style.display = "block";
  }
}

function clearTag() {
  state.currentTag = null;
  $("tagLida").value = "";
  $("statusAtual").textContent = "-";
  $("setorAtual").textContent = "-";
  $("classeAtual").textContent = "-";
  $("revalBox").style.display = "none";
  $("acoesBox").style.display = "none";
}

// ====== EVENT CREATE ======
async function criarEvento(status) {
  if (!state.currentTag) {
    alert("Nenhuma TAG carregada.");
    return;
  }
  const tag = state.currentTag;
  const geo = await getGeo();
  const ev = {
    event_id: crypto.randomUUID(),
    timestamp_iso: new Date().toISOString(),
    tag,
    status,
    usuario: "campo",   // depois a gente troca por login/pin
    lat: geo.lat,
    lon: geo.lon,
    accuracy: geo.accuracy,
    device_id: state.deviceId,
    obs: ""
  };

  // atualiza status local (pra refletir na tela e bloquear se quiser)
  const info = state.base.get(tag);
  if (info) {
    info.status = status;
    state.base.set(tag, info);
    saveBaseCache();
  }

  // fila offline
  state.queue.unshift(ev);
  saveQueue();
  log(`Evento salvo offline: ${tag} -> ${status} (GPS acc=${geo.accuracy})`);
  clearTag();
}

// ====== SYNC ======
async function sync() {
  if (!navigator.onLine) {
    log("Sync: sem internet.");
    return;
  }
  if (!state.queue.length) {
    log("Sync: fila vazia.");
    setLastSync(new Date().toISOString());
    return;
  }

  // manda em lotes de 50
  const batch = state.queue.slice(-50); // pega os mais antigos do fim
  const payload = {
    device_id: state.deviceId,
    usuario: "campo",
    eventos: batch
  };

  log(`Sync: enviando lote ${batch.length}...`);

  // Para evitar CORS/preflight, usamos no-cors e sem headers.
  // Como no-cors não deixa ler resposta, assumimos "enviado" e depois você confere pela base.
  await fetch(state.apiUrl, {
    method: "POST",
    mode: "no-cors",
    body: JSON.stringify(payload)
  });

  // Remove o lote enviado (assumindo sucesso). Dedup no servidor por event_id evita duplicar.
  // Removemos exatamente os que mandamos (os mais antigos).
  state.queue = state.queue.slice(0, Math.max(0, state.queue.length - batch.length));
  saveQueue();
  setLastSync(new Date().toISOString());
  log("Sync: enviado. (Se quiser, clique 'Atualizar base' para conferir status.)");
}

// ====== SCHEDULER ======
function startScheduler() {
  // tenta a cada 60s e checa se passou 1h desde o último sync
  setInterval(() => {
    if (!navigator.onLine) return;
    const last = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
    const now = Date.now();
    const mins = (now - last) / 60000;
    if (mins >= SYNC_MINUTES_DEFAULT && state.queue.length) {
      sync().catch(e => log("Erro sync: " + e));
    }
  }, 60000);

  // voltou a internet
  window.addEventListener("online", () => {
    setNet();
    if (state.queue.length) sync().catch(e => log("Erro sync: " + e));
  });
  window.addEventListener("offline", setNet);

  // voltou pro app
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine && state.queue.length) {
      sync().catch(e => log("Erro sync: " + e));
    }
  });
}

// ====== QR SCAN (BarcodeDetector) ======
async function startCamera() {
  if (state.cam.running) return;

  // BarcodeDetector é nativo no Chrome Android (na maioria dos aparelhos)
  if (!("BarcodeDetector" in window)) {
    alert("Seu Chrome nao suporta BarcodeDetector. Use o campo manual por enquanto.");
    return;
  }

  state.cam.detector = new BarcodeDetector({ formats: ["qr_code"] });

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false
  });

  state.cam.stream = stream;
  const video = $("video");
  video.srcObject = stream;
  await video.play();

  state.cam.running = true;
  log("Camera iniciada.");

  scanLoop();
}

function stopCamera() {
  state.cam.running = false;
  if (state.cam.stream) {
    state.cam.stream.getTracks().forEach(t => t.stop());
  }
  state.cam.stream = null;
  $("video").srcObject = null;
  log("Camera parada.");
}

async function scanLoop() {
  const video = $("video");
  while (state.cam.running) {
    try {
      const barcodes = await state.cam.detector.detect(video);
      if (barcodes && barcodes.length) {
        const val = String(barcodes[0].rawValue || "").trim();
        const now = Date.now();
        // debounce: evita ler o mesmo QR repetido
        if (val && (val !== state.cam.lastValue || (now - state.cam.lastAt) > 2000)) {
          state.cam.lastValue = val;
          state.cam.lastAt = now;
          log("QR lido: " + val);
          showTag(val);
        }
      }
    } catch (e) {
      // ignora e continua
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

// ====== PWA INSTALL ======
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("btnInstall").style.display = "inline-block";
});
$("btnInstall")?.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $("btnInstall").style.display = "none";
});

// ====== INIT ======
async function init() {
  // service worker
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
      log("Service Worker registrado (offline).");
    } catch (e) {
      log("Falha SW: " + e);
    }
  }

  $("apiUrl").value = state.apiUrl;
  $("deviceId").textContent = state.deviceId;

  setNet();
  loadQueue();
  loadBaseCache();
  setLastSync(state.lastSyncAt);

  $("btnSalvarApi").onclick = () => {
    state.apiUrl = $("apiUrl").value.trim() || DEFAULT_API_URL;
    localStorage.setItem("apiUrl", state.apiUrl);
    log("API salva: " + state.apiUrl);
  };

  $("btnAtualizarBase").onclick = async () => {
    try { await atualizarBase(); }
    catch (e) { log("Erro base: " + e); alert("Erro ao baixar base. Veja o log."); }
  };

  $("btnSync").onclick = () => sync().catch(e => { log("Erro sync: " + e); alert("Erro sync. Veja log."); });

  $("btnStartCam").onclick = () => startCamera().catch(e => { log("Erro camera: " + e); alert("Erro camera: " + e); });
  $("btnStopCam").onclick = () => stopCamera();

  $("btnCarregarManual").onclick = () => {
    const t = $("tagManual").value.trim();
    if (t) showTag(t);
  };

  $("btnRevalNao").onclick = () => {
    $("revalBox").style.display = "none";
    clearTag();
  };
  $("btnRevalSim").onclick = () => {
    $("revalBox").style.display = "none";
    state.allowActions = true;
    $("acoesBox").style.display = "block";
  };

  $("btnLerNovamente").onclick = () => clearTag();

  document.querySelectorAll("button[data-status]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!state.allowActions) return;
      const status = btn.getAttribute("data-status");
      await criarEvento(status);
      // tenta sync imediato se tiver internet (bem útil no campo)
      if (navigator.onLine) sync().catch(e => log("Erro sync: " + e));
    });
  });

  startScheduler();
  log("App pronto. Dica: clique 'Atualizar base' antes de ir pro campo.");
}

init();
