// app.js

// ====== CONFIG ======
const DEFAULT_API_URL = "https://script.google.com/macros/s/AKfycbyOgDi-hPNxHOfwTp66Ks1lKKcQ4LsOS9HquvZ8iBqeU3YVxz2gwnTWeUk9HcACvH8X0A/exec";
const SYNC_MINUTES_DEFAULT = 60;

// ====== STATE ======
const $ = (id) => document.getElementById(id);

const state = {
  apiUrl: localStorage.getItem("apiUrl") || DEFAULT_API_URL,
  deviceId: localStorage.getItem("deviceId") || crypto.randomUUID(),

  base: new Map(), // tag -> {status,setor,classe}
  queue: [],

  // HOLD: currentTag != null => travado ate acao
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
function toast(msg) {
  log(msg);
  // se quiser, troca por toast bonitinho depois
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

// ====== GEO (COM VIRGULA) ======
function normCoord(v) {
  if (v === null || v === undefined || v === "") return "";
  // Garante virgula e string
  return String(v).trim().replace(/\./g, ",");
}

async function getGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ lat: "", lon: "", accuracy: "" });
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: normCoord(pos.coords.latitude),
        lon: normCoord(pos.coords.longitude),
        accuracy: normCoord(pos.coords.accuracy)
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

// ====== STATUS NORMALIZE ======
function normStatus(s) {
  return String(s || "").trim().toUpperCase();
}

// Mapeia strings que vem da base/servidor vs UI
function uiToBaseStatus(uiStatus) {
  // UI usa PENDENTE_OBRA e SEM_ACESSO (com underscore)
  if (uiStatus === "PENDENTE_OBRA") return "PENDENTE OBRA";
  if (uiStatus === "SEM_ACESSO") return "SEM ACESSO";
  return uiStatus;
}
function baseToUiStatus(baseStatus) {
  const s = normStatus(baseStatus).replace(/\s+/g, " ");
  if (s === "PENDENTE OBRA") return "PENDENTE_OBRA";
  if (s === "SEM ACESSO") return "SEM_ACESSO";
  return s;
}

// ====== HOLD / UI ======
function updateActionButtonsForTag(tag) {
  const info = state.base.get(tag);
  const baseStatus = info ? String(info.status || "PENDENTE") : "NAO CADASTRADA";
  const stNorm = normStatus(baseStatus).replace(/\s+/g, " ");

  const btnConcluido = $("btnConcluido");
  const btnPendente = $("btnPendente");
  const btnObra = $("btnObra");
  const btnSemAcesso = $("btnSemAcesso");
  const btnGeo = $("btnGeo");

  // defaults
  btnConcluido.disabled = false;
  btnObra.disabled = false;
  btnSemAcesso.disabled = false;

  // PENDENTE: só aparece quando status atual != PENDENTE (e cadastrada)
  const isCadastrada = !!info;
  const isPendente = (stNorm === "PENDENTE");
  btnPendente.style.display = (isCadastrada && !isPendente) ? "inline-block" : "none";
  btnPendente.disabled = false;

  // Atualizar geoloc: só aparece quando status atual = CONCLUIDO
  const isConcluido = (stNorm === "CONCLUIDO");
  btnGeo.style.display = (isCadastrada && isConcluido) ? "inline-block" : "none";

  // Desabilitar botão do status atual sempre que status atual != PENDENTE
  // (e também garante concluido disabled quando já concluido)
  if (isCadastrada && !isPendente) {
    const uiStatus = baseToUiStatus(stNorm);

    if (uiStatus === "CONCLUIDO") btnConcluido.disabled = true;
    if (uiStatus === "PENDENTE_OBRA") btnObra.disabled = true;
    if (uiStatus === "SEM_ACESSO") btnSemAcesso.disabled = true;
    // PENDENTE não é o status atual aqui (pq !isPendente), então fica habilitado
  }

  // Se não cadastrada: não tem status confiável — deixa tudo visível menos GEO e PENDENTE
  if (!isCadastrada) {
    btnPendente.style.display = "none";
    btnGeo.style.display = "none";
  }
}

function showTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return;

  // ✅ HOLD: se já tem tag em atendimento, não aceita outra diferente
  if (state.currentTag && state.currentTag !== t) {
    alert(`TAG em atendimento: ${state.currentTag}\nFinalize uma ação ou clique "LER NOVAMENTE".`);
    return;
  }

  state.currentTag = t;
  $("tagLida").value = t;

  const info = state.base.get(t);
  if (!info) {
    $("statusAtual").textContent = "NAO CADASTRADA";
    $("setorAtual").textContent = "-";
    $("classeAtual").textContent = "-";
  } else {
    $("statusAtual").textContent = info.status || "PENDENTE";
    $("setorAtual").textContent = info.setor || "-";
    $("classeAtual").textContent = info.classe || "-";
  }

  state.allowActions = true;
  $("acoesBox").style.display = "block";

  updateActionButtonsForTag(t);
}

function clearTag() {
  state.currentTag = null;
  $("tagLida").value = "";
  $("statusAtual").textContent = "-";
  $("setorAtual").textContent = "-";
  $("classeAtual").textContent = "-";
  $("acoesBox").style.display = "none";
}

// Ler novamente: NÃO destrava (continua hold), só recarrega da base/cache
function lerNovamente() {
  if (!state.currentTag) return;
  // força re-render e regrinhas
  showTag(state.currentTag);
}

// ====== EVENT CREATE ======
async function criarEvento(novoStatusUI, opts = {}) {
  if (!state.currentTag) {
    alert("Nenhuma TAG carregada.");
    return;
  }

  const tag = state.currentTag;
  const geo = await getGeo();

  const statusBase = uiToBaseStatus(String(novoStatusUI || "").trim());

  const ev = {
    event_id: crypto.randomUUID(),
    timestamp_iso: new Date().toISOString(),
    tag,
    status: statusBase,
    usuario: "campo",   // depois você troca por login
    lat: geo.lat,       // ✅ com virgula
    lon: geo.lon,       // ✅ com virgula
    accuracy: geo.accuracy,
    device_id: state.deviceId,
    obs: opts.obs || ""
  };

  // Atualiza cache local (status) — inclusive pra geo update (status igual)
  const info = state.base.get(tag);
  if (info) {
    info.status = statusBase;
    state.base.set(tag, info);
    saveBaseCache();
  }

  // fila offline
  state.queue.unshift(ev);
  saveQueue();
  log(`Evento salvo offline: ${tag} -> ${statusBase} (acc=${geo.accuracy})`);

  // Ao executar uma ação de status / geo update, destrava para próxima tag
  clearTag();

  // tenta sync imediato se online
  if (navigator.onLine) sync().catch(e => log("Erro sync: " + e));
}

// ====== REGRAS DE CONFIRMACAO ======
// ✅: só confirma quando muda de CONCLUIDO -> qualquer outro
async function enviarComRegraConfirmacao_(novoStatusUI) {
  if (!state.currentTag) return;

  const tag = state.currentTag;
  const info = state.base.get(tag);

  // Se não cadastrada, manda direto (sem confirmação)
  if (!info) {
    await criarEvento(novoStatusUI);
    return;
  }

  const atualBase = String(info.status || "PENDENTE");
  const atualNorm = normStatus(atualBase).replace(/\s+/g, " ");
  const novoBase = uiToBaseStatus(novoStatusUI);
  const novoNorm = normStatus(novoBase).replace(/\s+/g, " ");

  // ✅ Só pede confirmação se ESTÁ CONCLUIDO e quer mudar pra outro
  if (atualNorm === "CONCLUIDO" && novoNorm !== "CONCLUIDO") {
    const ok = confirm(`Confirmar mudanca de status?\nDe: ${atualBase}\nPara: ${novoBase}`);
    if (!ok) return;
  }

  // ✅ PENDENTE -> CONCLUIDO: SEM confirmação (cai aqui direto)
  await criarEvento(novoStatusUI);
}

// Atualizar geoloc (apenas quando status atual = CONCLUIDO)
async function atualizarGeoloc_() {
  if (!state.currentTag) return;
  const tag = state.currentTag;
  const info = state.base.get(tag);
  if (!info) return;

  const atualNorm = normStatus(info.status).replace(/\s+/g, " ");
  if (atualNorm !== "CONCLUIDO") return;

  // grava novo evento com mesmo status (CONCLUIDO) e GPS novo
  await criarEvento("CONCLUIDO", { obs: "ATUALIZAR_GEOLOC" });
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
  const batch = state.queue.slice(-50); // mais antigos do fim
  const payload = {
    device_id: state.deviceId,
    usuario: "campo",
    eventos: batch
  };

  log(`Sync: enviando lote ${batch.length}...`);

  // no-cors para GitHub Pages
  await fetch(state.apiUrl, {
    method: "POST",
    mode: "no-cors",
    body: JSON.stringify(payload)
  });

  // remove lote enviado
  state.queue = state.queue.slice(0, Math.max(0, state.queue.length - batch.length));
  saveQueue();
  setLastSync(new Date().toISOString());
  log("Sync: enviado. (Se quiser, clique 'Atualizar base' para conferir status.)");
}

// ====== SCHEDULER ======
function startScheduler() {
  setInterval(() => {
    if (!navigator.onLine) return;
    const last = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
    const now = Date.now();
    const mins = (now - last) / 60000;
    if (mins >= SYNC_MINUTES_DEFAULT && state.queue.length) {
      sync().catch(e => log("Erro sync: " + e));
    }
  }, 60000);

  window.addEventListener("online", () => {
    setNet();
    if (state.queue.length) sync().catch(e => log("Erro sync: " + e));
  });
  window.addEventListener("offline", setNet);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine && state.queue.length) {
      sync().catch(e => log("Erro sync: " + e));
    }
  });
}

// ====== QR SCAN (BarcodeDetector) ======
async function startCamera() {
  if (state.cam.running) return;

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

        // throttling
        if (val && (val !== state.cam.lastValue || (now - state.cam.lastAt) > 2000)) {
          state.cam.lastValue = val;
          state.cam.lastAt = now;

          // ✅ HOLD: se já tem tag em atendimento e for diferente, ignora
          if (state.currentTag && state.currentTag !== val) {
            log(`QR ignorado (HOLD ativo): lido=${val}, em_atendimento=${state.currentTag}`);
          } else {
            log("QR lido: " + val);
            showTag(val);
          }
        }
      }
    } catch (e) {}
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
    if (!t) return;
    showTag(t);
  };

  $("btnLerNovamente").onclick = () => lerNovamente();

  // Atualizar geoloc (somente para concluido)
  $("btnGeo").onclick = () => atualizarGeoloc_().catch(e => log("Erro geo: " + e));

  // Clique nos status (com regra de confirmacao CONCLUIDO->outro)
  document.querySelectorAll("button[data-status]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!state.allowActions) return;
      const statusUI = btn.getAttribute("data-status");
      await enviarComRegraConfirmacao_(statusUI);
    });
  });

  startScheduler();
  log("App pronto. Dica: clique 'Atualizar base' antes de ir pro campo.");
}

init();
