import { PitchRenderer } from "./iso.js";

const LABELS = { TL: "sinistra alto", TR: "destra alto", C: "centro", BL: "sinistra basso", BR: "destra basso" };
const KEYS = { 1: "TL", 2: "TR", 3: "C", 4: "BL", 5: "BR" };

const $ = (sel) => document.querySelector(sel);
const renderer = new PitchRenderer($("#pitch"));

// ---------------------------------------------------------------- sessione
const store = {
  get() { try { return JSON.parse(localStorage.getItem("session") || "null"); } catch { return null; } },
  set(v) { try { localStorage.setItem("session", JSON.stringify(v)); } catch { /* storage non disponibile */ } },
  clear() { try { localStorage.removeItem("session"); } catch { /* ignora */ } },
};
let session = store.get();

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && session) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data && data.detail;
    const msg = Array.isArray(detail) ? "Controlla i campi: alcuni valori non sono validi." : detail;
    throw new Error(msg || `Errore ${res.status}`);
  }
  return data;
}

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
}

// ---------------------------------------------------------------- accesso
const authMsg = $("#auth-msg");
function selectTab(which) {
  const login = which === "login";
  $("#tab-login").setAttribute("aria-selected", String(login));
  $("#tab-register").setAttribute("aria-selected", String(!login));
  $("#form-login").hidden = !login;
  $("#form-register").hidden = login;
  authMsg.textContent = "";
  authMsg.className = "msg";
}
$("#tab-login").onclick = () => selectTab("login");
$("#tab-register").onclick = () => selectTab("register");

async function doLogin(username, password) {
  session = await api("/api/auth/login", { method: "POST", body: { username, password } });
  store.set(session);
  enterLobby();
}

$("#form-login").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  authMsg.textContent = "";
  try { await doLogin(f.get("username").trim(), f.get("password")); }
  catch (err) { authMsg.textContent = err.message; }
};

$("#form-register").onsubmit = async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  f.username = f.username.trim();
  authMsg.textContent = "";
  try {
    await api("/api/auth/register", { method: "POST", body: f });
    await doLogin(f.username, f.password);
  } catch (err) { authMsg.textContent = err.message; }
};

// ---------------------------------------------------------------- lobby
async function enterLobby() {
  show("screen-lobby");
  $("#lobby-name").textContent = `${session.nome} ${session.cognome}`;
  $("#btn-play").focus();
  try {
    const { leaderboard } = await api("/api/game/leaderboard");
    const ol = $("#leaderboard");
    ol.innerHTML = "";
    if (!leaderboard.length) {
      ol.innerHTML = '<li class="empty">Nessuna partita giocata finora.</li>';
    }
    for (const row of leaderboard) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = row.username;
      const wins = document.createElement("span");
      wins.textContent = row.wins === 1 ? "1 vittoria" : `${row.wins} vittorie`;
      li.append(name, wins);
      ol.append(li);
    }
  } catch { /* la classifica è facoltativa */ }
}

$("#btn-logout").onclick = async () => {
  try { await api("/api/auth/logout", { method: "POST", auth: true }); } catch { /* ignora */ }
  session = null;
  store.clear();
  selectTab("login");
  show("screen-auth");
};

// ---------------------------------------------------------------- partita
const game = {
  ws: null, me: null, players: [], role: null, chosen: null,
  over: false, anim: Promise.resolve(), ping: null,
};
const pickerButtons = [...document.querySelectorAll("#picker button")];
const overlay = $("#overlay");

function showOverlay(title, text, btnLabel, onClick) {
  $("#overlay-title").textContent = title;
  $("#overlay-text").textContent = text;
  const btn = $("#overlay-btn");
  btn.textContent = btnLabel;
  btn.onclick = onClick;
  overlay.hidden = false;
  btn.focus();
}

function setPicker(enabled) {
  for (const b of pickerButtons) {
    b.disabled = !enabled;
    b.classList.toggle("chosen", b.dataset.dir === game.chosen);
  }
}

function startTimer(seconds) {
  const bar = $("#timer-bar");
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  void bar.offsetWidth; // forza il reflow per far ripartire la transizione
  bar.style.transition = `transform ${seconds}s linear`;
  bar.style.transform = "scaleX(0)";
}
function stopTimer() {
  const bar = $("#timer-bar");
  bar.style.transition = "none";
  bar.style.transform = `scaleX(${new DOMMatrix(getComputedStyle(bar).transform).a || 0})`;
}

function playerByName(username) { return game.players.find((p) => p.username === username); }

function renderScore(score) {
  game.players.forEach((p, i) => {
    $(`#team-${i} .goals`).textContent = score[p.username] ?? 0;
  });
}

function callout(text) {
  const el = $("#callout");
  el.textContent = text;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
}

function backToLobby() {
  overlay.hidden = true;
  closeSocket();
  enterLobby();
}

function closeSocket() {
  clearInterval(game.ping);
  if (game.ws) {
    game.ws.onclose = null;
    game.ws.close();
  }
  game.ws = null;
}

function startMatch() {
  show("screen-game");
  Object.assign(game, { me: session.username, players: [], role: null, chosen: null, over: false });
  $("#role-text").textContent = "";
  $("#status-text").textContent = "";
  setPicker(false);
  showOverlay("In attesa", "Cerchiamo un avversario. Appena si collega qualcuno la partita parte da sola.",
    "Annulla", backToLobby);

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/game/ws?token=${encodeURIComponent(session.token)}`);
  game.ws = ws;
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = (ev) => {
    clearInterval(game.ping);
    if (game.over) return;
    if (ev.code === 4401) {
      session = null; store.clear();
      overlay.hidden = true; show("screen-auth");
      authMsg.textContent = "La sessione è scaduta. Accedi di nuovo.";
      return;
    }
    showOverlay("Connessione persa", "Il collegamento con il server si è interrotto.", "Torna alla lobby", backToLobby);
  };
  game.ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })), 25000);
}

async function handle(msg) {
  switch (msg.type) {
    case "waiting":
      break;

    case "match_start": {
      overlay.hidden = true;
      game.players = msg.players;
      $("#goals-to-win").textContent = msg.goals_to_win;
      msg.players.forEach((p, i) => {
        const team = $(`#team-${i}`);
        team.querySelector(".name").textContent = p.username === game.me ? `${p.display} (tu)` : p.display;
        team.querySelector(".chip").style.background = p.color === "blue" ? "var(--blue)" : "var(--orange)";
        team.querySelector(".goals").textContent = "0";
      });
      const opp = msg.players.find((p) => p.username !== game.me);
      $("#role-text").textContent = "Si comincia";
      $("#status-text").textContent = `Avversario: ${opp.display}`;
      break;
    }

    case "round_start": {
      await game.anim;
      game.role = msg.role;
      game.chosen = null;
      const shooter = playerByName(msg.shooter);
      const keeper = playerByName(msg.keeper);
      renderer.setRoles(shooter.color, keeper.color);
      game.players.forEach((p, i) => $(`#team-${i}`).classList.toggle("is-shooter", p.username === msg.shooter));
      renderScore(msg.score);
      $("#role-text").textContent = msg.role === "shooter" ? "Tocca a te tirare" : "Tocca a te parare";
      $("#status-text").textContent = msg.role === "shooter"
        ? "Scegli dove calciare."
        : "Scegli dove tuffarti. Gli angoli sono visti dal tiratore.";
      setPicker(true);
      startTimer(msg.timeout);
      break;
    }

    case "choice_ack":
      game.chosen = msg.dir;
      setPicker(false);
      $("#status-text").textContent = `Hai scelto ${LABELS[msg.dir]}. Aspettiamo l'avversario.`;
      break;

    case "opponent_ready":
      if (!game.chosen) $("#status-text").textContent = "L'avversario ha già scelto.";
      break;

    case "round_result": {
      setPicker(false);
      stopTimer();
      const iShot = msg.shooter === game.me;
      const parts = [`Tiro ${LABELS[msg.shot]}, tuffo ${LABELS[msg.dive]}.`];
      if (msg.auto && msg.auto[game.me]) parts.push("Tempo scaduto: scelta casuale.");
      $("#role-text").textContent = "Si calcia";
      $("#status-text").textContent = msg.auto && msg.auto[game.me] ? "Tempo scaduto: scelta casuale." : "";
      game.anim = renderer.play({ shot: msg.shot, dive: msg.dive, goal: msg.goal });
      // L'esito si svela solo quando il pallone arriva in porta
      setTimeout(() => {
        callout(msg.goal ? "GOL!" : "PARATA!");
        renderScore(msg.score);
        $("#role-text").textContent = msg.goal === iShot ? "Bene così" : "Peccato";
        $("#status-text").textContent = parts.join(" ");
      }, 1250);
      break;
    }

    case "game_over": {
      game.over = true;
      await game.anim;
      closeSocket();
      const won = msg.winner === game.me;
      const opp = game.players.find((p) => p.username !== game.me);
      const mine = msg.score[game.me] ?? 0;
      const theirs = opp ? msg.score[opp.username] ?? 0 : 0;
      const text = msg.reason === "forfeit"
        ? (won ? "L'avversario ha lasciato la partita: vittoria a tavolino." : "Hai lasciato la partita.")
        : `Risultato finale ${mine} a ${theirs}${opp ? ` contro ${opp.display}` : ""}.`;
      showOverlay(won ? "Hai vinto!" : "Hai perso", text, "Torna alla lobby", backToLobby);
      break;
    }

    case "error":
      showOverlay("Impossibile giocare", msg.message, "Torna alla lobby", backToLobby);
      game.over = true;
      break;

    default:
      break;
  }
}

function choose(dir) {
  if (!game.ws || game.chosen || pickerButtons[0].disabled) return;
  game.ws.send(JSON.stringify({ type: "choose", dir }));
}
for (const b of pickerButtons) b.onclick = () => choose(b.dataset.dir);
window.addEventListener("keydown", (e) => {
  if (!$("#screen-game").hidden && KEYS[e.key]) choose(KEYS[e.key]);
});

$("#btn-play").onclick = startMatch;

// ---------------------------------------------------------------- avvio
(async function init() {
  if (session) {
    try {
      const me = await api("/api/auth/verify", { auth: true });
      session = { ...session, ...me };
      return enterLobby();
    } catch {
      session = null;
      store.clear();
    }
  }
  show("screen-auth");
})();
