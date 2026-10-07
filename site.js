/* Scorekaart Selectie als losse website.
   Dit bestand koppelt de app aan Supabase: inloggen, ledenbeheer en dezelfde
   window.claude.use(...)-functies (db, user, room, downloads) als in de Claude-versie.
   Zo blijft de app zelf gelijk aan de versie in Claude. */
(() => {
  "use strict";
  window.SK_SITE = true;
  const CFG = window.SK_CONFIG;
  const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "sk-auth" } });
  window.SK_SB = sb;

  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  let me = null;               // eigen rij uit leden
  let leden = new Map();       // user_id -> rij
  let resolveReady; const ready = new Promise(r => { resolveReady = r; });

  /* ---------- foutmeldingen in de vorm die de app kent ---------- */
  function norm(err) {
    if (!err) return { code: "unknown", message: "Onbekende fout" };
    const c = err.code || "", m = err.message || String(err);
    if (c === "42501" || /row-level security|permission/i.test(m)) return { code: "permission_denied", message: "Je hebt hier geen rechten voor." };
    if (c === "P0002") return { code: "not_found", message: m };
    if (/JWT|token/i.test(m)) return { code: "session_expired", message: "Log opnieuw in." };
    if (/Failed to fetch|NetworkError|network/i.test(m)) return { code: "unavailable", message: "Geen verbinding." };
    return { code: c || "unknown", message: m };
  }

  /* ---------- db: documenten op paden, live bijgewerkt ---------- */
  const subs = new Set();
  const meta = { fromCache: false, hasPendingWrites: false };
  const snapDoc = (p, d) => Object.freeze({ id: p.split("/").pop(), exists: d != null, data: () => d == null ? undefined : clone(d), metadata: meta });
  const qsnap = rows => { const docs = rows.map(r => snapDoc(r.path, r.data)); return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta }; };
  async function fetchDoc(p) { const { data, error } = await sb.from("docs").select("path,data").eq("path", p).maybeSingle(); if (error) throw norm(error); return data ? data.data : null; }
  async function fetchColl(c) { const { data, error } = await sb.from("docs").select("path,data").eq("coll", c).order("path").limit(2000); if (error) throw norm(error); return data || []; }
  async function deliver(s) {
    try {
      const payload = s.kind === "doc" ? await fetchDoc(s.path) : await fetchColl(s.path);
      if (!subs.has(s)) return;
      const j = JSON.stringify(payload); if (j === s.last) return; s.last = j;
      try { s.next(s.kind === "doc" ? snapDoc(s.path, payload) : qsnap(payload)); } catch (e) { console.error(e); }
    } catch (e) { if (s.err) try { s.err(e); } catch {} }
  }
  let refreshT = null;
  function refreshSoon(ms = 120) { clearTimeout(refreshT); refreshT = setTimeout(() => subs.forEach(deliver), ms); }
  const write = async fn => { const r = await fn(); if (r && r.error) throw norm(r.error); refreshSoon(30); return null; };
  function docRef(p) {
    const segs = p.split("/"); if (segs.length % 2) throw new TypeError("Documentpad heeft een even aantal delen nodig: " + p);
    return {
      id: segs[segs.length - 1], path: p,
      get: async () => snapDoc(p, await fetchDoc(p)),
      set: data => write(() => sb.from("docs").upsert({ path: p, data: clone(data) })),
      update: data => write(() => sb.rpc("doc_update", { p, patch: clone(data) })),
      delete: () => write(() => sb.from("docs").delete().eq("path", p)),
      collection: c => collRef(p + "/" + c),
      onSnapshot(next, err) { const s = { kind: "doc", path: p, next, err, last: undefined }; subs.add(s); deliver(s); return () => subs.delete(s); }
    };
  }
  function collRef(p) {
    const q = {
      path: p, where: () => q, orderBy: () => q, limit: () => q,
      get: async () => qsnap(await fetchColl(p)),
      doc: id => docRef(p + "/" + (id || Math.random().toString(36).slice(2, 12))),
      add: async data => { const r = docRef(p + "/" + Math.random().toString(36).slice(2, 12)); await r.set(data); return r; },
      onSnapshot(next, err) { const s = { kind: "coll", path: p, next, err, last: undefined }; subs.add(s); deliver(s); return () => subs.delete(s); }
    };
    return q;
  }
  const db = Object.freeze({ doc: docRef, collection: collRef });
  let liveOk = false;
  function startLive() {
    sb.channel("docs-live").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, () => refreshSoon())
      .subscribe(st => { liveOk = st === "SUBSCRIBED"; setLive(); if (liveOk) refreshSoon(); });
    // vangnet: ook zonder live verbinding blijft alles bij
    setInterval(() => { if (!liveOk || document.visibilityState === "visible") refreshSoon(0); }, liveOk ? 30000 : 15000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshSoon(0); });
  }
  function setLive() { const l = $("#live"); if (!l) return; if (!liveOk) { l.classList.add("off"); } }

  /* ---------- user ---------- */
  const PAL = ["#2F6F7E", "#7A5C99", "#3F8152", "#A0602A", "#5A6E9C", "#8C3A2A", "#4E7D6F", "#866A2E"];
  function initials(n) { const w = String(n || "?").trim().split(/\s+/); return ((w[0] || "?")[0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase(); }
  function colorOf(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PAL[h % PAL.length]; }
  function avatar(id, name) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="${colorOf(id)}"/><text x="20" y="25.5" font-family="Arial,sans-serif" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${esc(initials(name))}</text></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }
  function prof(id) {
    const r = leden.get(id); const name = r ? (r.naam || r.email) : "";
    return { id, name, avatarUrl: avatar(id, name || "?"), color: colorOf(id), email: r ? r.email : null, isMe: !!me && id === me.user_id, guest: false };
  }
  async function loadLeden() {
    const { data, error } = await sb.from("leden").select("user_id,email,naam,rol,moet_wachtwoord_kiezen").order("naam");
    if (error) throw norm(error);
    leden = new Map((data || []).map(r => [r.user_id, r]));
    return leden;
  }
  const isAdmin = () => !!me && me.rol === "beheerder";
  const user = Object.freeze({
    id: async () => me.user_id,
    isOwner: async () => isAdmin(),
    canEdit: async () => isAdmin(),
    can: async n => n === "data.write" ? true : isAdmin(),
    me: async () => ({ ...prof(me.user_id), isOwner: isAdmin(), canEdit: isAdmin() }),
    name: async () => prof(me.user_id).name,
    avatarUrl: async () => prof(me.user_id).avatarUrl,
    email: async () => me.email,
    profiles: async ids => { const o = {}; [].concat(ids).forEach(id => { o[id] = prof(id); }); return o; },
    search: async q => { await loadLeden().catch(() => {}); const t = String(q || "").toLowerCase(); return [...leden.values()].filter(r => !t || (r.naam || "").toLowerCase().includes(t) || (r.email || "").toLowerCase().includes(t)).slice(0, 8).map(r => prof(r.user_id)); }
  });

  /* ---------- room: wie kijkt er mee ---------- */
  const peerId = "t" + Math.random().toString(36).slice(2, 10);
  let myPres = {}, peers = Object.freeze([]), roomCh = null, roomOn = false;
  const peerHandlers = new Set(), connHandlers = new Set();
  function startRoom() {
    roomCh = sb.channel("kamer", { config: { presence: { key: peerId } } });
    roomCh.on("presence", { event: "sync" }, () => {
      const st = roomCh.presenceState();
      peers = Object.freeze(Object.entries(st).map(([k, metas]) => { const m = metas[metas.length - 1] || {}; return Object.freeze({ peer: k, by: m.by, presence: m.presence || {}, kind: "viewer", isMe: !!me && m.by === me.user_id, sameTab: k === peerId, guest: false, updatedAt: Date.now() }); }));
      peerHandlers.forEach(h => { try { h({ peers, joined: [], left: [], updated: peers }); } catch (e) { console.error(e); } });
    }).subscribe(st => {
      roomOn = st === "SUBSCRIBED"; connHandlers.forEach(h => { try { h(roomOn); } catch {} });
      if (roomOn) roomCh.track({ by: me.user_id, presence: myPres });
    });
  }
  const room = Object.freeze({
    presence: async patch => { const n = { ...myPres }; Object.entries(patch || {}).forEach(([k, v]) => { if (v === null) delete n[k]; else n[k] = v; }); myPres = n; if (roomOn) await roomCh.track({ by: me.user_id, presence: myPres }); },
    peers: () => peers,
    onPeers: h => { peerHandlers.add(h); setTimeout(() => h({ peers, joined: peers, left: [], updated: [] }), 0); return () => peerHandlers.delete(h); },
    emit: async () => {}, on: () => () => {},
    connected: () => roomOn,
    onConnection: h => { connHandlers.add(h); setTimeout(() => h(roomOn), 0); return () => connHandlers.delete(h); },
    canSendToClaudeSession: async () => "off",
    sendToClaudeSession: () => Promise.reject({ code: "claude_unavailable", message: "Niet beschikbaar op de website." })
  });

  /* ---------- downloads ---------- */
  const downloads = Object.freeze({
    save: async ({ filename, data, mimeType }) => {
      const type = mimeType || (/\.csv$/i.test(filename) ? "text/csv;charset=utf-8" : /\.html?$/i.test(filename) ? "text/html;charset=utf-8" : "application/octet-stream");
      const url = URL.createObjectURL(new Blob([data], { type }));
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return { status: "saved" };
    }
  });

  const caps = { db, user, room, downloads };
  window.claude = { use: name => ready.then(() => caps[name] || null) };

  /* ---------- inloggen ---------- */
  const gate = document.createElement("div");
  gate.id = "gate"; gate.className = "gate";
  document.body.appendChild(gate);
  function showGate(html) { gate.innerHTML = `<div class="gate-card"><div class="gate-brand"><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span><strong>Scorekaart Selectie</strong></div>${html}</div>`; gate.hidden = false; document.body.classList.add("gated"); const f = gate.querySelector("input"); if (f) f.focus(); }
  function hideGate() { gate.hidden = true; gate.innerHTML = ""; document.body.classList.remove("gated"); }
  const msg = (t, ok) => { const m = $("#gate-msg"); if (m) { m.textContent = t || ""; m.className = ok ? "gate-ok" : "gate-err"; } };
  const busy = (b, on, label) => { if (!b) return; b.disabled = on; if (label) b.textContent = label; };

  async function loginView() {
    let open = false; try { const { data } = await sb.rpc("setup_open"); open = !!data; } catch {}
    showGate(`<h1>Inloggen</h1>
      <form id="f-login" class="gate-form" novalidate>
        <label class="lab" for="l-mail">E-mailadres</label><input type="email" id="l-mail" autocomplete="username" required>
        <label class="lab" for="l-pw">Wachtwoord</label><input type="password" id="l-pw" autocomplete="current-password" required>
        <p id="gate-msg" class="gate-err" role="alert"></p>
        <button class="btn" type="submit">Inloggen</button>
      </form>
      <p class="muted small">Nog geen account? Vraag de beheerder om je toe te voegen.</p>
      ${open ? `<p class="small"><button class="link" type="button" id="to-setup">Eerste keer: beheerder instellen</button></p>` : ""}`);
    $("#f-login").addEventListener("submit", async ev => {
      ev.preventDefault();
      const b = ev.target.querySelector("button[type=submit]"), email = $("#l-mail").value.trim(), password = $("#l-pw").value;
      if (!email || !password) return msg("Vul je e-mailadres en wachtwoord in.");
      busy(b, true, "Bezig…");
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) { busy(b, false, "Inloggen"); return msg(/Invalid login/i.test(error.message) ? "E-mailadres of wachtwoord klopt niet." : "Inloggen lukte niet. Probeer het opnieuw."); }
      afterLogin();
    });
    const ts = $("#to-setup"); if (ts) ts.addEventListener("click", setupView);
  }
  function setupView() {
    showGate(`<h1>Beheerder instellen</h1>
      <p class="muted small">Dit doe je één keer. Daarna voeg je collega's toe.</p>
      <form id="f-setup" class="gate-form" novalidate>
        <label class="lab" for="s-naam">Je naam</label><input type="text" id="s-naam" autocomplete="name">
        <label class="lab" for="s-mail">E-mailadres</label><input type="email" id="s-mail" autocomplete="username">
        <label class="lab" for="s-pw">Kies een wachtwoord <span class="muted small">(minstens 10 tekens)</span></label><input type="password" id="s-pw" autocomplete="new-password">
        <label class="lab" for="s-code">Installatiecode</label><input type="text" id="s-code" autocomplete="off" spellcheck="false">
        <p id="gate-msg" class="gate-err" role="alert"></p>
        <button class="btn" type="submit">Beheerder instellen</button>
      </form>
      <p class="small"><button class="link" type="button" id="to-login">Terug naar inloggen</button></p>`);
    $("#to-login").addEventListener("click", loginView);
    $("#f-setup").addEventListener("submit", async ev => {
      ev.preventDefault();
      const b = ev.target.querySelector("button[type=submit]");
      const body = { action: "setup", naam: $("#s-naam").value.trim(), email: $("#s-mail").value.trim(), wachtwoord: $("#s-pw").value, code: $("#s-code").value.trim() };
      if (!body.naam || !body.email || !body.wachtwoord || !body.code) return msg("Vul alle velden in.");
      if (body.wachtwoord.length < 10) return msg("Kies een wachtwoord van minstens 10 tekens.");
      busy(b, true, "Bezig…");
      const r = await callLeden(body);
      if (r.error) { busy(b, false, "Beheerder instellen"); return msg(r.error); }
      const { error } = await sb.auth.signInWithPassword({ email: body.email, password: body.wachtwoord });
      if (error) { busy(b, false, "Beheerder instellen"); return msg("Account gemaakt, maar inloggen lukte niet. Log in via het inlogscherm."); }
      afterLogin();
    });
  }
  function chooseView(first) {
    showGate(`<h1>${first ? "Kies je eigen wachtwoord" : "Wachtwoord wijzigen"}</h1>
      ${first ? `<p class="muted small">Je bent ingelogd met een tijdelijk wachtwoord.</p>` : ""}
      <form id="f-pw" class="gate-form" novalidate>
        <label class="lab" for="p1">Nieuw wachtwoord <span class="muted small">(minstens 10 tekens)</span></label><input type="password" id="p1" autocomplete="new-password">
        <label class="lab" for="p2">Nog een keer</label><input type="password" id="p2" autocomplete="new-password">
        <p id="gate-msg" class="gate-err" role="alert"></p>
        <button class="btn" type="submit">Opslaan</button>
      </form>
      ${first ? "" : `<p class="small"><button class="link" type="button" id="pw-cancel">Annuleren</button></p>`}`);
    const c = $("#pw-cancel"); if (c) c.addEventListener("click", hideGate);
    $("#f-pw").addEventListener("submit", async ev => {
      ev.preventDefault();
      const b = ev.target.querySelector("button[type=submit]"), a = $("#p1").value, z = $("#p2").value;
      if (a.length < 10) return msg("Kies een wachtwoord van minstens 10 tekens.");
      if (a !== z) return msg("De twee wachtwoorden zijn niet gelijk.");
      busy(b, true, "Bezig…");
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) { busy(b, false, "Opslaan"); return msg(/same|different/i.test(error.message) ? "Kies een ander wachtwoord dan het tijdelijke." : "Opslaan lukte niet: " + error.message); }
      await sb.rpc("wachtwoord_gekozen");
      if (me) me.moet_wachtwoord_kiezen = false;
      if (first) afterLogin(); else { hideGate(); flash("Wachtwoord gewijzigd"); }
    });
  }
  function noAccessView(email) {
    showGate(`<h1>Nog geen toegang</h1><p>Je bent ingelogd als ${esc(email)}, maar je staat nog niet in de lijst van leden. Vraag de beheerder om je toe te voegen.</p>
      <p><button class="btn ghost" type="button" id="na-out">Uitloggen</button></p>`);
    $("#na-out").addEventListener("click", logout);
  }
  async function afterLogin() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return loginView();
    const { data: row, error } = await sb.from("leden").select("user_id,email,naam,rol,moet_wachtwoord_kiezen").eq("user_id", session.user.id).maybeSingle();
    if (error) { showGate(`<h1>Geen verbinding</h1><p class="muted">De database is niet bereikbaar. Probeer het straks opnieuw.</p><p><button class="btn" type="button" id="gate-retry">Opnieuw</button></p>`); $("#gate-retry").addEventListener("click", () => location.reload()); return; }
    if (!row) return noAccessView(session.user.email);
    me = row;
    if (me.moet_wachtwoord_kiezen) return chooseView(true);
    await loadLeden().catch(() => {});
    hideGate();
    addNav();
    startLive(); startRoom();
    resolveReady();
  }
  async function logout() { try { await sb.auth.signOut(); } catch {} location.reload(); }
  async function callLeden(body) {
    try {
      const { data: { session } } = await sb.auth.getSession();
      const r = await fetch(CFG.url + "/functions/v1/leden", { method: "POST", headers: { "Content-Type": "application/json", apikey: CFG.key, Authorization: "Bearer " + (session ? session.access_token : CFG.key) }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || "Dat lukte niet." };
    } catch { return { error: "Geen verbinding. Probeer het opnieuw." }; }
  }
  function flash(t) { const el = $("#toast"); if (!el) return; el.textContent = t; el.hidden = false; setTimeout(() => { el.hidden = true; }, 3200); }

  /* ---------- menu en ledenbeheer ---------- */
  function addNav() {
    if ($("#sitenav")) return;
    const who = $(".top .who"); if (!who) return;
    const nav = document.createElement("span"); nav.id = "sitenav"; nav.className = "sitenav";
    nav.innerHTML = `${isAdmin() ? `<button class="link small" type="button" data-site="leden">Leden</button>` : ""}<button class="link small muted" type="button" data-site="pw">Wachtwoord</button><button class="link small muted" type="button" data-site="uit">Uitloggen</button>`;
    who.appendChild(nav);
    nav.addEventListener("click", ev => { const b = ev.target.closest("[data-site]"); if (!b) return; const a = b.dataset.site; if (a === "uit") logout(); else if (a === "pw") chooseView(false); else if (a === "leden") ledenView(); });
  }
  let lastPw = null;
  async function ledenView() {
    await loadLeden().catch(() => {});
    const rows = [...leden.values()].sort((a, b) => (a.rol === b.rol ? (a.naam || "").localeCompare(b.naam || "") : a.rol === "beheerder" ? -1 : 1));
    showGate(`<div class="gate-head"><h1>Leden</h1><button class="link small" type="button" id="ld-close">Sluiten</button></div>
      <p class="muted small">Alleen mensen in deze lijst kunnen inloggen. Een nieuw lid krijgt een tijdelijk wachtwoord en kiest bij de eerste keer een eigen wachtwoord.</p>
      ${lastPw ? `<div class="gate-pw"><span>Tijdelijk wachtwoord voor ${esc(lastPw.naam)}</span><code id="ld-pw">${esc(lastPw.pw)}</code><button class="btn ghost sm" type="button" id="ld-copy">Kopiëren</button><span class="muted small">Geef dit door via Teams of telefoon. Je ziet het maar één keer.</span></div>` : ""}
      <ul class="ld-list">${rows.map(r => `<li><span class="ld-n"><strong>${esc(r.naam || r.email)}</strong><span class="muted small">${esc(r.email)}${r.rol === "beheerder" ? ", beheerder" : ""}${r.moet_wachtwoord_kiezen ? ", nog niet ingelogd" : ""}</span></span>
        ${r.user_id === me.user_id ? `<span class="muted small">jij</span>` : `<span class="ld-act"><button class="link small" type="button" data-ld="reset" data-u="${esc(r.user_id)}">Nieuw wachtwoord</button><button class="link small muted" type="button" data-ld="del" data-u="${esc(r.user_id)}">Verwijderen</button></span>`}</li>`).join("")}</ul>
      <form id="f-add" class="gate-form" novalidate><h2>Collega toevoegen</h2>
        <label class="lab" for="a-naam">Naam</label><input type="text" id="a-naam" autocomplete="off">
        <label class="lab" for="a-mail">E-mailadres</label><input type="email" id="a-mail" autocomplete="off">
        <p id="gate-msg" class="gate-err" role="alert"></p>
        <button class="btn" type="submit">Toevoegen</button></form>`);
    gate.querySelector(".gate-card").classList.add("wide");
    $("#ld-close").addEventListener("click", () => { lastPw = null; hideGate(); });
    const cp = $("#ld-copy"); if (cp) cp.addEventListener("click", () => { navigator.clipboard && navigator.clipboard.writeText(lastPw.pw).then(() => flash("Gekopieerd")).catch(() => {}); });
    $("#f-add").addEventListener("submit", async ev => {
      ev.preventDefault();
      const b = ev.target.querySelector("button[type=submit]"), naam = $("#a-naam").value.trim(), email = $("#a-mail").value.trim();
      if (!naam || !email) return msg("Vul naam en e-mailadres in.");
      busy(b, true, "Bezig…");
      const r = await callLeden({ action: "add", naam, email });
      if (r.error) { busy(b, false, "Toevoegen"); return msg(r.error); }
      lastPw = { naam, pw: r.wachtwoord }; ledenView();
    });
    gate.querySelectorAll("[data-ld]").forEach(btn => btn.addEventListener("click", async () => {
      const u = btn.dataset.u, r0 = leden.get(u), naam = r0 ? (r0.naam || r0.email) : "dit lid";
      if (btn.dataset.ld === "del") {
        if (btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "Zeker weten?"; return; }
        const r = await callLeden({ action: "remove", user_id: u }); if (r.error) return msg(r.error);
        lastPw = null; ledenView();
      } else {
        const r = await callLeden({ action: "reset", user_id: u }); if (r.error) return msg(r.error);
        lastPw = { naam, pw: r.wachtwoord }; ledenView();
      }
    }));
  }

  sb.auth.onAuthStateChange(ev => { if (ev === "SIGNED_OUT" && me) location.reload(); });
  // start
  sb.auth.getSession().then(({ data }) => { if (data && data.session) afterLogin(); else loginView(); }).catch(() => loginView());
})();
