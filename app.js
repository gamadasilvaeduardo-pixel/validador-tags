// ====== CONFIG ======
const DEFAULT_API_URL = "https://script.google.com/macros/s/SEU_ID/exec";
const SYNC_MINUTES_DEFAULT = 60;

// ====== STATE ======
const $ = (id) => document.getElementById(id);

const state = {
  apiUrl: localStorage.getItem("apiUrl") || DEFAULT_API_URL,
  deviceId: localStorage.getItem("deviceId") || crypto.randomUUID(),

  // auth (login + codigo4)
  logged: localStorage.getItem("logged") === "1",
  login: localStorage.getItem("login") || "",
  codigo4: localStorage.getItem("codigo4") || "",

  base: new Map(), // tag -> {status,setor,classe}
  queue: [],

  currentTag: null, // HOLD
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
  if (!el) return;
  el.textContent = `[${new Date().toLocaleString()}] ${msg}\n` + el.textContent;
}
function setNet() { $("net").textContent = navigator.onLine ? "ONLINE" : "OFFLINE"; }
function setFila() { $("filaCount").textContent = String(state.queue.length); }
function setLastSync(ts) {
  state.lastSyncAt = ts || "";
  localStorage.setItem("lastSyncAt", state.lastSyncAt);
  $("lastSync").textContent = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : "-";
}
function saveQueue() { localStorage.setItem("queue", JSON.stringify(state.queue)); setFila(); }
function loadQueue() {
  try { state.queue = JSON.parse(localStorage.getItem("queue") || "[]"); }
  catch { state.queue = []; }
  setFila();
}
function saveBaseCache() { localStorage.setItem("baseCache", JSON.stringify(Array.from(state.base.entries()))); }
function loadBaseCache() {
  try { state.base = new Map(JSON.parse(localStorage.getItem("baseCache") || "[]")); }
  catch { state.base = new Map(); }
}

// ====== API POST ======
async function apiPostJson(payload) {
  const res = await fetch(state.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight
    body: JSON.stringify(payload)
  });
  const txt = await res.text();
  try { return JSON.parse(txt); }
  catch { return { ok:false, error:"Resposta invalida do servidor", raw: txt.slice(0,200) }; }
}

// ====== AUTH (login + codigo4) ======
function renderAuth() {
  $("login").value = state.login || "";
  $("codigo4").value = state.codigo4 || "";
  $("authState").textContent = state.logged ? "LOGADO" : "NAO LOGADO";
  $("authState").className = state.logged ? "ok" : "danger";
  $("btnSair").style.display = state.logged ? "inline-block" : "none";
  $("appArea").style.display = state.logged ? "block" : "none";
  $("who").textContent = state.logged ? state.login : "-";
}

async function entrar() {
  const login = $("login").value.trim().toLowerCase();
  const codigo4 = $("codigo4").value.trim();

  if (!login) return alert("Informe o login (nome.ultimosobrenome).");
  if (!/^\d{4}$/.test(codigo4)) return alert("Digite 4 digitos.");

  const resp = await apiPostJson({ action:"login", login, codigo4 });
  if (!resp.ok) return alert(resp.error || "Login invalido.");

  state.logged = true;
  state.login = login;
  state.codigo4 = codigo4;

  localStorage.setItem("logged","1");
  localStorage.setItem("login", login);
  localStorage.setItem("codigo4", codigo4);

  renderAuth();
  log("Login OK: " + login);
}

function sair() {
  state.logged = false;
  localStorage.setItem("logged","0");
  renderAuth();
}

// ====== GEO (virgula) ======
function normCoord(v) {
  if (v === null || v === undefined || v === "") return "";
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

// ====== STATUS / MAP ======
function normStatus(s) { return String(s || "").trim().toUpperCase().replace(/\s+/g," "); }
function uiToBaseStatus(ui) {
  if (ui === "PENDENTE_OBRA") return "PENDENTE_OBRA";
  if (ui === "SEM_ACESSO") return "SEM_ACESSO";
  return ui;
}

// ====== HOLD / UI ======
function updateActionButtonsForTag(tag) {
  const info = state.base.get(tag);
  const baseStatus = info ? String(info.status || "PENDENTE") : "NAO CADASTRADA";
  const st = normStatus(baseStatus);

  const btnConcluido = $("btnConcluido");
  const btnPendente = $("btnPendente");
  const btnObra = $("btnObra");
  const btnSemAcesso = $("btnSemAcesso");
  const btnGeo = $("btnGeo");

  btnConcluido.disabled = false;
  btnObra.disabled = false;
  btnSemAcesso.disabled = false;
  btnPendente.disabled = false;

  const isCadastrada = !!info;
  const isPendente = (st === "PENDENTE");
  const isConcluido = (st === "CONCLUIDO");

  btnPendente.style.display = (isCadastrada && !isPendente) ? "inline-block" : "none";
  btnGeo.style.display = (isCadastrada && isConcluido) ? "inline-block" : "none";

  if (isCadastrada && !isPendente) {
    const cur = st;
    if (cur === "CONCLUIDO") btnConcluido.disabled = true;
    if (cur === "PENDENTE_OBRA") btnObra.disabled = true;
    if (cur === "SEM_ACESSO") btnSemAcesso.disabled = true;
  }

  if (!isCadastrada) {
    btnPendente.style.display = "none";
    btnGeo.style.display = "none";
  }
}

function showTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return;

  if (state.currentTag && state.currentTag !== t) {
    alert(`TAG em atendimento: ${state.currentTag}\nFinalize ou clique "Ler novamente".`);
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

// ====== EVENT (novo modo com login/codigo4) ======
async function criarEvento(novoStatusUI, opts = {}) {
  if (!state.currentTag) return alert("Nenhuma TAG carregada.");
  if (!state.logged) return alert("Faca login.");

  const tag = state.currentTag;
  const geo = await getGeo();
  const status = uiToBaseStatus(String(novoStatusUI || "").trim());

  const payload = {
    action: "event",
    login: state.login,
    codigo4: state.codigo4,
    event_id: crypto.randomUUID(),
    timestamp_iso: new Date().toISOString(),
    tag,
    status,
    lat: geo.lat,
    lon: geo.lon,
    accuracy: geo.accuracy,
    device_id: state.deviceId,
    obs: opts.obs || "",
    confirm: !!opts.confirm
  };

  // UI cache
  const info = state.base.get(tag);
  if (info) {
    info.status = status;
    state.base.set(tag, info);
    saveBaseCache();
  }

  // fila offline (legado)
  state.queue.unshift({
    event_id: payload.event_id,
    timestamp_iso: payload.timestamp_iso,
    tag,
    status,
    usuario: state.login,
    lat: geo.lat,
    lon: geo.lon,
    accuracy: geo.accuracy,
    device_id: state.deviceId,
    obs: payload.obs
  });
  saveQueue();
  log(`Evento salvo offline: ${tag} -> ${status}`);

  clearTag();

  if (navigator.onLine) sync().catch(e => log("Erro sync: " + e));

  // tenta enviar imediato (modo novo)
  if (navigator.onLine) {
    const resp = await apiPostJson(payload);
    if (!resp.ok && resp.needConfirm) {
      const ok = confirm(`Confirmar mudanca de status?\nDe: ${resp.lastStatus}\nPara: ${status}`);
      if (ok) {
        payload.confirm = true;
        const r2 = await apiPostJson(payload);
        if (!r2.ok) log("Erro server: " + (r2.error || "falha"));
      }
    } else if (!resp.ok) {
      log("Erro server: " + (resp.error || "falha"));
    }
  }
}

async function enviarComRegraConfirmacao_(novoStatusUI) {
  if (!state.currentTag) return;

  const tag = state.currentTag;
  const info = state.base.get(tag);

  if (!info) {
    await criarEvento(novoStatusUI);
    return;
  }

  const atual = normStatus(info.status);
  const novo = normStatus(uiToBaseStatus(novoStatusUI));

  if (atual === "CONCLUIDO" && novo !== "CONCLUIDO") {
    const ok = confirm(`Confirmar mudanca de status?\nDe: ${info.status}\nPara: ${novoStatusUI}`);
    if (!ok) return;
    await criarEvento(novoStatusUI, { confirm:true });
    return;
  }

  await criarEvento(novoStatusUI);
}

async function atualizarGeoloc_() {
  const info = state.base.get(state.currentTag || "");
  if (!info) return;
  if (normStatus(info.status) !== "CONCLUIDO") return;
  await criarEvento("CONCLUIDO", { obs:"ATUALIZAR_GEOLOC" });
}

// ====== SYNC (lote legado no-cors) ======
async function sync() {
  if (!navigator.onLine) { log("Sync: sem internet."); return; }
  if (!state.queue.length) { log("Sync: fila vazia."); setLastSync(new Date().toISOString()); return; }

  const batch = state.queue.slice(-50);
  const payload = {
    device_id: state.deviceId,
    usuario: state.login || "campo",
    eventos: batch
  };

  log(`Sync: enviando lote ${batch.length}...`);

  await fetch(state.apiUrl, {
    method: "POST",
    mode: "no-cors",
    body: JSON.stringify(payload)
  });

  state.queue = state.queue.slice(0, Math.max(0, state.queue.length - batch.length));
  saveQueue();
  setLastSync(new Date().toISOString());
  log("Sync: enviado.");
}

// ====== SCHEDULER ======
function startScheduler() {
  setInterval(() => {
    if (!navigator.onLine) return;
    const last = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
    const mins = (Date.now() - last) / 60000;
    if (mins >= SYNC_MINUTES_DEFAULT && state.queue.length) {
      sync().catch(e => log("Erro sync: " + e));
    }
  }, 60000);

  window.addEventListener("online", () => {
    setNet();
    if (state.queue.length) sync().catch(e => log("Erro sync: " + e));
  });
  window.addEventListener("offline", setNet);
}

// ====== QR SCAN ======
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
  if (state.cam.stream) state.cam.stream.getTracks().forEach(t => t.stop());
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
        if (val && (val !== state.cam.lastValue || (now - state.cam.lastAt) > 2000)) {
          state.cam.lastValue = val;
          state.cam.lastAt = now;
          log("QR lido: " + val);
          showTag(val);
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

  // auth
  renderAuth();
  $("btnEntrar").onclick = () => entrar().catch(e => alert(String(e)));
  $("btnSair").onclick = () => sair();

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

  $("btnLerNovamente").onclick = () => clearTag();

  $("btnGeo").onclick = () => atualizarGeoloc_();

  document.querySelectorAll("button[data-status]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!state.allowActions) return;
      const status = btn.getAttribute("data-status");
      await enviarComRegraConfirmacao_(status);
    });
  });

  startScheduler();
  log("App pronto.");
}

init();
