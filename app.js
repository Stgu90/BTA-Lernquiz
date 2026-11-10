/* BTA Lernquiz – Live-Battle ohne Anmeldung, Solo-Training, mehrere Kurse.
   Fragen liegen in data/*.json, die Live-Verbindung läuft über Supabase Realtime
   (Broadcast + Presence). Mit ?local=1 wird stattdessen BroadcastChannel genutzt (Test im selben Browser). */
(() => {
"use strict";

const CFG = window.QUIZ_CONFIG || {};
const params = new URLSearchParams(location.search);
const LOCAL = params.has("local");
const $app = document.getElementById("app");
const $conn = document.getElementById("conn");
const COLORS = ["var(--c0)", "var(--c1)", "var(--c2)", "var(--c3)"];
const LETTERS = ["A", "B", "C", "D"];

/* ---------- Hilfen ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const fmt = n => Math.round(n).toLocaleString("de-DE");
function setConn(state, text) {
  $conn.hidden = !state;
  $conn.className = "conn " + (state || "");
  $conn.textContent = text || "";
}
function points(correct, ms, durMs, streakBefore) {
  if (!correct) return 0;
  const left = Math.max(0, durMs - ms);
  return 500 + Math.round(500 * left / durMs) + Math.min(300, streakBefore * 100);
}

/* ---------- Daten ---------- */
let COURSES = null;
const courseCache = {};
async function loadCourses() {
  if (COURSES) return COURSES;
  const r = await fetch("data/courses.json", {cache: "no-cache"});
  COURSES = await r.json();
  return COURSES;
}
async function loadCourse(id) {
  if (courseCache[id]) return courseCache[id];
  const meta = (await loadCourses()).find(c => c.id === id);
  if (!meta) throw new Error("Kurs nicht gefunden: " + id);
  const r = await fetch(meta.file, {cache: "no-cache"});
  const c = await r.json();
  c.byId = Object.fromEntries(c.questions.map(q => [q.id, q]));
  courseCache[id] = c;
  return c;
}

/* ---------- Transport: Supabase Realtime oder lokal ---------- */
let sbClient = null;
function transport(pin, key, onStatus) {
  const handlers = {};
  let peersCb = () => {};
  const on = (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); };
  const fire = (ev, p) => (handlers[ev] || []).forEach(cb => { try { cb(p); } catch (e) { console.error(e); } });

  if (LOCAL) {
    const bc = new BroadcastChannel("btaquiz-" + pin);
    const peers = new Map(); let me = null, hb = 0;
    const emitPeers = () => peersCb([...peers.values()].map(p => p.meta));
    const announce = () => { if (me) bc.postMessage({t: "pres", key, meta: me}); };
    bc.onmessage = ({data}) => {
      if (data.t === "b") fire(data.ev, data.p);
      else if (data.t === "pres") { peers.set(data.key, {meta: data.meta, at: Date.now()}); emitPeers(); }
      else if (data.t === "pres-req") announce();
      else if (data.t === "leave") { peers.delete(data.key); emitPeers(); }
    };
    hb = setInterval(() => {
      announce();
      const now = Date.now(); let ch = false;
      for (const [k, v] of peers) if (now - v.at > 7000) { peers.delete(k); ch = true; }
      if (ch) emitPeers();
    }, 2000);
    setTimeout(() => { onStatus("ok"); bc.postMessage({t: "pres-req"}); }, 50);
    addEventListener("pagehide", () => bc.postMessage({t: "leave", key}));
    return {
      on, onPeers(cb) { peersCb = cb; },
      send(ev, p) { bc.postMessage({t: "b", ev, p}); },
      track(meta) { me = meta; announce(); },
      close() { clearInterval(hb); bc.postMessage({t: "leave", key}); bc.close(); }
    };
  }

  if (!sbClient) {
    sbClient = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
      auth: {persistSession: false, autoRefreshToken: false},
      realtime: {params: {eventsPerSecond: 20}}
    });
  }
  const ch = sbClient.channel("btaquiz-" + pin, {config: {broadcast: {self: false}, presence: {key}}});
  let meta = null, joined = false;
  ch.on("presence", {event: "sync"}, () => {
    const st = ch.presenceState();
    peersCb(Object.values(st).map(list => list[list.length - 1]).filter(Boolean));
  });
  ["state", "hello", "answer"].forEach(ev => ch.on("broadcast", {event: ev}, msg => fire(ev, msg.payload)));
  ch.subscribe(async status => {
    if (status === "SUBSCRIBED") {
      joined = true; onStatus("ok");
      if (meta) { try { await ch.track(meta); } catch (e) { console.warn(e); } }
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      joined = false; onStatus("bad");
    } else if (status === "CLOSED") { joined = false; }
  });
  return {
    on,
    onPeers(cb) { peersCb = cb; },
    send(ev, p) { return ch.send({type: "broadcast", event: ev, payload: p}); },
    track(m) { meta = m; if (joined) ch.track(m).catch(e => console.warn(e)); },
    close() { try { sbClient.removeChannel(ch); } catch {} }
  };
}

/* ---------- Router ---------- */
let cleanup = null;
function go(view, arg) {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  setConn(null);
  window.scrollTo(0, 0);
  ({start: viewStart, join: viewJoin, solo: viewSoloCourse, host: viewHostSetup}[view] || viewStart)(arg);
}

/* ---------- Start ---------- */
async function viewStart(err) {
  const pinParam = (params.get("pin") || "").replace(/\D/g, "").slice(0, 6);
  $app.innerHTML = `
    <section class="card">
      <h1>Mitspielen</h1>
      <p class="muted">Gib die Spiel-PIN aus der Präsentation und einen Spitznamen ein. Ein Konto brauchst du nicht.</p>
      <form id="f-join" class="grid2" autocomplete="off">
        <label class="field">Spiel-PIN<input id="in-pin" class="pin-input" inputmode="numeric" maxlength="6" value="${esc(pinParam)}" placeholder="000000" required></label>
        <label class="field">Spitzname<input id="in-nick" maxlength="20" value="${esc(store.get("btaq-nick", ""))}" placeholder="z. B. Lena" required></label>
        <div class="row"><button class="btn primary big" type="submit">Beitreten</button></div>
      </form>
      ${err ? `<p class="err">${esc(err)}</p>` : ""}
    </section>
    <section class="grid2">
      <div class="card">
        <h2>Allein üben</h2>
        <p class="muted">Runden in deinem Tempo. Falsch beantwortete Fragen kannst du gezielt wiederholen.</p>
        <div class="row"><button class="btn" id="b-solo">Zum Training</button></div>
      </div>
      <div class="card">
        <h2>Spiel leiten</h2>
        <p class="muted">Für Dozierende: Runde wählen, PIN zeigen, Fragen steuern.</p>
        <div class="row"><button class="btn" id="b-host">Neues Live-Spiel</button></div>
      </div>
    </section>
    <p class="foot">Ohne Anmeldung, ohne Tracking. Gespeichert wird nur dein Spitzname im Spiel und dein Trainingsstand in diesem Browser.</p>`;
  document.getElementById("f-join").onsubmit = e => {
    e.preventDefault();
    const pin = document.getElementById("in-pin").value.replace(/\D/g, "");
    const nick = document.getElementById("in-nick").value.trim().slice(0, 20);
    if (pin.length !== 6) return viewStart("Die PIN hat sechs Ziffern.");
    if (!nick) return viewStart("Bitte gib einen Spitznamen ein.");
    store.set("btaq-nick", nick);
    go("join", {pin, nick});
  };
  document.getElementById("b-solo").onclick = () => go("solo");
  document.getElementById("b-host").onclick = () => go("host");
}

/* ======================================================================
   SPIELERIN
   ====================================================================== */
function viewJoin({pin, nick}) {
  // pro Browser-Tab eindeutig, übersteht ein Neuladen der Seite
  const pidKey = "btaq-pid-" + pin;
  let pid = null;
  try { pid = sessionStorage.getItem(pidKey); } catch {}
  if (!pid) { pid = uid(); try { sessionStorage.setItem(pidKey, pid); } catch {} }
  const P = {pin, nick, pid, hostId: null, st: null, sentFor: null, myChoice: null, deadline: 0, raf: 0, lastSeen: 0};
  setConn("", "Verbinde …");
  const tx = transport(pin, pid, s => setConn(s, s === "ok" ? "Verbunden" : "Verbindung gestört"));
  tx.track({pid, nick, role: "player"});
  tx.on("state", st => {
    if (!st || !st.hostId) return;
    if (P.hostId && st.hostId !== P.hostId && st.phase !== "lobby") return;
    P.hostId = st.hostId; P.lastSeen = Date.now();
    const changed = !P.st || P.st.phase !== st.phase || P.st.qi !== st.qi || P.st.gameId !== st.gameId;
    if (P.st && P.st.gameId !== st.gameId) { P.sentFor = null; P.myChoice = null; }
    P.st = st;
    if (st.phase === "question") {
      P.deadline = Date.now() + (st.remaining || 0);
      // Antwort erneut senden, falls die Spielleitung sie noch nicht bestätigt hat
      if (P.sentFor === st.qi && P.myChoice != null && !(st.answered || []).includes(pid)) {
        tx.send("answer", {pid, nick, qi: st.qi, choice: P.myChoice, gameId: st.gameId});
      }
    }
    if (changed) render(); else update();
  });
  const hello = () => tx.send("hello", {pid, nick});
  hello();
  const helloTimer = setInterval(() => { if (!P.st || Date.now() - P.lastSeen > 6000) hello(); }, 3000);

  function render() {
    cancelAnimationFrame(P.raf);
    const st = P.st;
    if (!st) {
      $app.innerHTML = `<section class="card center"><h2>Hallo ${esc(nick)}!</h2><p class="muted">Warte auf die Spielleitung … (PIN ${esc(pin)})</p></section>`;
      return;
    }
    const me = (st.board || []).find(b => b.pid === pid);
    const head = `<div class="bar"><span class="chip">${esc(st.title || "")}</span><span class="chip">${esc(nick)} · ${fmt(me ? me.score : 0)} Punkte</span></div>`;
    if (st.phase === "lobby") {
      $app.innerHTML = head + `<section class="card center"><h2>Du bist dabei.</h2><p class="muted">Gleich geht es los. Schau auf die geteilte Präsentation.</p><p class="small muted">${(st.players || []).length} im Spiel</p></section>`;
    } else if (st.phase === "question") {
      const q = st.q; const answered = P.sentFor === st.qi;
      $app.innerHTML = head + `
        <div class="bar"><span class="chip">Frage ${st.qi + 1} / ${st.total}</span><span class="chip" id="p-left"></span></div>
        <div class="timer"><i id="p-bar"></i></div>
        <section class="card"><div class="qtext">${esc(q.q)}</div></section>
        <div class="answers">${q.order.map((orig, pos) => `
          <button class="ans ${answered && P.myChoice !== orig ? "dim" : ""} ${answered && P.myChoice === orig ? "mine" : ""}" style="--cc:${COLORS[pos]}" data-o="${orig}" ${answered ? "disabled" : ""}>
            <span class="l">${LETTERS[pos]}</span><span>${esc(q.o[orig])}</span></button>`).join("")}</div>
        <p class="muted center" id="p-note">${answered ? "Antwort abgegeben. Warte auf die Auflösung." : ""}</p>`;
      $app.querySelectorAll(".ans").forEach(b => b.onclick = () => {
        if (P.sentFor === st.qi || Date.now() > P.deadline + 300) return;
        P.sentFor = st.qi; P.myChoice = Number(b.dataset.o);
        tx.send("answer", {pid, nick, qi: st.qi, choice: P.myChoice, gameId: st.gameId});
        render();
      });
      const tick = () => {
        const left = Math.max(0, P.deadline - Date.now());
        const bar = document.getElementById("p-bar"), lab = document.getElementById("p-left");
        if (!bar) return;
        bar.style.width = (100 * left / (q.dur * 1000)) + "%";
        lab.textContent = Math.ceil(left / 1000) + " s";
        if (left <= 0 && P.sentFor !== st.qi) {
          document.getElementById("p-note").textContent = "Zeit abgelaufen.";
          $app.querySelectorAll(".ans").forEach(b => b.disabled = true);
          return;
        }
        if (left > 0) P.raf = requestAnimationFrame(tick);
      };
      tick();
    } else if (st.phase === "reveal") {
      const q = st.q; const r = (st.results || {})[pid];
      const mine = r ? r.choice : (P.sentFor === st.qi ? P.myChoice : null);
      const ok = r ? r.correct : false;
      $app.innerHTML = head + `
        <div class="bar"><span class="chip">Frage ${st.qi + 1} / ${st.total}</span></div>
        <section class="fb ${mine == null ? "neutral" : ok ? "ok" : "no"}">
          <div class="h">${mine == null ? "Keine Antwort abgegeben" : ok ? "Richtig! +" + fmt(r.points) : "Leider falsch"}</div>
          <p><strong>Richtig ist ${LETTERS[q.order.indexOf(st.correct)]}:</strong> ${esc(q.o[st.correct])}</p>
          <p>${esc(st.x || "")}</p>
          ${st.s ? `<p class="src">Quelle: ${esc(st.s)}</p>` : ""}
        </section>
        <section class="card"><div class="qtext" style="font-size:18px">${esc(q.q)}</div></section>`;
    } else if (st.phase === "board" || st.phase === "end") {
      const rank = (st.board || []).findIndex(b => b.pid === pid) + 1;
      $app.innerHTML = head + `
        <section class="card center">
          <h2>${st.phase === "end" ? "Spiel beendet" : "Zwischenstand"}</h2>
          ${rank ? `<div class="big-num">Platz ${rank}</div><p class="muted">${fmt(me.score)} Punkte · ${me.correct} richtig</p>` : `<p class="muted">Noch keine Punkte.</p>`}
        </section>
        <ol class="board">${(st.board || []).slice(0, 10).map(b => `<li class="${b.pid === pid ? "me" : ""}"><span>${esc(b.nick)}</span><span>${fmt(b.score)}</span></li>`).join("")}</ol>
        ${st.phase === "end" ? `<div class="row"><button class="btn" id="p-home">Zur Startseite</button><button class="btn" id="p-solo">Allein weiterüben</button></div>` : ""}`;
      const h = document.getElementById("p-home"); if (h) h.onclick = () => go("start");
      const so = document.getElementById("p-solo"); if (so) so.onclick = () => go("solo");
    }
  }
  function update() {
    const st = P.st;
    if (st.phase === "lobby") {
      const el = $app.querySelector(".card .small"); if (el) el.textContent = (st.players || []).length + " im Spiel";
    }
  }
  render();
  cleanup = () => { clearInterval(helloTimer); cancelAnimationFrame(P.raf); tx.close(); };
}

/* ======================================================================
   SPIELLEITUNG
   ====================================================================== */
const HOST_KEY = "btaq-host-game";
async function viewHostSetup() {
  const courses = await loadCourses();
  const saved = store.get(HOST_KEY, null);
  const canResume = saved && saved.phase !== "end" && Date.now() - saved.updated < 6 * 3600 * 1000;
  $app.innerHTML = `
    ${canResume ? `<section class="card"><h2>Laufendes Spiel fortsetzen?</h2><p class="muted">PIN ${esc(saved.pin)} · ${esc(saved.title)} · Frage ${saved.qi + 1} von ${saved.list.length} · ${Object.keys(saved.players).length} Mitspielende</p><div class="row"><button class="btn primary" id="h-resume">Fortsetzen</button><button class="btn" id="h-discard">Verwerfen</button></div></section>` : ""}
    <section class="card">
      <h1>Neues Live-Spiel</h1>
      <label class="field">Kurs<select id="h-course">${courses.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join("")}</select></label>
      <div id="h-rounds"></div>
      <div class="grid2">
        <label class="field">Anzahl Fragen<select id="h-count"><option value="6">6 (Morgen-Check, ca. 5 Min.)</option><option value="8" selected>8</option><option value="12">12</option><option value="20">20</option><option value="0">alle ausgewählten</option></select></label>
        <label class="field">Reihenfolge<select id="h-order"><option value="mix" selected>gemischt</option><option value="seq">wie im Kurs</option></select></label>
      </div>
      <div class="row"><button class="btn primary big" id="h-create">Spiel eröffnen</button><button class="link" id="h-back">Zurück</button></div>
      <p class="err" id="h-err"></p>
    </section>`;
  const $c = document.getElementById("h-course");
  const showRounds = async () => {
    const c = await loadCourse($c.value);
    document.getElementById("h-rounds").innerHTML = `
      <div class="field">Runden <span class="small muted">(mehrere möglich)</span></div>
      <div class="list">${c.rounds.map(r => `
        <label class="pick" style="--c:${esc(r.color)}"><input type="checkbox" value="${esc(r.id)}">
          <span><span class="k">${esc(r.label)}</span><br><span class="t">${esc(r.title)}</span><br><span class="m">${c.questions.filter(q => q.round === r.id).length} Fragen</span></span></label>`).join("")}</div>`;
  };
  $c.onchange = showRounds; await showRounds();
  document.getElementById("h-back").onclick = () => go("start");
  if (canResume) {
    document.getElementById("h-resume").onclick = () => hostRun(saved);
    document.getElementById("h-discard").onclick = () => { store.del(HOST_KEY); viewHostSetup(); };
  }
  document.getElementById("h-create").onclick = async () => {
    const c = await loadCourse($c.value);
    const sel = [...document.querySelectorAll("#h-rounds input:checked")].map(i => i.value);
    if (!sel.length) { document.getElementById("h-err").textContent = "Bitte mindestens eine Runde auswählen."; return; }
    let qs = c.questions.filter(q => sel.includes(q.round));
    if (document.getElementById("h-order").value === "mix") qs = shuffle(qs);
    const n = Number(document.getElementById("h-count").value);
    if (n) qs = qs.slice(0, n);
    const rounds = c.rounds.filter(r => sel.includes(r.id));
    const title = rounds.length === 1 ? rounds[0].label + ": " + rounds[0].title : c.title + " · " + rounds.map(r => r.label).join(", ");
    const G = {
      gameId: uid(), hostId: uid(), pin: String(Math.floor(100000 + Math.random() * 900000)),
      course: c.id, title, legal: c.legal || "", list: qs.map(q => q.id),
      qi: -1, phase: "lobby", order: null, startedAt: 0, dur: 30,
      answers: {}, players: {}, results: null, updated: Date.now()
    };
    hostRun(G);
  };
}

async function hostRun(G) {
  const course = await loadCourse(G.course);
  const save = () => { G.updated = Date.now(); store.set(HOST_KEY, G); };
  let online = new Set(), tickTimer = 0, hbTimer = 0;
  setConn("", "Verbinde …");
  const tx = transport(G.pin, "host-" + G.hostId, s => setConn(s, s === "ok" ? "Live verbunden" : "Verbindung gestört"));
  tx.track({role: "host", hostId: G.hostId});
  const addPlayer = (pid, nick) => {
    if (!pid) return;
    const p = G.players[pid];
    if (!p) { G.players[pid] = {nick: String(nick || "Gast").slice(0, 20), score: 0, streak: 0, correct: 0}; save(); render(); broadcast(); }
    else if (nick && p.nick !== nick) { p.nick = String(nick).slice(0, 20); save(); }
  };
  tx.onPeers(list => {
    online = new Set(list.filter(m => m && m.role === "player").map(m => m.pid));
    list.forEach(m => m && m.role === "player" && addPlayer(m.pid, m.nick));
    renderPlayers();
  });
  tx.on("hello", p => { addPlayer(p.pid, p.nick); broadcast(); });
  tx.on("answer", a => {
    if (!a || a.gameId !== G.gameId) return;
    addPlayer(a.pid, a.nick);
    if (G.phase !== "question" || a.qi !== G.qi || G.answers[a.pid]) return;
    const ms = Date.now() - G.startedAt;
    if (ms > G.dur * 1000 + 1500) return;
    G.answers[a.pid] = {choice: Number(a.choice), ms};
    save(); renderCounts(); broadcast();
    const active = [...online].filter(pid => G.players[pid]);
    if (active.length && active.every(pid => G.answers[pid])) setTimeout(reveal, 600);
  });

  const q = () => course.byId[G.list[G.qi]];
  const board = () => Object.entries(G.players).map(([pid, p]) => ({pid, nick: p.nick, score: p.score, correct: p.correct}))
    .sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick));
  function stateMsg() {
    const s = {hostId: G.hostId, gameId: G.gameId, phase: G.phase, title: G.title, qi: G.qi, total: G.list.length,
      players: Object.keys(G.players), board: board()};
    if (G.phase === "question" || G.phase === "reveal") {
      const qq = q();
      s.q = {q: qq.q, o: qq.o, order: G.order, dur: G.dur};
      s.answered = Object.keys(G.answers);
      if (G.phase === "question") s.remaining = Math.max(0, G.startedAt + G.dur * 1000 - Date.now());
      if (G.phase === "reveal") { s.correct = qq.a; s.x = qq.x; s.s = qq.s; s.results = G.results; }
    }
    return s;
  }
  function broadcast() { try { tx.send("state", stateMsg()); } catch (e) { console.warn(e); } }
  hbTimer = setInterval(broadcast, 2000);

  function next() {
    if (G.qi + 1 >= G.list.length) { G.phase = "end"; save(); render(); broadcast(); return; }
    G.qi += 1; G.phase = "question"; G.answers = {}; G.results = null;
    const qq = q(); G.dur = qq.t || 30;
    G.order = shuffle(qq.o.map((_, i) => i));
    G.startedAt = Date.now() + 400;
    save(); render(); broadcast();
  }
  function reveal() {
    if (G.phase !== "question") return;
    const qq = q(); const res = {};
    for (const [pid, p] of Object.entries(G.players)) {
      const a = G.answers[pid];
      if (!a) { p.streak = 0; continue; }
      const ok = a.choice === qq.a;
      const pts = points(ok, a.ms, G.dur * 1000, p.streak);
      if (ok) { p.score += pts; p.correct += 1; p.streak += 1; } else p.streak = 0;
      res[pid] = {correct: ok, points: pts, choice: a.choice};
    }
    G.results = res; G.phase = "reveal"; save(); render(); broadcast();
  }
  function showBoard() { G.phase = "board"; save(); render(); broadcast(); }

  function renderPlayers() {
    const el = document.getElementById("h-players"); if (!el) return;
    const ids = Object.keys(G.players);
    el.innerHTML = ids.length ? ids.map(pid => `<span class="chip ${online.has(pid) ? "" : "off"}">${esc(G.players[pid].nick)}</span>`).join("")
      : `<span class="muted">Noch niemand da.</span>`;
    const n = document.getElementById("h-n"); if (n) n.textContent = ids.length;
  }
  function renderCounts() {
    const el = document.getElementById("h-answered");
    if (el) el.textContent = Object.keys(G.answers).length + " von " + Object.keys(G.players).length + " haben geantwortet";
  }
  function render() {
    clearInterval(tickTimer);
    const joinUrl = location.origin + location.pathname + "?pin=" + G.pin + (LOCAL ? "&local=1" : "");
    const top = `<div class="bar"><span class="chip">${esc(G.title)}</span><span class="chip">PIN ${esc(G.pin)}</span></div>`;
    if (G.phase === "lobby") {
      $app.innerHTML = `
        <section class="card">
          <div class="pinbox"><div><div class="muted small">Spiel-PIN</div><div class="pin">${esc(G.pin)}</div></div>
          <div><div class="muted small">Mitspielen unter</div><div class="joinurl"><strong>${esc(joinUrl)}</strong></div></div></div>
          <p class="muted">${esc(G.title)} · ${G.list.length} Fragen</p>
        </section>
        <section class="card"><h3>Mitspielende (<span id="h-n">0</span>)</h3><div class="players" id="h-players"></div></section>
        <div class="row"><button class="btn primary big" id="h-start">Start</button><button class="btn" id="h-copy">Link kopieren</button><button class="link" id="h-quit">Spiel beenden</button></div>`;
      renderPlayers();
      document.getElementById("h-start").onclick = next;
      document.getElementById("h-copy").onclick = async e => { try { await navigator.clipboard.writeText(joinUrl); e.target.textContent = "Kopiert"; } catch { e.target.textContent = "Bitte manuell kopieren"; } };
    } else if (G.phase === "question" || G.phase === "reveal") {
      const qq = q(); const rev = G.phase === "reveal";
      const counts = G.order.map(orig => Object.values(G.answers).filter(a => a.choice === orig).length);
      $app.innerHTML = top + `
        <div class="bar"><span class="chip">Frage ${G.qi + 1} / ${G.list.length}</span><span class="chip" id="h-answered"></span>${rev ? "" : `<span class="chip" id="h-left"></span>`}</div>
        ${rev ? "" : `<div class="timer"><i id="h-bar"></i></div>`}
        <section class="card"><div class="qtext">${esc(qq.q)}</div></section>
        <div class="answers">${G.order.map((orig, pos) => `
          <div class="ans ${rev && orig !== qq.a ? "dim" : ""} ${rev && orig === qq.a ? "right" : ""}" style="--cc:${COLORS[pos]}">
            <span class="l">${LETTERS[pos]}</span><span>${esc(qq.o[orig])}</span>${rev ? `<span class="cnt">${counts[pos]}</span>` : ""}</div>`).join("")}</div>
        ${rev ? `<section class="fb neutral"><p><strong>Warum:</strong> ${esc(qq.x)}</p>${qq.s ? `<p class="src">Quelle: ${esc(qq.s)}</p>` : ""}</section>` : ""}
        <div class="row">${rev ? `<button class="btn primary big" id="h-board">Zwischenstand</button><button class="btn" id="h-next2">${G.qi + 1 >= G.list.length ? "Ergebnis" : "Nächste Frage"}</button>`
          : `<button class="btn primary" id="h-reveal">Jetzt auflösen</button>`}<button class="link" id="h-quit">Spiel beenden</button></div>`;
      renderCounts();
      if (rev) {
        document.getElementById("h-board").onclick = showBoard;
        document.getElementById("h-next2").onclick = next;
      } else {
        document.getElementById("h-reveal").onclick = reveal;
        const tick = () => {
          const left = Math.max(0, G.startedAt + G.dur * 1000 - Date.now());
          const bar = document.getElementById("h-bar"), lab = document.getElementById("h-left");
          if (bar) bar.style.width = Math.min(100, 100 * left / (G.dur * 1000)) + "%";
          if (lab) lab.textContent = Math.ceil(left / 1000) + " s";
          if (left <= 0) { clearInterval(tickTimer); setTimeout(reveal, 1200); }
        };
        tick(); tickTimer = setInterval(tick, 250);
      }
    } else if (G.phase === "board" || G.phase === "end") {
      const b = board();
      $app.innerHTML = top + `
        <section class="card center"><h1>${G.phase === "end" ? "Endstand" : "Zwischenstand"}</h1>
          <p class="muted">${G.phase === "end" ? G.list.length + " Fragen gespielt" : "nach Frage " + (G.qi + 1) + " von " + G.list.length}</p></section>
        <ol class="board">${b.slice(0, 10).map(x => `<li><span>${esc(x.nick)}</span><span>${fmt(x.score)} · ${x.correct} richtig</span></li>`).join("") || "<li><span>Keine Mitspielenden</span><span></span></li>"}</ol>
        <div class="row">${G.phase === "end" ? `<button class="btn primary" id="h-new">Neues Spiel</button>` : `<button class="btn primary big" id="h-next3">${G.qi + 1 >= G.list.length ? "Ergebnis" : "Nächste Frage"}</button>`}<button class="link" id="h-quit">Spiel beenden</button></div>
        ${G.legal ? `<p class="foot">${esc(G.legal)}</p>` : ""}`;
      const n3 = document.getElementById("h-next3"); if (n3) n3.onclick = next;
      const nw = document.getElementById("h-new"); if (nw) nw.onclick = () => { store.del(HOST_KEY); go("host"); };
    }
    const quit = document.getElementById("h-quit");
    if (quit) quit.onclick = () => {
      if (G.phase !== "end") { G.phase = "end"; broadcast(); }
      store.del(HOST_KEY); go("start");
    };
  }
  save(); render(); broadcast();
  cleanup = () => { clearInterval(tickTimer); clearInterval(hbTimer); tx.close(); };
}

/* ======================================================================
   ALLEIN ÜBEN
   ====================================================================== */
async function viewSoloCourse(courseId) {
  const courses = await loadCourses();
  if (!courseId && courses.length === 1) courseId = courses[0].id;
  if (!courseId) {
    $app.innerHTML = `<section class="card"><h1>Allein üben</h1><p class="muted">Welcher Kurs?</p>
      <div class="list">${courses.map(c => `<button class="pick" data-c="${esc(c.id)}"><span class="k">${esc(c.subtitle || "")}</span><span class="t">${esc(c.title)}</span></button>`).join("")}</div>
      <div class="row"><button class="link" id="s-back">Zurück</button></div></section>`;
    $app.querySelectorAll("[data-c]").forEach(b => b.onclick = () => viewSoloCourse(b.dataset.c));
    document.getElementById("s-back").onclick = () => go("start");
    return;
  }
  const c = await loadCourse(courseId);
  const wrongKey = "btaq-wrong-" + c.id;
  const wrong = store.get(wrongKey, []).filter(id => c.byId[id]);
  $app.innerHTML = `
    <section class="card">
      <h1>${esc(c.title)}: allein üben</h1>
      <p class="muted">Antworte schnell, dann gibt es mehr Punkte. Nach jeder Frage siehst du die Begründung und die Fundstelle im Skript.</p>
      <div class="list">
        ${c.rounds.map(r => `<button class="pick" style="--c:${esc(r.color)}" data-r="${esc(r.id)}"><span class="k">${esc(r.label)}</span><span class="t">${esc(r.title)}</span><span class="m">${c.questions.filter(q => q.round === r.id).length} Fragen</span></button>`).join("")}
        <button class="pick" style="--c:var(--ink)" data-r="mix"><span class="k">Alle Kurstage</span><span class="t">Gemischte Runde</span><span class="m">15 Zufallsfragen</span></button>
        <button class="pick" style="--c:var(--red)" data-r="wrong" ${wrong.length ? "" : "disabled"}><span class="k">Gezielt wiederholen</span><span class="t">Meine Fehler</span><span class="m">${wrong.length ? wrong.length + " Fragen" : "Noch leer"}</span></button>
      </div>
      <div class="row"><button class="link" id="s-back">Zurück</button></div>
    </section>
    ${c.legal ? `<p class="foot">${esc(c.legal)}</p>` : ""}`;
  document.getElementById("s-back").onclick = () => go("start");
  $app.querySelectorAll("[data-r]").forEach(b => b.onclick = () => {
    const r = b.dataset.r;
    let list = r === "mix" ? shuffle(c.questions).slice(0, 15) : r === "wrong" ? shuffle(wrong.map(id => c.byId[id])) : shuffle(c.questions.filter(q => q.round === r));
    if (list.length) soloPlay(c, list, r);
  });
}

function soloPlay(c, list, roundId) {
  const wrongKey = "btaq-wrong-" + c.id;
  const S = {i: 0, score: 0, streak: 0, correct: 0, t0: 0, raf: 0, locked: false, order: null};
  const label = roundId === "mix" ? "Gemischt" : roundId === "wrong" ? "Meine Fehler" : (c.rounds.find(r => r.id === roundId) || {}).title;
  function show() {
    cancelAnimationFrame(S.raf);
    const q = list[S.i]; S.order = shuffle(q.o.map((_, i) => i)); S.locked = false; S.t0 = performance.now();
    const dur = (q.t || 30) * 1000;
    $app.innerHTML = `
      <div class="bar"><span class="chip">${esc(label)} · Frage ${S.i + 1} / ${list.length}</span><span class="chip">Serie ${S.streak}</span><span class="chip">${fmt(S.score)} Punkte</span></div>
      <div class="timer"><i id="s-bar"></i></div>
      <section class="card"><div class="qtext">${esc(q.q)}</div></section>
      <div class="answers">${S.order.map((orig, pos) => `<button class="ans" style="--cc:${COLORS[pos]}" data-o="${orig}"><span class="l">${LETTERS[pos]}</span><span>${esc(q.o[orig])}</span></button>`).join("")}</div>
      <div id="s-fb"></div>`;
    $app.querySelectorAll(".ans").forEach(b => b.onclick = () => answer(Number(b.dataset.o)));
    const tick = () => {
      const left = Math.max(0, dur - (performance.now() - S.t0));
      const bar = document.getElementById("s-bar"); if (bar) bar.style.width = (100 * left / dur) + "%";
      if (left <= 0) return answer(null);
      S.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  function answer(orig) {
    if (S.locked) return; S.locked = true; cancelAnimationFrame(S.raf);
    const q = list[S.i]; const ms = performance.now() - S.t0; const ok = orig === q.a;
    const pts = points(ok, ms, (q.t || 30) * 1000, S.streak);
    let wrong = store.get(wrongKey, []);
    if (ok) { S.score += pts; S.correct++; S.streak++; wrong = wrong.filter(id => id !== q.id); }
    else { S.streak = 0; if (!wrong.includes(q.id)) wrong.push(q.id); }
    store.set(wrongKey, wrong);
    $app.querySelectorAll(".ans").forEach(b => {
      const o = Number(b.dataset.o); b.disabled = true;
      if (o === q.a) b.classList.add("right"); else b.classList.add("dim");
      if (o === orig && !ok) b.classList.add("mine");
    });
    document.getElementById("s-fb").innerHTML = `
      <section class="fb ${orig == null ? "neutral" : ok ? "ok" : "no"}">
        <div class="h">${orig == null ? "Zeit abgelaufen" : ok ? "Richtig! +" + fmt(pts) : "Nicht ganz"}</div>
        <p>${esc(q.x)}</p>${q.s ? `<p class="src">Quelle: ${esc(q.s)}</p>` : ""}
        <div class="row"><button class="btn primary" id="s-next">${S.i + 1 < list.length ? "Weiter" : "Ergebnis"}</button></div>
      </section>`;
    const nb = document.getElementById("s-next"); nb.focus(); nb.onclick = () => { S.i++; S.i < list.length ? show() : end(); };
  }
  function end() {
    const best = store.get("btaq-best-" + c.id, {});
    const key = roundId; const isBest = !best[key] || S.score > best[key];
    if (isBest) { best[key] = S.score; store.set("btaq-best-" + c.id, best); }
    $app.innerHTML = `
      <section class="card center"><h1>${S.correct} von ${list.length} richtig</h1>
        <div class="big-num">${fmt(S.score)}</div><p class="muted">${isBest ? "Neue Bestleistung in dieser Runde." : "Bestleistung: " + fmt(best[key])}</p>
        <div class="row"><button class="btn primary" id="s-again">Nochmal</button><button class="btn" id="s-menu">Andere Runde</button></div></section>`;
    document.getElementById("s-again").onclick = () => soloPlay(c, shuffle(list), roundId);
    document.getElementById("s-menu").onclick = () => viewSoloCourse(c.id);
  }
  show();
  cleanup = () => cancelAnimationFrame(S.raf);
}

/* ---------- Start ---------- */
window.addEventListener("keydown", e => {
  if (!/^[1-4]$/.test(e.key) || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const b = $app.querySelectorAll("button.ans:not([disabled])")[Number(e.key) - 1]; if (b) b.click();
});
if (!LOCAL && !(window.supabase && CFG.supabaseUrl)) console.warn("Supabase nicht geladen – Live-Modus nicht verfügbar.");
go("start");
})();
