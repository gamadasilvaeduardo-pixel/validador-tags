// ====== CONFIG ======
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

  // HOLD: currentTag != null => travado ate acao (status/geo)
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

// ====== LOGIN UI ======
function renderAuthUI() {
  $("whoami").textContent = state.loggedIn ? (state.login || "-") : "-";
  $("btnLogout").style.display = state.loggedIn ? "inline-block" : "none";
  $("appArea").style.display = state.loggedIn ? "block" : "none";
  $("loginHint").textContent = state.loggedIn
    ? `Ok. ${state.nomeCompleto ? "Bem-vindo, " + state.nomeCompleto + "." : ""}`
    : "Faça login para liberar o app.";
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

async function apiPostJson(payload) {
  const res = await fetch(state.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}

async function doLogin(login, senha) {
  const data = await apiPostJson({ action: "login", login, senha });
  if (!data.ok) return data;

  // sessão simples local
  state.loggedIn = true;
  state.login = data.login || login;
  state.nomeCompleto = data.nomeCompleto || "";

  localStorage.setItem("loggedIn", "1");
  localStorage.setItem("login", state.login);
  localStorage.setItem("nomeCompleto", state.nomeCompleto);

  // troca obrigatória?
  if (data.trocarSenha) {
    $("trocaCard").style.display = "block";
    $("trocaHint").textContent = "Troca obrigatoria: digite a senha atual e uma nova.";
  } else {
    $("trocaCard").style.display = "none";
  }

  return data;
}

async function trocarSenha(login, senhaAtual, novaSenha) {
  const data = await apiPostJson({ action: "trocar_senha", login, senhaAtual, novaSenha });
  return data;
}

// ====== GEO (COM VIRGULA) ======
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

// ====== STATUS NORMALIZE ======
function normStatus(s) { return String(s || "").trim().toUpperCase(); }

function uiToBaseStatus(uiStatus) {
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

  btnConcluido.disabled = false;
  btnObra.disabled = false;
  btnSemAcesso.disabled = false;
  btnPendente.disabled = false;

  const isCadastrada = !!info;
  const isPendente = (stNorm === "PENDENTE");
  const isConcluido = (stNorm === "CONCLUIDO");

  // PENDENTE só aparece quando status atual != PENDENTE (e cadastrada)
  btnPendente.style.display = (isCadastrada && !isPendente) ? "inline-block" : "none";

  // Atualizar geoloc só aparece quando CONCLUIDO (e cadastrada)
  btnGeo.style.display = (isCadastrada && isConcluido) ? "inline-block" : "none";

  // se não pendente, desabilita o botão do status atual
  if (isCadastrada && !isPendente) {
    const uiStatus = baseToUiStatus(stNorm);
    if (uiStatus === "CONCLUIDO") btnConcluido.disabled = true;
    if (uiStatus === "PENDENTE_OBRA") btnObra.disabled = true;
    if (uiStatus === "SEM_ACESSO") btnSemAcesso.disabled = true;
  }

  // não cadastrada: não mostra pendente nem geo
  if (!isCadastrada) {
    btnPendente.style.display = "none";
    btnGeo.style.display = "none";
  }
}

function showTag(tag) {
  const t = String(tag || "").trim();
  if (!t) return;

  // HOLD: se já tem tag em atendimento, não aceita outra diferente
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

function lerNovamente() {
  if (!state.currentTag) return;
  showTag(state.currentTag);
}

// ====== EVENT CREATE ======
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
    usuario: state.login || "campo",  // ✅ AGORA VAI O LOGIN
    lat: geo.lat,
    lon: geo.lon,
    accuracy: geo.accuracy,
    device_id: state.deviceId,
    obs: opts.obs || ""
  };

  // atualiza cache local
  const info = state.base.get(tag);
  if (info) {
    info.status = statusBase;
    state.base.set(tag, info);
    saveBaseCache();
  }

  // fila offline
  state.queue.unshift(ev);
  saveQueue();
  log(`Evento salvo offline: ${tag} -> ${statusBase} (user=${ev.usuario})`);

  // libera para próxima tag
  clearTag();

  // tenta sync imediato se online
  if (navigator.onLine) sync().catch(e => log("Erro sync: " + e));
}

// ====== REGRAS DE CONFIRMACAO ======
async function enviarComRegraConfirmacao_(novoStatusUI) {
  if (!state.currentTag) return;

  const tag = state.currentTag;
  const info = state.base.get(tag);

  // não cadastrada: manda direto
  if (!info) {
    await criarEvento(novoStatusUI);
    return;
  }

  const atualBase = String(info.status || "PENDENTE");
  const atualNorm = normStatus(atualBase).replace(/\s+/g, " ");
  const novoBase = uiToBaseStatus(novoStatusUI);
  const novoNorm = normStatus(novoBase).replace(/\s+/g, " ");

  // ✅ Só confirma quando sai de CONCLUIDO pra outro
  if (atualNorm === "CONCLUIDO" && novoNorm !== "CONCLUIDO") {
    const ok = confirm(`Confirmar mudanca de status?\nDe: ${atualBase}\nPara: ${novoBase}`);
    if (!ok) return;
  }

  await criarEvento(novoStatusUI);
}

// Atualizar geoloc: apenas para concluido
async function atualizarGeoloc_() {
  if (!state.currentTag) return;
  const info = state.base.get(state.currentTag);
  if (!info) return;

  const atualNorm = normStatus(info.status).replace(/\s+/g, " ");
  if (atualNorm !== "CONCLUIDO") return;

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
  log("Sync: enviado. (Clique 'Atualizar base' se quiser conferir.)");
}

// ====== SCHEDULER ======
function startScheduler() {
  setInterval(() => {
    if (!navigator.onLine) return;
    const last = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
    const now = Date.now();
    const mins = (now - last) / 60000;
    if (mins >= SYNC_MINUTES_DEFAULT && state.queue.length) sync().catch(e => log("Erro sync: " + e));
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

// ====== QR SCAN ======
async function startCamera() {
  if (state.cam.running) return;

  if (!("BarcodeDetector" in window)) {
    alert("Seu Chrome nao suporta BarcodeDetector. Use o campo manual.");
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

          if (state.currentTag && state.currentTag !== val) {
            log(`QR ignorado (HOLD): lido=${val}, em_atendimento=${state.currentTag}`);
          } else {
            log("QR lido: " + val);
            showTag(val);
          }
        }
      }
    } catch (_) {}
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

  // auth UI
  renderAuthUI();

  $("btnLogin").onclick = async () => {
    try {
      const login = $("loginUser").value.trim().toLowerCase();
      const senha = $("loginPass").value;
      if (!login || !senha) return alert("Informe login e senha.");

      const data = await doLogin(login, senha);
      if (!data.ok) return alert(data.error || "Falha no login.");

      renderAuthUI();

      if (data.trocarSenha) {
        $("trocaCard").style.display = "block";
      } else {
        $("trocaCard").style.display = "none";
      }
    } catch (e) {
      alert("Erro login. Veja o log.");
      log("Erro login: " + e);
    }
  };

  $("btnLogout").onclick = () => logout();

  $("btnTrocarSenha").onclick = async () => {
    try {
      const senhaAtual = $("senhaAtual").value;
      const senhaNova = $("senhaNova").value;
      if (!senhaAtual || !senhaNova) return alert("Preencha senha atual e nova.");

      const resp = await trocarSenha(state.login, senhaAtual, senhaNova);
      if (!resp.ok) return alert(resp.error || "Falha ao trocar senha.");

      $("trocaCard").style.display = "none";
      $("senhaAtual").value = "";
      $("senhaNova").value = "";
      alert("Senha trocada. Pode continuar.");
    } catch (e) {
      alert("Erro ao trocar senha.");
      log("Erro troca senha: " + e);
    }
  };

  $("btnCancelarTroca").onclick = () => {
    $("trocaCard").style.display = "none";
  };

  // app buttons
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
  $("btnGeo").onclick = () => atualizarGeoloc_().catch(e => log("Erro geo: " + e));

  document.querySelectorAll("button[data-status]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!state.allowActions) return;
      await enviarComRegraConfirmacao_(btn.getAttribute("data-status"));
    });
  });

  startScheduler();
  log("App pronto. Dica: clique 'Atualizar base' antes de ir pro campo.");
}

init();
