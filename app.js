// ====== CONFIG ======
const APP_BUILD = "2026-01-14-01";
alert("APP_BUILD: " + APP_BUILD);

const DEFAULT_API_URL = "https://script.google.com/macros/s/SEU_ID/exec";
const SYNC_MINUTES_DEFAULT = 60;

// ====== STATE ======
const $ = (id) => document.getElementById(id);

const state = {
  apiUrl: localStorage.getItem("apiUrl") || DEFAULT_API_URL,
  deviceId: localStorage.getItem("deviceId") || crypto.randomUUID(),

  // sessão
  login: localStorage.getItem("login") || "",
  nomeCompleto: localStorage.getItem("nomeCompleto") || "",
  loggedIn: localStorage.getItem("loggedIn") === "1",

  base: new Map(), // tag -> {status,setor,classe}
  queue: [],

  // HOLD
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

// ====== AUTH / API ======
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

function renderAuthUI() {
  $("whoami").textContent = state.loggedIn ? (state.login || "-") : "-";
  $("btnLogout").style.display = state.loggedIn ? "inline-block" : "none";
  $("appArea").style.display = state.loggedIn ? "block" : "none";
  $("loginHint").textContent = state.loggedIn ? "Logado." : "Faça login para continuar.";
}

function logout() {
  state.loggedIn = false;
  state.login = "";
  state.nomeCompleto = "";
  localStorage.setItem("loggedIn", "0");
  localStorage.removeItem("login");
  localStorage.removeItem("nomeCompleto");
  renderAuthUI();
}

async function doLogin(login, senha) {
  return await apiPostJson({ action: "login", login, senha });
}

async function trocarSenha(login, senhaAtual, novaSenha) {
  return await apiPostJson({ action: "trocar_senha", login, senhaAtual, novaSenha });
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

// ====== STATUS ======
function normStatus(s) { return String(s || "").trim().toUpperCase().replace(/\s+/g," "); }
function uiToBaseStatus(ui) {
  if (ui === "PENDENTE_OBRA") return "PENDENTE OBRA";
  if (ui === "SEM_ACESSO") return "SEM ACESSO";
  return ui;
}
function baseToUiStatus(base) {
  const s = normStatus(base);
  if (s === "PENDENTE OBRA") return "PENDENTE_OBRA";
  if (s === "SEM ACESSO") return "SEM_ACESSO";
  return s;
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

  // pendente só quando status != pendente
  btnPendente.style.display = (isCadastrada && !isPendente) ? "inline-block" : "none";

  // atualizar geoloc só quando concluido
  btnGeo.style.display = (isCadastrada && isConcluido) ? "inline-block" : "none";

  // desabilita botao do status atual (se nao pendente)
  if (isCadastrada && !isPendente) {
    const ui = baseToUiStatus(st);
    if (ui === "CONCLUIDO") btnConcluido.disabled = true;
    if (ui === "PENDENTE_OBRA") btnObra.disabled = true;
    if (ui === "SEM_ACESSO") btnSemAcesso.disabled = true;
  }

  if (!isCadastrada) {
    btnPendente.style.display = "none";
    btnGeo.style.display = "none";
  }
}

function showTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return;

  // HOLD
  if (state.currentTag && state.currentTag !== t) {
    alert(`TAG em atendimento: ${state.currentTag}\nFinalize ou clique "LER NOVAMENTE".`);
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

function lerNovamente() {
  if (!state.currentTag) return;
  showTag(state.currentTag);
}

// ====== EVENT ======
async function criarEvento(novoStatusUI, opts = {}) {
  if (!state.currentTag) return alert("Nenhuma TAG carregada.");

  const tag = state.currentTag;
  const geo = await getGeo();
  const statusBase = uiToBaseStatus(String(novoStatusUI || "").trim());

  const ev = {
    event_id: crypto.randomUUID(),
    timestamp_iso: new Date().toISOString(),
    tag,
    status: statusBase,
    usuario: state.login || "campo",
    lat: geo.lat,
    lon: geo.lon,
    accuracy: geo.accuracy,
    device_id: state.deviceId,
    obs: opts.obs || ""
  };

  const info = state.base.get(tag);
  if (info) {
    info.status = statusBase;
    state.base.set(tag, info);
    saveBaseCache();
  }

  state.queue.unshift(ev);
  saveQueue();
  log(`Evento salvo offline: ${tag} -> ${statusBase} (user=${ev.usuario})`);

  clearTag();

  if (navigator.onLine) sync().catch(e => log("Erro sync: " + e));
}

// ====== REGRAS ======
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

  // só confirma quando sai de concluido
  if (atual === "CONCLUIDO" && novo !== "CONCLUIDO") {
    const ok = confirm(`Confirmar mudanca de status?\nDe: ${info.status}\nPara: ${uiToBaseStatus(novoStatusUI)}`);
    if (!ok) return;
  }

  await criarEvento(novoStatusUI);
}

async function atualizarGeoloc_() {
  if (!state.currentTag) return;
  const info = state.base.get(state.currentTag);
  if (!info) return;
  if (normStatus(info.status) !== "CONCLUIDO") return;
  await criarEvento("CONCLUIDO", { obs: "ATUALIZAR_GEOLOC" });
}

// ====== SYNC ======
async function sync() {
  if (!navigator.onLine) return log("Sync: sem internet.");
  if (!state.queue.length) {
    log("Sync: fila vazia.");
    setLastSync(new Date().toISOString());
    return;
  }

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
    if ((Date.now() - last) / 60000 >= SYNC_MINUTES_DEFAULT && state.queue.length) {
      sync().catch(e => log("Erro sync: " + e));
    }
  }, 60000);

  window.addEventListener("online", () => {
    setNet();
    if (state.queue.length) sync().catch(e => log("Erro sync: " + e));
  });
  window.addEventListener("offline", setNet);
}

// ====== CAMERA ======
async function startCamera() {
  if (state.cam.running) return;
  if (!("BarcodeDetector" in window)) return alert("Chrome sem BarcodeDetector.");

  state.cam.detector = new BarcodeDetector({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"environment" }, audio:false });
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
      const codes = await state.cam.detector.detect(video);
      if (codes && codes.length) {
        const val = String(codes[0].rawValue || "").trim();
        const now = Date.now();
        if (val && (val !== state.cam.lastValue || (now - state.cam.lastAt) > 2000)) {
          state.cam.lastValue = val;
          state.cam.lastAt = now;
          if (state.currentTag && state.currentTag !== val) {
            log(`QR ignorado (HOLD): ${val}`);
          } else {
            log("QR lido: " + val);
            showTag(val);
          }
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
}

// ====== INIT ======
async function init() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); log("SW ok."); }
    catch (e) { log("Falha SW: " + e); }
  }

  $("apiUrl").value = state.apiUrl;
  $("deviceId").textContent = state.deviceId;

  setNet();
  loadQueue();
  loadBaseCache();
  setLastSync(state.lastSyncAt);
  renderAuthUI();

  $("btnLogin").onclick = async () => {
    const login = $("loginUser").value.trim().toLowerCase();
    const senha = $("loginPass").value;
    if (!login || !senha) return alert("Informe login e senha.");

    const resp = await doLogin(login, senha);
    if (!resp.ok) {
      alert(resp.error || "Falha no login.");
      return;
    }

    state.loggedIn = true;
    state.login = resp.login || login;
    state.nomeCompleto = resp.nomeCompleto || "";
    localStorage.setItem("loggedIn","1");
    localStorage.setItem("login",state.login);
    localStorage.setItem("nomeCompleto",state.nomeCompleto);

    renderAuthUI();

    if (resp.trocarSenha) {
      alert("Primeiro acesso: voce deve trocar a senha.");
    }
  };

  $("btnLogout").onclick = () => logout();

  $("btnTrocarSenha").onclick = async () => {
    const atual = $("senhaAtual").value;
    const nova = $("senhaNova").value;
    if (!atual || !nova) return alert("Preencha as duas senhas.");
    const resp = await trocarSenha(state.login, atual, nova);
    if (!resp.ok) return alert(resp.error || "Falha ao trocar senha.");
    $("senhaAtual").value = "";
    $("senhaNova").value = "";
    alert("Senha trocada com sucesso.");
  };

  $("btnSalvarApi").onclick = () => {
    state.apiUrl = $("apiUrl").value.trim() || DEFAULT_API_URL;
    localStorage.setItem("apiUrl", state.apiUrl);
    log("API salva: " + state.apiUrl);
  };

  $("btnAtualizarBase").onclick = async () => {
    try { await atualizarBase(); }
    catch (e) { log("Erro base: " + e); alert("Erro ao baixar base."); }
  };

  $("btnSync").onclick = () => sync().catch(e => log("Erro sync: " + e));
  $("btnStartCam").onclick = () => startCamera();
  $("btnStopCam").onclick = () => stopCamera();

  $("btnCarregarManual").onclick = () => {
    const t = $("tagManual").value.trim();
    if (t) showTag(t);
  };

  $("btnLerNovamente").onclick = () => lerNovamente();
  $("btnGeo").onclick = () => atualizarGeoloc_();

  document.querySelectorAll("button[data-status]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!state.allowActions) return;
      await enviarComRegraConfirmacao_(btn.getAttribute("data-status"));
    });
  });

  startScheduler();
  log("App pronto.");
}

init();

