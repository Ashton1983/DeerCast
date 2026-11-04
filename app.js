/* DeerCast app: stand logging, offline storage, sync to the group's Google Sheet,
   results and best-day planner. */
(function () {
  const A = window.Astro, AN = window.Analysis;
  const KEY = "deercast.v1";
  const HOUR = 3600000;
  const $app = document.getElementById("app");

  // ---------------- storage ----------------
  function load() {
    try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) return s; } catch (e) {}
    return { v: 1, hunter: "", sits: [], events: [], myLeases: [], serverLeases: [], server: null, lastSync: null, lastSyncError: null, config: { backendUrl: "", teamKey: "" } };
  }
  let S = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast("Phone storage is full: sync, then try again"); } }
  const cfg = () => {
    const c = window.DEERCAST_CONFIG || {};
    return { backendUrl: (c.backendUrl || S.config.backendUrl || "").trim(), teamKey: (c.teamKey || S.config.teamKey || "").trim(), fromFile: !!c.backendUrl };
  };

  // ---------------- view state ----------------
  let U = { view: S.hunter ? "home" : "welcome", modal: null, filters: { who: "all", deer: "all", lease: "" }, plan: { range: "week", lease: "" }, forecast: {}, busy: false };
  let timer = null, wakeLock = null;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const ms = (v) => (typeof v === "number" ? v : Date.parse(v));
  const openSit = () => S.sits.find((s) => !s.end && s.hunter === S.hunter);
  const sitEvents = (id) => S.events.filter((e) => e.sitId === id && !e.deleted);
  const TYPE_NAMES = { buck: "Buck", doe: "Doe", chase: "Chasing", fight: "Fighting", buckKill: "Buck down", doeKill: "Doe down" };
  function dur(msLen) { const m = Math.max(0, Math.round(msLen / 60000)); return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m"; }
  function ago(t) {
    if (!t) return "never";
    const m = Math.round((Date.now() - ms(t)) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " hr ago" : Math.round(m / 1440) + " days ago";
  }
  const fmtDate = (t, o) => new Date(t).toLocaleDateString([], o || { weekday: "short", month: "short", day: "numeric" });

  let toastT = null;
  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
    el.textContent = msg; el.style.opacity = "1";
    clearTimeout(toastT); toastT = setTimeout(() => (el.style.opacity = "0"), 1800);
  }
  function haptic() { try { document.getElementById("hapLabel").click(); } catch (e) {} }

  function allLeases() {
    const m = {};
    (S.serverLeases || []).forEach((l) => (m[l.name] = Object.assign({}, l)));
    S.myLeases.forEach((l) => (m[l.name] = Object.assign(m[l.name] || {}, l)));
    return Object.values(m).sort((a, b) => a.name.localeCompare(b.name));
  }
  function upsertLease(l) {
    const i = S.myLeases.findIndex((x) => x.name === l.name);
    if (i >= 0) S.myLeases[i] = Object.assign(S.myLeases[i], l); else S.myLeases.push(l);
  }

  // ---------------- GPS ----------------
  function locate(cb) {
    if (!navigator.geolocation) return cb(null);
    navigator.geolocation.getCurrentPosition((p) => cb(p.coords), () => cb(null), { enableHighAccuracy: true, timeout: 20000, maximumAge: 120000 });
  }

  // ---------------- sit + taps ----------------
  function startSit(lease) {
    const sit = { id: uid(), hunter: S.hunter, lease: lease.name, zone: lease.zone || "", start: new Date().toISOString(), end: null,
      lat: lease.lat == null ? null : lease.lat, lon: lease.lon == null ? null : lease.lon, gpsAccuracyM: null, synced: false };
    S.sits.push(sit); upsertLease({ name: lease.name, zone: lease.zone || "" }); save();
    go("stand");
    locate((c) => {
      if (!c) { if (sit.lat == null) toast("No GPS fix yet: moon and weather need location"); return; }
      sit.lat = +c.latitude.toFixed(5); sit.lon = +c.longitude.toFixed(5); sit.gpsAccuracyM = Math.round(c.accuracy); sit.synced = false;
      upsertLease({ name: lease.name, lat: sit.lat, lon: sit.lon });
      sitEvents(sit.id).forEach((e) => { if (e.lat == null) { e.lat = sit.lat; e.lon = sit.lon; Object.assign(e, A.stamp(ms(e.time), sit.lat, sit.lon, sit.zone)); e.synced = false; } });
      save();
    });
  }
  function addEvent(type, extra) {
    const sit = openSit(); if (!sit) return;
    const now = Date.now();
    const ev = Object.assign({ id: uid(), sitId: sit.id, hunter: sit.hunter, lease: sit.lease, zone: sit.zone, type, time: new Date(now).toISOString(),
      lat: sit.lat, lon: sit.lon, synced: false }, A.stamp(now, sit.lat, sit.lon, sit.zone), extra || {});
    S.events.push(ev); save(); haptic();
    const n = sitEvents(sit.id).filter((e) => e.type === type).length;
    toast(TYPE_NAMES[type] + " logged" + (n > 1 ? "  (" + n + ")" : ""));
    if (type === "buckKill" || type === "doeKill") locate((c) => { if (c) { ev.lat = +c.latitude.toFixed(5); ev.lon = +c.longitude.toFixed(5); ev.synced = false; save(); } });
    render();
    const btn = document.querySelector('[data-type="' + type + '"]');
    if (btn) { btn.classList.remove("flash"); void btn.offsetWidth; btn.classList.add("flash"); }
  }
  function undo() {
    const sit = openSit(); if (!sit) return;
    const evs = sitEvents(sit.id); const last = evs[evs.length - 1];
    if (!last) return toast("Nothing to undo");
    if (last.syncedOnce) { last.deleted = true; last.synced = false; } else S.events = S.events.filter((e) => e !== last);
    save(); haptic(); toast("Removed: " + TYPE_NAMES[last.type]); render();
  }
  function endSit(endTime) {
    const sit = openSit(); if (!sit) return;
    sit.end = new Date(endTime || Date.now()).toISOString(); sit.synced = false; save();
    const n = sitEvents(sit.id).filter((e) => AN.DEER[e.type]).length;
    U.modal = null; go("home");
    toast("Sit saved: " + dur(ms(sit.end) - ms(sit.start)) + ", " + n + " deer");
    sync();
  }

  // ---------------- sync ----------------
  let syncing = false;
  async function sync(opts) {
    const c = cfg();
    if (!c.backendUrl || syncing) return false;
    syncing = true;
    const sits = S.sits.filter((s) => !s.synced), events = S.events.filter((e) => !e.synced);
    const strip = (o) => { const r = Object.assign({}, o); delete r.synced; delete r.syncedOnce; return r; };
    try {
      let leases = null;
      if (sits.length || events.length || (opts && opts.force)) {
        const res = await timed(fetch(c.backendUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ key: c.teamKey, sits: sits.map(strip), events: events.map(strip) }) }), 45000);
        const j = await res.json();
        if (!j.ok) throw new Error(j.error || "sync failed");
        sits.forEach((s) => { s.synced = true; });
        events.forEach((e) => { e.synced = true; e.syncedOnce = true; });
        S.events = S.events.filter((e) => !(e.deleted && e.synced));
        leases = j.leases;
      }
      if (leases) S.serverLeases = leases;
      S.lastSync = new Date().toISOString(); S.lastSyncError = null; save();
      if (opts && opts.fetch) await fetchData();
      syncing = false; render(); return true;
    } catch (e) {
      S.lastSyncError = !e || /fetch|network|load failed|signal/i.test(e.message || "") ? "no signal" : e.message; save(); syncing = false; render(); return false;
    }
  }
  async function fetchData() {
    const c = cfg(); if (!c.backendUrl) return;
    const res = await timed(fetch(c.backendUrl + (c.backendUrl.includes("?") ? "&" : "?") + "action=data&key=" + encodeURIComponent(c.teamKey)), 45000);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || "download failed");
    S.server = { sits: j.sits, events: j.events, fetched: new Date().toISOString() };
    if (j.leases) S.serverLeases = j.leases;
    save();
  }
  function timed(p, msMax) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("no signal")), msMax))]); }
  function combined() {
    const sits = {}, events = {};
    if (S.server) { S.server.sits.forEach((s) => (sits[s.id] = s)); S.server.events.forEach((e) => (events[e.id] = e)); }
    S.sits.forEach((s) => { if (!sits[s.id] || !s.synced) sits[s.id] = Object.assign({}, sits[s.id] || {}, s); });
    S.events.forEach((e) => { if (!events[e.id] || !e.synced) events[e.id] = e; });
    return { sits: Object.values(sits), events: Object.values(events).filter((e) => !e.deleted) };
  }
  const unsyncedCount = () => S.sits.filter((s) => !s.synced && s.end).length + S.events.filter((e) => !e.synced).length;

  // ---------------- forecast (NOAA NWS) ----------------
  async function fetchForecast(lat, lon) {
    const key = lat.toFixed(2) + "," + lon.toFixed(2);
    const cached = U.forecast[key];
    if (cached && Date.now() - cached.at < 3 * HOUR) return cached.days;
    const p = await (await timed(fetch("https://api.weather.gov/points/" + lat.toFixed(4) + "," + lon.toFixed(4)), 20000)).json();
    const f = await (await timed(fetch(p.properties.forecastHourly), 20000)).json();
    const temps = {}, morning = {};
    f.properties.periods.forEach((per) => {
      const t = Date.parse(per.startTime), d = A.ymd(t), hr = new Date(t).getHours();
      (temps[d] = temps[d] || []).push(per.temperatureUnit === "C" ? per.temperature * 9 / 5 + 32 : per.temperature);
      if (hr >= 6 && hr <= 9) {
        const mph = String(per.windSpeed || "").match(/\d+/g);
        (morning[d] = morning[d] || []).push({ w: mph ? Math.max.apply(null, mph.map(Number)) : null, dir: per.windDirection });
      }
    });
    const days = {}, keys = Object.keys(temps).sort();
    keys.forEach((d, i) => {
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const prev = keys[i - 1];
      const full = temps[d].length >= 20, prevFull = prev && temps[prev].length >= 20;
      const m = morning[d] || [];
      const w = m.filter((x) => x.w != null);
      days[d] = { tempChange: full && prevFull ? mean(temps[d]) - mean(temps[prev]) : null,
        windMph: w.length ? mean(w.map((x) => x.w)) : null, windDir: m.length ? String(m[0].dir || "").replace(/^([NSEW]{1,2}).*$/, "$1") : null };
      if (days[d].windDir && days[d].windDir.length === 3) days[d].windDir = days[d].windDir.slice(1);
    });
    U.forecast[key] = { at: Date.now(), days };
    return days;
  }

  // ---------------- navigation ----------------
  function go(view) {
    U.view = view; U.modal = null;
    if (view === "stand") startTimer(); else stopTimer();
    render(); window.scrollTo(0, 0);
  }
  function startTimer() {
    stopTimer();
    timer = setInterval(() => { const el = document.getElementById("clock"); const s = openSit(); if (el && s) el.textContent = dur(Date.now() - ms(s.start)); }, 1000);
    try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then((l) => (wakeLock = l)).catch(() => {}); } catch (e) {}
  }
  function stopTimer() { clearInterval(timer); timer = null; try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }

  // ---------------- views ----------------
  function syncPill() {
    const c = cfg(), n = unsyncedCount();
    if (!c.backendUrl) return '<span class="pill">Not connected to group</span>';
    if (syncing) return '<span class="pill">Syncing…</span>';
    if (n) return '<span class="pill warn">' + n + " waiting to sync</span>";
    return '<span class="pill">Synced ' + esc(ago(S.lastSync)) + "</span>";
  }

  function vWelcome() {
    return `<img class="logo" src="icon-180.png" alt="">
      <h1 class="center">DeerCast</h1>
      <p class="center muted">Tap a button for every deer you see. DeerCast adds the moon, weather and season, and shows which conditions put deer on their feet.</p>
      <div class="card"><p><b>Your name</b> (once, so the group can tell whose sits are whose)</p>
      <input type="text" id="name" placeholder="First name" autocomplete="given-name" maxlength="30"></div>
      <button class="big primary" data-act="saveName">Get started</button>`;
  }

  function vHome() {
    const sit = openSit(), mine = S.sits.filter((s) => s.end && s.hunter === S.hunter);
    const hrs = mine.reduce((a, s) => a + (ms(s.end) - ms(s.start)) / HOUR, 0);
    const deer = S.events.filter((e) => !e.deleted && e.hunter === S.hunter && AN.DEER[e.type] && mine.some((s) => s.id === e.sitId)).length;
    const standalone = window.navigator.standalone || window.matchMedia("(display-mode: standalone)").matches;
    return `<div class="topbar"><h1>DeerCast</h1>${syncPill()}</div>
      <p class="muted">Hunter: ${esc(S.hunter)}</p>
      ${!standalone ? '<div class="card"><b>Add DeerCast to your Home Screen.</b><p class="small muted">In Safari tap the Share button, then <b>Add to Home Screen</b>, then open DeerCast from its icon. It only works offline from the Home Screen icon.</p></div>' : ""}
      ${sit ? `<button class="big primary" data-act="go" data-v="stand">Back to stand · ${esc(sit.lease)}</button>`
            : `<button class="big primary" data-act="go" data-v="pickLease">START SIT</button>`}
      <div class="grid2" style="margin-top:10px">
        <button data-act="go" data-v="results">Results</button>
        <button data-act="go" data-v="planner">Best days</button>
      </div>
      <div class="card"><div class="row spread"><span class="muted">My season so far</span></div>
        <div class="stats" style="margin-top:8px">
          <div class="stat"><b>${mine.length}</b><span>sits</span></div>
          <div class="stat"><b>${hrs.toFixed(1)}</b><span>hours</span></div>
          <div class="stat"><b>${deer}</b><span>deer seen</span></div>
        </div></div>
      ${S.lastSyncError && unsyncedCount() ? `<p class="small muted">Last sync didn't go through (${esc(S.lastSyncError)}). Your taps are safe on this phone and will sync when you have signal.</p>` : ""}
      <button class="ghost" style="width:100%;margin-top:6px" data-act="go" data-v="settings">Settings</button>`;
  }

  function vPickLease() {
    const ls = allLeases();
    return `<div class="topbar"><button class="link" data-act="go" data-v="home">‹ Back</button></div>
      <h1>Where are you hunting?</h1>
      ${ls.map((l, i) => `<button class="big" style="margin:6px 0;text-align:left" data-act="pick" data-i="${i}">${esc(l.name)}<span class="small muted" style="float:right;font-weight:500">${l.zone ? "Zone " + esc(l.zone) : ""}</span></button>`).join("")}
      <button class="big ghost" style="margin-top:6px" data-act="go" data-v="newLease">+ New lease</button>`;
  }

  function vNewLease() {
    const z = U.newZone || "";
    return `<div class="topbar"><button class="link" data-act="go" data-v="pickLease">‹ Back</button></div>
      <h1>New lease</h1>
      <p class="muted small">Type the name once. Friends who hunt the same lease should use the same name so the group's data lines up.</p>
      <input type="text" id="leaseName" placeholder="e.g. Saline River lease" maxlength="40" value="${esc(U.newLeaseName || "")}">
      <h3>AGFC deer zone</h3>
      <div class="grid4">${A.ZONE_LIST.map((x) => `<button class="${z === x ? "sel" : ""}" data-act="zone" data-z="${x}">${x}</button>`).join("")}
        <button class="${z === "?" ? "sel" : ""}" style="grid-column: span 4" data-act="zone" data-z="?">Not sure</button></div>
      <p class="small muted">Sets which gun-season dates apply. Not sure? Pick it later; statewide dates will be used.</p>
      <button class="big primary" style="margin-top:12px" data-act="saveLease">Start sit here</button>`;
  }

  function vStand() {
    const sit = openSit();
    if (!sit) return vHome();
    const evs = sitEvents(sit.id), cnt = (t) => evs.filter((e) => e.type === t).length;
    const stale = Date.now() - ms(sit.start) > 10 * HOUR && !sit.staleOk;
    const lastT = evs.length ? ms(evs[evs.length - 1].time) : ms(sit.start);
    return `<div class="stand">
      <div class="topbar"><button class="link" data-act="go" data-v="home">‹ Home</button><span class="pill">${esc(sit.lease)}${sit.lat == null ? " · finding GPS…" : ""}</span></div>
      ${stale ? `<div class="card"><b>Still on stand?</b><p class="small muted">This sit started ${esc(ago(sit.start))}.</p>
        <div class="grid2"><button data-act="staleEnd" data-t="${Math.max(lastT + 15 * 60000, ms(sit.start) + 30 * 60000)}">End at my last tap</button><button data-act="dismissStale">Still here</button></div></div>` : ""}
      <div class="timer">On stand <b id="clock">${dur(Date.now() - ms(sit.start))}</b></div>
      <div class="grid2">
        <button class="tap buck" data-act="tap" data-type="buck">BUCK<span class="n">${cnt("buck")} seen</span></button>
        <button class="tap doe" data-act="tap" data-type="doe">DOE<span class="n">${cnt("doe")} seen</span></button>
      </div>
      <div class="label">RUT</div>
      <div class="grid2">
        <button class="tap rut" data-act="tap" data-type="chase">CHASING<span class="n">${cnt("chase")}</span></button>
        <button class="tap rut" data-act="tap" data-type="fight">FIGHTING<span class="n">${cnt("fight")}</span></button>
      </div>
      <div class="label">HARVEST</div>
      <div class="grid2">
        <button class="tap kill" data-act="buckKill" data-type="buckKill">BUCK DOWN</button>
        <button class="tap kill" data-act="doeKill" data-type="doeKill">DOE DOWN</button>
      </div>
      <div class="spacer"></div>
      <button class="ghost" data-act="undo">Undo last tap</button>
      <button class="big primary" data-act="endAsk">END SIT</button>
      <p class="small muted center">One tap per deer. Saw a buck chasing a doe? Tap BUCK, DOE, then CHASING.</p>
    </div>`;
  }

  const ANTLER_STEPS = [
    { key: "points", title: "Points", opts: ["4 or fewer", "5–6", "7–8", "9–10", "11+"] },
    { key: "spread", title: "Inside spread", opts: ['Under 12"', '12–15"', '15–18"', '18"+'] },
    { key: "mass", title: "Mass", opts: ["Light", "Average", "Heavy"] },
    { key: "age", title: "Estimated age", opts: ["1.5 yrs", "2.5 yrs", "3.5 yrs", "4.5+ yrs"] },
  ];
  function mAntler() {
    const a = U.modal.antler, st = ANTLER_STEPS[a.step];
    return `<div class="modal"><div class="sheet">
      <div class="row spread"><b style="font-size:20px">Buck down: antler survey</b><button class="link" data-act="closeModal">Cancel</button></div>
      <div class="step">${ANTLER_STEPS.map((s, i) => `<div class="dot ${i <= a.step ? "on" : ""}">${i + 1}</div>`).join("")}<span class="muted" style="margin-left:6px">${st.title}</span></div>
      <div class="grid2">${st.opts.map((o) => `<button class="big" data-act="antler" data-o="${esc(o)}">${esc(o)}</button>`).join("")}</div>
      <div class="row spread" style="margin-top:12px">
        ${a.step ? '<button class="link" data-act="antlerBack">‹ Back</button>' : "<span></span>"}
        <button class="link" data-act="antlerSkip">Skip survey, just log the kill</button></div>
    </div></div>`;
  }
  function mConfirm(title, body, yesAct, yesText, noText) {
    return `<div class="modal"><div class="sheet"><b style="font-size:20px">${title}</b><p class="muted">${body}</p>
      <div class="grid2" style="margin-top:12px"><button class="big" data-act="closeModal">${noText || "Cancel"}</button><button class="big primary" data-act="${yesAct}">${yesText}</button></div></div></div>`;
  }

  // ---------- results ----------
  function vResults() {
    const data = combined(), f = U.filters;
    const leases = [...new Set(data.sits.map((s) => s.lease).filter(Boolean))].sort();
    const st = AN.analyze(data, { hunter: f.who === "me" ? S.hunter : null, lease: f.lease || null, deer: f.deer });
    const T = st.totals, c = cfg();
    const tab = (group, val, label) => `<button class="${U.filters[group] === val ? "sel" : ""}" data-act="filter" data-g="${group}" data-val="${esc(val)}">${esc(label)}</button>`;
    let h = `<div class="topbar"><button class="link" data-act="go" data-v="home">‹ Home</button>
        ${c.backendUrl ? `<button class="link" data-act="refresh">${U.busy ? "Updating…" : "Update"}</button>` : ""}</div>
      <h1>Results</h1>
      <p class="small muted">${S.server ? "Group data from " + esc(ago(S.server.fetched)) : c.backendUrl ? "Tap Update to load the group's data." : "This phone only. Connect to your group's sheet in Settings."}</p>
      <div class="tabs">${tab("who", "all", "Everyone")}${tab("who", "me", "Just me")}</div>
      <div class="tabs">${tab("deer", "all", "All deer")}${tab("deer", "buck", "Bucks")}${tab("deer", "doe", "Does")}</div>
      ${leases.length > 1 ? `<div class="tabs">${tab("lease", "", "All leases")}${leases.map((l) => tab("lease", l, l)).join("")}</div>` : ""}
      <div class="stats">
        <div class="stat"><b>${T.sits}</b><span>sits</span></div>
        <div class="stat"><b>${T.hours.toFixed(1)}</b><span>hours on stand</span></div>
        <div class="stat"><b>${T.rate.toFixed(2)}</b><span>${f.deer === "buck" ? "bucks" : f.deer === "doe" ? "does" : "deer"} / hour</span></div>
      </div>`;
    if (!T.sits) return h + `<div class="card"><p>No finished sits yet. Start a sit, tap what you see, and end the sit when you climb down.</p></div>`;
    if (T.pendingWeather) h += `<p class="small muted">${T.pendingWeather} sit${T.pendingWeather > 1 ? "s are" : " is"} still waiting for weather. It's filled in after a sit syncs to the group sheet.</p>`;
    h += `<h2>What put deer on their feet</h2>`;
    if (!st.top.length) h += `<p class="muted">Not enough hours yet to call anything. Keep logging; conditions show up here after about 3 hours across 2 or more sits.</p>`;
    st.top.forEach((b, i) => {
      h += `<div class="topc ${i === 0 ? "first" : ""}"><div><div class="what">${esc(b.label)}</div><div class="why">${esc(b.factor)} · ${b.hours.toFixed(1)} hrs · ${AN.confidence(b.hours)}</div></div>
        <div class="num">${b.rate.toFixed(1)}/hr<div class="why" style="text-align:right">${pct(b.lift)}</div></div></div>`;
    });
    if (st.worst.length) {
      h += `<h3>Slowest conditions</h3>`;
      st.worst.forEach((b) => (h += `<div class="topc"><div><div class="what">${esc(b.label)}</div><div class="why">${esc(b.factor)} · ${b.hours.toFixed(1)} hrs</div></div><div class="num">${b.rate.toFixed(1)}/hr<div class="why bad" style="text-align:right">${pct(b.lift)}</div></div></div>`));
    }
    h += `<p class="small muted">Rates are deer seen per hour on stand. Percent is versus the average for that factor, pulled toward average when there are few hours, so one lucky sit can't top the list.</p>`;
    const rut = st.rutByWeek.filter((w) => w.hours > 0);
    if (rut.length && T.rut) {
      const mx = Math.max.apply(null, rut.map((w) => w.rate)) || 1;
      h += `<h2>Rut activity by week</h2><div class="card">${rut.map((w) => bar(w.label, w.rate.toFixed(2) + "/hr", w.rate / mx, w.rate === mx, w.n + " chase/fight · " + w.hours.toFixed(1) + " hrs")).join("")}</div>`;
    }
    h += `<h2>Every factor</h2>`;
    st.factors.forEach((fa) => {
      if (!fa.buckets.length) return;
      const mx = Math.max.apply(null, fa.buckets.map((b) => b.rate)) || 1;
      h += `<details><summary>${esc(fa.label)}</summary>${fa.buckets.map((b) => bar(b.label, b.rate.toFixed(2) + "/hr", b.rate / mx, b.lift >= 1.15 && b.hours >= 3, b.n + " deer · " + b.hours.toFixed(1) + " hrs · " + b.sits + " sits")).join("")}</details>`;
    });
    if (st.harvest.length) {
      h += `<h2>Harvest log</h2>`;
      st.harvest.forEach((e) => {
        const ant = e.type === "buckKill" ? [e.points && e.points + " pts", e.spread, e.mass && e.mass + " mass", e.age].filter(Boolean).join(" · ") : "";
        const cc = e.conditions || {};
        h += `<div class="card"><div class="row spread"><b>${e.type === "buckKill" ? "Buck" : "Doe"} · ${esc(e.hunter)}</b><span class="small muted">${fmtDate(ms(e.time))} ${A.fmtTime(ms(e.time))}</span></div>
          ${ant ? `<p>${esc(ant)}</p>` : ""}<p class="small muted">${esc([e.lease, cc.moonPhase, cc.sun, cc.temp, cc.pressTrend && cc.pressTrend.toLowerCase(), cc.windDir && cc.windDir.toLowerCase()].filter(Boolean).join(" · "))}</p></div>`;
      });
    }
    return h;
  }
  function pct(l) { const p = Math.round((l - 1) * 100); return (p >= 0 ? "+" : "") + p + "% vs avg"; }
  function bar(name, val, frac, hi, meta) {
    return `<div class="bar"><span class="name">${esc(name)}</span><span class="val">${esc(val)}</span>
      <div class="track"><div class="fill ${hi ? "hi" : ""}" style="width:${Math.max(2, Math.round(frac * 100))}%"></div></div>
      <span class="meta">${esc(meta)}</span></div>`;
  }

  // ---------- planner ----------
  function vPlanner() {
    const data = combined(), st = AN.analyze(data, {});
    const ls = allLeases().filter((l) => l.lat != null);
    const p = U.plan;
    const lease = ls.find((l) => l.name === p.lease) || ls[0];
    const tab = (val, label) => `<button class="${p.range === val ? "sel" : ""}" data-act="range" data-val="${val}">${label}</button>`;
    let h = `<div class="topbar"><button class="link" data-act="go" data-v="home">‹ Home</button></div>
      <h1>Best days</h1>
      <div class="tabs">${tab("week", "Next 7 days")}${tab("season", "Rest of season")}${tab("nextnov", "Next November")}</div>
      ${ls.length > 1 ? `<div class="tabs">${ls.map((l) => `<button class="${lease && l.name === lease.name ? "sel" : ""}" data-act="planLease" data-val="${esc(l.name)}">${esc(l.name)}</button>`).join("")}</div>` : ""}`;
    if (!lease) return h + `<div class="card"><p>Log a sit with GPS first. The planner needs a lease location for moon times and the forecast.</p></div>`;
    const today = A.localMidnight(Date.now()), days = [];
    if (p.range === "week") for (let i = 0; i < 7; i++) days.push(A.localMidnight(today + i * 86400000 + 3 * HOUR));
    else if (p.range === "season") { for (let t = today; A.ymd(t) <= "2027-02-28"; t = A.localMidnight(t + 27 * HOUR)) days.push(t); }
    else { const y = new Date().getMonth() >= 10 ? new Date().getFullYear() + 1 : new Date().getFullYear(); for (let d = 1; d <= 30; d++) days.push(new Date(y, 10, d).getTime()); }
    const fkey = lease.lat.toFixed(2) + "," + lease.lon.toFixed(2);
    const fc = p.range === "week" && U.forecast[fkey] ? U.forecast[fkey].days : null;
    if (p.range === "week" && !fc && !U.fcLoading) {
      U.fcLoading = true;
      fetchForecast(lease.lat, lease.lon).then(() => { U.fcLoading = false; U.fcError = null; render(); }).catch((e) => { U.fcLoading = false; U.fcError = "No forecast right now (no signal?)"; render(); });
    }
    const rows = AN.planDays(st, days, lease.lat, lease.lon, lease.zone, fc);
    const thin = st.totals.hours < 10;
    h += `<p class="small muted">${p.range === "week" ? (fc ? "Uses your group's results plus the NOAA forecast for " + esc(lease.name) + "." : U.fcError ? esc(U.fcError) + ". Using moon and calendar only." : "Loading NOAA forecast…")
      : "Weather can't be known this far out, so these use moon phase and week of season. Check Next 7 days the week of your hunt."}</p>`;
    if (thin) h += `<div class="card small">Your group has ${st.totals.hours.toFixed(1)} hours logged. Rankings firm up after a few dozen hours; until then most days will look close to average.</div>`;
    const list = p.range === "week" ? rows : rows.slice().sort((a, b) => b.score - a.score).slice(0, 12);
    list.forEach((r) => {
      const d = new Date(r.day), sc = Math.round((r.score - 1) * 100);
      const win = r.windows.filter((w) => w.lift == null || w.lift >= 1).map((w) => (w.kind === "overhead" ? "Moon overhead" : w.kind === "underfoot" ? "Moon underfoot" : w.kind === "rise" ? "Moonrise" : "Moonset") + " " + A.fmtTime(w.t));
      const why = r.reasons.slice(0, 3).map((x) => `<span class="${x.lift >= 1 ? "good" : "bad"}">${esc(x.text)}</span>`).join(" · ");
      h += `<div class="day"><div class="date"><span>${d.toLocaleDateString([], { weekday: "short" })}</span><b>${d.getDate()}</b><span>${d.toLocaleDateString([], { month: "short" })}</span></div>
        <div><div>${esc(r.phase)} · ${r.illum}% lit${r.season ? " · " + esc(r.season) : ""}</div><div class="why">${why || "Close to average on what's known"}</div>${win.length ? `<div class="why">${esc(win.join(" · "))}</div>` : ""}</div>
        <div class="score ${sc >= 10 ? "good" : sc <= -10 ? "bad" : ""}">${sc >= 0 ? "+" : ""}${sc}%</div></div>`;
    });
    h += `<p class="small muted">Score = expected deer per hour versus your group's average, combining every factor with enough hours behind it.</p>`;
    return h;
  }

  // ---------- settings ----------
  function vSettings() {
    const c = cfg();
    const mineSits = S.sits.filter((s) => s.hunter === S.hunter);
    return `<div class="topbar"><button class="link" data-act="go" data-v="home">‹ Home</button></div>
      <h1>Settings</h1>
      <div class="card"><b>Hunter name</b><input type="text" id="name" value="${esc(S.hunter)}" maxlength="30" style="margin-top:8px"><button style="margin-top:8px;width:100%" data-act="saveName">Save name</button></div>
      <div class="card"><b>Group sheet</b>
        <p class="small muted">${c.backendUrl ? "Connected" + (c.fromFile ? " (set in config.js)." : ".") : "Not connected. Your taps are saved on this phone only."}</p>
        ${c.fromFile ? "" : `<input type="text" id="burl" placeholder="Apps Script web app URL (…/exec)" value="${esc(S.config.backendUrl)}" style="margin:6px 0"><input type="text" id="bkey" placeholder="Team key" value="${esc(S.config.teamKey)}"><button style="margin-top:8px;width:100%" data-act="saveCfg">Save connection</button>`}
        ${c.backendUrl ? `<button class="primary" style="margin-top:8px;width:100%" data-act="syncNow">${syncing ? "Syncing…" : "Sync now"}</button>
          <p class="small muted">Last sync ${esc(ago(S.lastSync))}. ${unsyncedCount()} item(s) waiting.${S.lastSyncError ? " Last error: " + esc(S.lastSyncError) : ""}</p>` : ""}
      </div>
      <div class="card small muted"><b style="color:var(--text)">On this phone</b><p>${mineSits.length} sits · ${S.events.filter((e) => !e.deleted).length} taps. To fix a mistake after a sit is synced, delete its rows in the Google Sheet.</p>
        <button class="ghost" style="width:100%;margin-top:8px" data-act="eraseAsk">Erase this phone's DeerCast data</button></div>
      <p class="small muted center">DeerCast · moon and sun calculated on the phone · weather from NOAA National Weather Service · Arkansas 2026–27 dates from AGFC</p>`;
  }

  function render() {
    const v = { welcome: vWelcome, home: vHome, pickLease: vPickLease, newLease: vNewLease, stand: vStand, results: vResults, planner: vPlanner, settings: vSettings }[U.view] || vHome;
    let h = v();
    if (U.modal) {
      if (U.modal.type === "antler") h += mAntler();
      else if (U.modal.type === "doeKill") h += mConfirm("Doe down?", "Logs a harvested doe with the time, place and conditions.", "doeKillYes", "Log the doe");
      else if (U.modal.type === "end") { const s = openSit(); h += mConfirm("End this sit?", s ? dur(Date.now() - ms(s.start)) + " on stand · " + sitEvents(s.id).filter((e) => AN.DEER[e.type]).length + " deer logged" : "", "endYes", "End sit", "Keep hunting"); }
      else if (U.modal.type === "erase") h += mConfirm("Erase everything on this phone?", "Sits that already synced stay in the group sheet. Anything not synced is lost.", "eraseYes", "Erase");
    }
    $app.innerHTML = h;
  }

  // ---------------- actions ----------------
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]"); if (!el) return;
    const act = el.dataset.act;
    switch (act) {
      case "go": go(el.dataset.v); if (el.dataset.v === "results" && cfg().backendUrl && !U.busy) refresh(); break;
      case "saveName": {
        const n = (document.getElementById("name").value || "").trim();
        if (!n) return toast("Type your name first");
        S.hunter = n; save(); go("home"); break;
      }
      case "pick": startSit(allLeases()[+el.dataset.i]); break;
      case "zone": U.newLeaseName = document.getElementById("leaseName").value; U.newZone = el.dataset.z; render(); break;
      case "saveLease": {
        const name = (document.getElementById("leaseName").value || "").trim();
        if (!name) return toast("Name the lease first");
        const ex = allLeases().find((l) => l.name.toLowerCase() === name.toLowerCase());
        const lease = ex ? Object.assign({}, ex, U.newZone && U.newZone !== "?" ? { zone: U.newZone } : {}) : { name, zone: U.newZone && U.newZone !== "?" ? U.newZone : "" };
        U.newLeaseName = ""; U.newZone = ""; startSit(lease); break;
      }
      case "tap": addEvent(el.dataset.type); break;
      case "buckKill": U.modal = { type: "antler", antler: { step: 0 } }; render(); break;
      case "doeKill": U.modal = { type: "doeKill" }; render(); break;
      case "doeKillYes": U.modal = null; addEvent("doeKill"); break;
      case "antler": {
        const a = U.modal.antler; a[ANTLER_STEPS[a.step].key] = el.dataset.o;
        if (a.step < ANTLER_STEPS.length - 1) { a.step++; render(); }
        else { U.modal = null; addEvent("buckKill", { points: a.points, spread: a.spread, mass: a.mass, age: a.age }); }
        break;
      }
      case "antlerBack": U.modal.antler.step--; render(); break;
      case "antlerSkip": U.modal = null; addEvent("buckKill"); break;
      case "closeModal": U.modal = null; render(); break;
      case "undo": undo(); break;
      case "endAsk": U.modal = { type: "end" }; render(); break;
      case "endYes": endSit(); break;
      case "staleEnd": endSit(+el.dataset.t); break;
      case "dismissStale": { const s = openSit(); if (s) { s.staleOk = true; save(); } toast("Got it"); el.closest(".card").remove(); break; }
      case "filter": U.filters[el.dataset.g] = el.dataset.val; render(); break;
      case "refresh": refresh(); break;
      case "range": U.plan.range = el.dataset.val; render(); break;
      case "planLease": U.plan.lease = el.dataset.val; render(); break;
      case "saveCfg":
        S.config.backendUrl = document.getElementById("burl").value.trim(); S.config.teamKey = document.getElementById("bkey").value.trim(); save();
        toast("Saved. Testing…"); sync({ force: true, fetch: true }).then((ok) => toast(ok ? "Connected to group sheet" : "Couldn't connect: " + S.lastSyncError)); render(); break;
      case "syncNow": sync({ force: true, fetch: true }).then((ok) => toast(ok ? "Synced" : "Sync failed: " + S.lastSyncError)); render(); break;
      case "eraseAsk": U.modal = { type: "erase" }; render(); break;
      case "eraseYes": { const conf = S.config; localStorage.removeItem(KEY); S = load(); S.config = conf; save(); U.view = "welcome"; U.modal = null; render(); break; }
    }
  });
  async function refresh() {
    U.busy = true; render();
    try { await sync(); await fetchData(); } catch (e) { toast(/fetch|network|load failed/i.test(e.message || "") ? "No signal: showing saved data" : "Couldn't update: " + e.message); }
    U.busy = false; render();
  }

  // ---------------- boot ----------------
  if (openSit() && U.view === "home") { U.view = "stand"; startTimer(); }
  render();
  window.addEventListener("online", () => sync());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { sync(); if (U.view === "stand") startTimer(); } });
  setTimeout(() => sync(), 1500);
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  window.DeerCastDebug = { get S() { return S; }, render, sync };
})();
