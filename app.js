/* Widestrides web app */
(function () {
  "use strict";
  var E = window.WEngine;
  var CFG = window.WIDESTRIDES_CONFIG || {};
  var CONFIGURED = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf("YOUR-PROJECT") === -1
                   && CFG.SUPABASE_ANON_KEY && CFG.SUPABASE_ANON_KEY.indexOf("YOUR-ANON") === -1;
  var sb = CONFIGURED ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;

  var state = {
    mode: CONFIGURED ? "cloud" : "local",
    user: null, isMember: false, isAdmin: false,
    data: null, tab: "today", authMode: "signin",
    detail: null,            // {id, weekIndex}
    dwo: null,               // working clone of the open workout
    editing: false,
    repeatRefs: [], sets: 1,
    coach: null,             // {userId, email} when an admin is viewing a member
    coachData: null,         // that member's loaded profile data
  };
  var $app = document.getElementById("app");

  // ---------- persistence ----------
  function localGet() { try { return JSON.parse(localStorage.getItem("widestrides") || "null"); } catch (e) { return null; } }
  function localSet(d) { try { localStorage.setItem("widestrides", JSON.stringify(d)); } catch (e) {} }
  async function loadData() {
    if (state.mode === "local") { state.data = localGet() || {}; return; }
    var r = await sb.from("profiles").select("data").eq("user_id", state.user.id).maybeSingle();
    state.data = (r.data && r.data.data) || {};
  }
  async function saveData() {
    if (state.mode === "local") { localSet(state.data); return; }
    await sb.from("profiles").upsert({ user_id: state.user.id, data: state.data, updated_at: new Date().toISOString() });
  }

  // ---------- helpers ----------
  function h(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function rid(p) { return p + Math.random().toString(36).slice(2, 9); }
  function isoDate(d) { var x = new Date(d); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); }
  function currentKind(w) { return w.kind || (w.type === "easy" ? "easy" : (w.type === "longRun" ? "long" : "")); }
  function ul() { return E.unitLabel(); }
  // pace per km from an actual (metres, seconds) pair — fmtPace then shows it in the display unit
  function actualPaceKm(w) { return w.actualSeconds / (w.actualMeters / 1000); }
  function downloadFile(name, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function icsDate(iso) { var d = new Date(iso); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0"); }
  // Three separate h / m / s boxes — easier than typing "h:mm:ss".
  function hmsInputs(idH, idM, idS, totalSec) {
    var t = totalSec > 0 ? Math.round(totalSec) : 0;
    var hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    var box = 'inputmode="numeric" style="flex:1;min-width:0;text-align:center"';
    return '<div class="row" style="gap:6px">' +
      '<input id="' + idH + '" ' + box + ' placeholder="h" value="' + (hh || "") + '" /><span class="muted">:</span>' +
      '<input id="' + idM + '" ' + box + ' placeholder="min" value="' + (mm || "") + '" /><span class="muted">:</span>' +
      '<input id="' + idS + '" ' + box + ' placeholder="sec" value="' + (ss || "") + '" /></div>';
  }
  function readHMS(idH, idM, idS, root) {
    var r = root || document;
    var g = function (id) { var e = r.querySelector("#" + id); return e ? (parseInt(e.value, 10) || 0) : 0; };
    return g(idH) * 3600 + g(idM) * 60 + g(idS);
  }
  function setHMS(idH, idM, idS, sec) {
    var t = Math.max(0, Math.round(sec)), hh = Math.floor(t / 3600), mm = Math.floor((t % 3600) / 60), ss = t % 60;
    var g = function (id, v) { var e = document.getElementById(id); if (e) e.value = v; };
    g(idH, hh || ""); g(idM, mm); g(idS, ss);
  }
  // 2-box min:sec (for pace)
  function msInputs(idM, idS, sec) {
    var t = sec > 0 ? Math.round(sec) : 0, m = Math.floor(t / 60), s = t % 60;
    var box = 'inputmode="numeric" style="flex:1;min-width:0;text-align:center"';
    return '<div class="row" style="gap:6px"><input id="' + idM + '" ' + box + ' placeholder="min" value="' + (m || "") + '" /><span class="muted">:</span><input id="' + idS + '" ' + box + ' placeholder="sec" value="' + (s || "") + '" /></div>';
  }
  function readMS(idM, idS) { var g = function (id) { var e = document.getElementById(id); return e ? (parseInt(e.value, 10) || 0) : 0; }; return g(idM) * 60 + g(idS); }
  function setMS(idM, idS, sec) { var t = Math.max(0, Math.round(sec)), m = Math.floor(t / 60), s = t % 60; var g = function (id, v) { var e = document.getElementById(id); if (e) e.value = v; }; g(idM, m); g(idS, s); }
  function buildICS(plan, name) {
    var L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Widestrides//EN", "CALSCALE:GREGORIAN"];
    (plan.weeks || []).forEach(function (wk) {
      (wk.workouts || []).forEach(function (w) {
        var start = icsDate(w.dateISO), end = icsDate(new Date(new Date(w.dateISO).getTime() + 86400000));
        var summary = "🏃 " + (w.title || "Run");
        var desc = (w.steps && w.steps.length ? E.summarizeSteps(w.steps) : (w.detail || "")).replace(/\n/g, " ").replace(/,/g, "\\,");
        L.push("BEGIN:VEVENT", "UID:" + (w.id || rid("w-")) + "@widestrides", "DTSTART;VALUE=DATE:" + start, "DTEND;VALUE=DATE:" + end,
          "SUMMARY:" + summary.replace(/,/g, "\\,"), "DESCRIPTION:" + desc, "END:VEVENT");
      });
    });
    L.push("END:VCALENDAR");
    return L.join("\r\n");
  }
  function parsePace(s) { var m = /^(\d+):(\d{1,2})$/.exec((s || "").trim()); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
  function parseTime(s) {
    s = (s || "").trim(); if (!s) return NaN; var p = s.split(":").map(Number);
    if (p.some(isNaN)) return NaN;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    return p[0];
  }
  var BADGE = { longRun: ["Long", "var(--long)"], quality: ["Quality", "var(--quality)"], easy: ["Easy", "var(--easy)"], race: ["Race", "var(--danger)"], test: ["Test", "var(--accent)"] };
  var DOT = { regeneration: "var(--easy)", enduranceEasy: "var(--easy)", enduranceSteady: "var(--accent)", threshold: "var(--quality)", extensiveInterval: "var(--danger)" };

  // give every workout + step a stable id (backfills old saved plans)
  function ensureIds(plan) {
    var changed = false;
    (plan.weeks || []).forEach(function (wk) {
      (wk.workouts || []).forEach(function (w) {
        if (!w.id) { w.id = rid("w-"); changed = true; }
        (w.steps || []).forEach(function (s) { if (!s.id) { s.id = rid("s-"); changed = true; } });
      });
    });
    return changed;
  }
  // the profile currently being viewed/edited — the signed-in user, or (in
  // coach mode) the member an admin has opened.
  function activeData() { return state.coach ? state.coachData : state.data; }
  async function saveActive() {
    if (state.coach) { await sb.from("profiles").update({ data: state.coachData, updated_at: new Date().toISOString() }).eq("user_id", state.coach.userId); }
    else { await saveData(); }
  }

  function findWorkout(id) {
    var p = activeData().plan; if (!p) return null;
    for (var i = 0; i < p.weeks.length; i++) {
      var w = p.weeks[i].workouts.find(function (x) { return x.id === id; });
      if (w) return { w: w, weekIndex: p.weeks[i].index };
    }
    return null;
  }

  // ============================================================ render root
  async function render() {
    if (state.mode === "cloud" && !state.user) return renderAuth();
    if (state.mode === "cloud" && !state.isMember) return renderInvite();
    await ensureData();
    renderMain();
  }
  var _loaded = false;
  async function ensureData() {
    if (_loaded) return;
    await loadData(); _loaded = true;
    var d = state.data, dirty = false;
    // migrate a single goal → races[]
    if (d.goal && !d.races) { d.races = [Object.assign({ id: rid("r-") }, d.goal)]; dirty = true; }
    if (!d.races) d.races = [];
    if (d.testMeters && !d.testHistory) { d.testHistory = [{ id: rid("t-"), meters: d.testMeters, minutes: d.testMinutes, dateISO: d.startISO || new Date().toISOString() }]; dirty = true; }
    if (d.plan && ensureIds(d.plan)) dirty = true;
    if (dirty) await saveData();
    E.setUnits(d.units || "km");
    applyTheme();
  }

  // active race = soonest still-future, else soonest overall
  function activeRace(races) {
    if (!races || !races.length) return null;
    var sorted = races.slice().sort(function (a, b) { return new Date(a.dateISO) - new Date(b.dateISO); });
    var now = Date.now();
    return sorted.find(function (r) { return new Date(r.dateISO).getTime() >= now; }) || sorted[0];
  }
  function sameDay(a, b) { var x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString(); }

  // rebuild the plan, preserving completed/RPE/notes by (day, type)
  function regeneratePreserving() {
    var old = state.data.plan;
    state.data.goal = activeRace(state.data.races);
    if (!(state.data.testMeters > 0)) { state.data.plan = null; return; }
    var np = E.generatePlan(state.data); ensureIds(np);
    if (old) {
      var prev = [];
      old.weeks.forEach(function (w) { w.workouts.forEach(function (x) { prev.push(x); }); });
      np.weeks.forEach(function (w) {
        w.workouts.forEach(function (x) {
          var m = prev.find(function (o) { return sameDay(o.dateISO, x.dateISO) && o.type === x.type; });
          if (m) { x.completed = m.completed; x.rpe = m.rpe; x.note = m.note; }
        });
      });
    }
    state.data.plan = np;
  }

  function applyTheme() {
    var t = (state.data && state.data.theme) || {};
    var root = document.documentElement.style;
    if (t.accent) root.setProperty("--accent", t.accent); else root.removeProperty("--accent");
  }

  // ============================================================ auth
  function renderAuth() {
    var signup = state.authMode === "signup";
    $app.innerHTML = "";
    $app.appendChild(h(
      '<div class="auth-wrap"><h1>Widestrides</h1>' +
      '<div class="tag">Running paces built around one honest number.</div>' +
      '<div class="card"><h2>' + (signup ? "Create account" : "Sign in") + '</h2>' +
        '<label class="field">Email</label><input id="em" type="email" autocomplete="email" />' +
        '<label class="field">Password</label><input id="pw" type="password" autocomplete="' + (signup ? "new-password" : "current-password") + '" />' +
        '<button class="btn" id="go">' + (signup ? "Sign up" : "Sign in") + '</button><div id="msg"></div>' +
        '<p class="small muted" style="margin-top:16px">' + (signup ? "Have an account? " : "New here? ") +
          '<a class="link" id="toggle">' + (signup ? "Sign in" : "Create one") + '</a></p>' +
      '</div></div>'));
    document.getElementById("toggle").onclick = function () { state.authMode = signup ? "signin" : "signup"; renderAuth(); };
    document.getElementById("go").onclick = doAuth;
    ["em", "pw"].forEach(function (id) { document.getElementById(id).addEventListener("keydown", function (e) { if (e.key === "Enter") doAuth(); }); });
  }
  async function doAuth() {
    var email = document.getElementById("em").value.trim(), pw = document.getElementById("pw").value;
    var msg = document.getElementById("msg"); msg.className = ""; msg.textContent = "Working…";
    var r = await (state.authMode === "signup" ? sb.auth.signUp({ email: email, password: pw }) : sb.auth.signInWithPassword({ email: email, password: pw }));
    if (r.error) { msg.className = "err"; msg.textContent = r.error.message; return; }
    if (state.authMode === "signup" && !r.data.session) { msg.className = "ok"; msg.textContent = "Check your email to confirm, then sign in."; return; }
    await boot();
  }

  // ============================================================ invite
  function renderInvite() {
    $app.innerHTML = "";
    $app.appendChild(h(
      '<div class="auth-wrap"><h1>One more step</h1>' +
      '<div class="tag">Widestrides is invite-only. Enter your code.</div>' +
      '<div class="card"><label class="field">Invite code</label><input id="code" placeholder="WS-XXXX-XXXX" />' +
      '<button class="btn" id="redeem">Unlock</button><div id="imsg"></div>' +
      '<p class="small muted" style="margin-top:16px"><a class="link" id="out">Sign out</a></p></div></div>'));
    document.getElementById("out").onclick = signOut;
    document.getElementById("redeem").onclick = async function () {
      var code = document.getElementById("code").value.trim(), m = document.getElementById("imsg");
      m.className = ""; m.textContent = "Checking…";
      var r = await sb.rpc("redeem_invite", { p_code: code });
      if (r.error) { m.className = "err"; m.textContent = r.error.message; return; }
      if (r.data === "ok") { await boot(); } else { m.className = "err"; m.textContent = "That code is invalid or already used."; }
    };
  }

  // ============================================================ main shell
  function renderMain() {
    var tabs = [["today", "Today"], ["plan", "Plan"], ["paces", "Paces"], ["progress", "Progress"], ["calc", "Calculator"], ["settings", "Settings"]];
    if (state.isAdmin) tabs.push(["admin", "Admin"]);
    if (state.mode === "cloud") tabs.push(["account", "Account"]);
    $app.innerHTML = "";
    var head = h('<header class="top appbar"><h1>Widestrides</h1></header>');
    if (state.mode === "cloud") { var who = h('<div class="who"></div>'); who.textContent = state.user.email; head.appendChild(who); }
    $app.appendChild(head);
    if (state.mode === "local") $app.appendChild(h('<div class="banner">Running locally — your plan is saved in this browser only. Add your Supabase keys in <code>config.js</code> to enable sign-in, invite codes and cloud save.</div>'));

    var nav = h('<nav class="tabs"></nav>');
    tabs.forEach(function (t) { var b = h('<button>' + t[1] + '</button>'); if (state.tab === t[0] && !state.coach) b.className = "active"; b.onclick = function () { state.coach = null; state.coachData = null; state.tab = t[0]; renderMain(); }; nav.appendChild(b); });
    $app.appendChild(nav);

    var body = h('<div id="body"></div>'); $app.appendChild(body);
    if (state.coach) { renderCoach(body); if (state.detail && state.dwo) $app.appendChild(buildSheet()); return; }
    if (state.tab === "today") renderToday(body);
    else if (state.tab === "plan") renderPlan(body);
    else if (state.tab === "paces") renderPaces(body);
    else if (state.tab === "progress") renderProgress(body);
    else if (state.tab === "calc") renderCalc(body);
    else if (state.tab === "settings") renderSettings(body);
    else if (state.tab === "admin") renderAdmin(body);
    else if (state.tab === "account") renderAccount(body);

    if (state.detail && state.dwo) $app.appendChild(buildSheet());
  }

  // ============================================================ setup
  function hasProfile() { var d = state.data; return d && d.testMeters > 0 && d.testMinutes > 0; }
  function renderSetup(body) {
    var d = state.data || {}, g = d.goal || {};
    body.appendChild(h('<div class="card"><h2>Set up your plan</h2>' +
      '<p class="muted small">Run one 30-min all-out test (15 min warm-up + 3–4 strides of 10 sec, 30 min hard, 10 min cool-down), then enter the distance you covered.</p>' +
      '<label class="field">Name (optional)</label><input id="f-name" value="' + esc(d.name || "") + '" />' +
      '<div class="grid2"><div><label class="field">Test distance (metres)</label><input id="f-m" type="number" inputmode="numeric" value="' + (d.testMeters || "") + '" placeholder="e.g. 9000" /></div>' +
      '<div><label class="field">Test length</label><select id="f-min"><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select></div></div>' +
      '<label class="field">Training days per week</label><select id="f-days"><option>3</option><option>4</option><option>5</option><option>6</option></select>' +
      '<div class="grid2"><div><label class="field">Current level</label><select id="f-level"><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></div>' +
      '<div><label class="field">Longest run lately (' + ul() + ', optional)</label><input id="f-long" type="number" inputmode="decimal" placeholder="e.g. 14" /></div></div>' +
      '<p class="muted small" style="margin-top:4px">Level scales the workout load; longest run sets where your long runs start (no more starting below what you already do).</p>' +
      '<h3 style="margin-top:20px">Goal race (optional)</h3>' +
      '<label class="field">Distance</label><select id="f-dist">' + raceOptions(g) + '</select>' +
      '<div class="grid2" id="custom-wrap" style="display:none"><div><label class="field">Custom metres</label><input id="f-cm" type="number" value="' + (g.meters || "") + '" /></div><div></div></div>' +
      '<label class="field">Race date</label><input id="f-date" type="date" value="' + (g.dateISO ? g.dateISO.slice(0, 10) : "") + '" />' +
      '<label class="field">Goal time (optional)</label>' + hmsInputs("g-h", "g-m", "g-s", g.goalTimeSec) +
      '<button class="btn" id="gen">Generate my plan</button><div id="gmsg"></div></div>'));
    if (d.testMinutes) document.getElementById("f-min").value = String(d.testMinutes);
    if (d.daysPerWeek) document.getElementById("f-days").value = String(d.daysPerWeek);
    if (d.level) document.getElementById("f-level").value = d.level;
    if (d.longestRunMeters > 0) document.getElementById("f-long").value = E.fromMeters(d.longestRunMeters).toFixed(2).replace(/\.?0+$/, "");
    var distSel = document.getElementById("f-dist");
    function sc() { document.getElementById("custom-wrap").style.display = distSel.value === "custom" ? "" : "none"; }
    distSel.onchange = sc; sc();
    document.getElementById("gen").onclick = async function () {
      var meters = parseFloat(document.getElementById("f-m").value), msg = document.getElementById("gmsg"); msg.className = "";
      if (!(meters >= 1000)) { msg.className = "err"; msg.textContent = "Enter a test distance of at least 1000 m."; return; }
      var minutes = parseFloat(document.getElementById("f-min").value), days = parseInt(document.getElementById("f-days").value, 10), goal = null;
      var dv = distSel.value, dateV = document.getElementById("f-date").value;
      if (dv) {
        var gm, title;
        if (dv === "custom") { gm = parseFloat(document.getElementById("f-cm").value); title = E.km(gm) + " km"; }
        else { var p = E.RACE_PRESETS.find(function (x) { return x.key === dv; }); gm = p.meters; title = p.title; }
        if (gm >= 1000) { var gt = readHMS("g-h", "g-m", "g-s"); goal = { meters: gm, title: title, dateISO: dateV ? new Date(dateV).toISOString() : null, goalTimeSec: gt > 0 ? gt : null }; }
      }
      var now = new Date().toISOString();
      var lvl = document.getElementById("f-level").value;
      var longKm = parseFloat(document.getElementById("f-long").value);
      state.data = Object.assign({}, state.data, { name: document.getElementById("f-name").value.trim(), testMeters: meters, testMinutes: minutes, daysPerWeek: days, level: lvl, longestRunMeters: longKm > 0 ? E.toMeters(longKm) : 0, startISO: now });
      state.data.races = goal ? [Object.assign({ id: rid("r-") }, goal)] : (state.data.races || []);
      state.data.goal = activeRace(state.data.races);
      state.data.testHistory = (state.data.testHistory || []).concat([{ id: rid("t-"), meters: meters, minutes: minutes, dateISO: now }]);
      state.data.plan = E.generatePlan(state.data); ensureIds(state.data.plan);
      await saveData(); renderMain();
    };
  }
  function raceOptions(g) {
    var o = '<option value="">No race — rolling base block</option>';
    E.RACE_PRESETS.forEach(function (p) { o += '<option value="' + p.key + '"' + (g && g.title === p.title ? " selected" : "") + '>' + p.title + ' · ' + E.km(p.meters) + ' km</option>'; });
    return o + '<option value="custom">Custom distance…</option>';
  }

  // ============================================================ today tab
  function renderToday(body) {
    if (!hasProfile() || !state.data.plan) { renderSetup(body); return; }
    var plan = state.data.plan, all = [];
    plan.weeks.forEach(function (wk) { wk.workouts.forEach(function (w) { all.push({ w: w, wkIndex: wk.index }); }); });
    var todayStr = new Date().toDateString();
    var todays = all.filter(function (x) { return new Date(x.w.dateISO).toDateString() === todayStr; });
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var next = all.filter(function (x) { return !x.w.completed && new Date(x.w.dateISO) >= now; }).sort(function (a, b) { return new Date(a.w.dateISO) - new Date(b.w.dateISO); })[0];

    var hi = state.data.name ? "Hi " + esc(state.data.name) + " 👋" : "Today 👋";
    body.appendChild(h('<header class="top" style="padding-bottom:4px"><h1>' + hi + '</h1></header>'));

    var pick = todays[0] || (next && next.w);
    if (todays.length) {
      body.appendChild(h('<p class="muted small" style="margin:0 0 10px">Today · ' + new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) + '</p>'));
      todays.forEach(function (x) { body.appendChild(todayCard(x.w, "TODAY")); });
    } else if (next) {
      body.appendChild(h('<p class="muted small" style="margin:0 0 10px">Nothing scheduled today. Next up:</p>'));
      body.appendChild(todayCard(next.w, dayLabel(next.w.dateISO)));
    } else {
      body.appendChild(h('<div class="card muted">All sessions done — nice work! 🎉</div>'));
    }

    // this-week progress
    var cwi = E.currentWeekIndex(plan);
    var wk = plan.weeks.find(function (x) { return x.index === cwi; });
    if (wk) {
      var done = wk.workouts.filter(function (w) { return w.completed || w.actualMeters > 0; }).length, tot = wk.workouts.length;
      var pct = tot ? Math.round(done / tot * 100) : 0;
      var pc = h('<div class="card"><div class="row spread"><b>This week (Week ' + cwi + ')</b><span class="muted small">' + done + '/' + tot + ' done</span></div>' +
        '<div style="height:10px;background:var(--line);border-radius:999px;overflow:hidden;margin-top:8px"><div style="height:100%;width:' + pct + '%;background:var(--accent)"></div></div></div>');
      var go = h('<a class="link small">See full progress →</a>'); go.onclick = function () { state.tab = "progress"; renderMain(); };
      pc.appendChild(go); body.appendChild(pc);
    }
  }
  function todayCard(w, tag) {
    var b = BADGE[w.type] || ["", "var(--muted)"];
    var card = h('<div class="card"><div class="wo-top" style="margin-bottom:6px"><span class="badge" style="background:' + b[1] + '">' + b[0] + '</span><b style="font-size:17px">' + esc(w.title) + '</b><span class="wo-day">' + tag + '</span></div>' +
      '<div class="muted" style="font-size:14px">' + esc(w.steps && w.steps.length ? E.summarizeSteps(w.steps) : w.detail) + '</div>' +
      (w.coachNote ? '<div class="note-line" style="color:var(--accent);margin-top:6px">🧑‍🏫 ' + esc(w.coachNote) + '</div>' : "") + '</div>');
    var open = h('<button class="btn" style="margin-top:12px">Open & log</button>'); open.onclick = function () { openDetail(w.id); };
    card.appendChild(open);
    return card;
  }

  // ============================================================ plan tab
  function renderPlan(body) {
    if (!hasProfile() || !state.data.plan) { renderSetup(body); return; }
    var plan = state.data.plan;
    var bar = h('<div class="row spread" style="margin-bottom:6px"><div class="muted small">' + (plan.goal ? "Goal: " + esc(plan.goal.title) : "Rolling base block") + ' · ' + plan.weeks.length + ' weeks</div></div>');
    var edit = h('<a class="link small">Edit setup</a>'); edit.onclick = function () { var b = document.getElementById("body"); b.innerHTML = ""; renderSetup(b); };
    bar.appendChild(edit); body.appendChild(bar);
    plan.weeks.forEach(function (wk) {
      body.appendChild(h('<div class="week-head"><span class="wnum">Week ' + wk.index + '</span><span class="phase">' + wk.phase + '</span><span class="muted small" style="margin-left:auto">' + weekRange(wk) + '</span></div>'));
      var box = h('<div class="wk"></div>');
      wk.workouts.forEach(function (w) {
        var b = BADGE[w.type] || ["", "var(--muted)"];
        var wo = h('<div class="wo"><div class="wo-top">' +
          '<span class="badge" style="background:' + b[1] + '">' + b[0] + '</span>' +
          '<span>' + (w.completed ? "✓ " : "") + esc(w.title) + '</span>' +
          (w.isCustomized ? '<span class="badge-edit"> ·edited</span>' : "") +
          '<span class="wo-day">' + dayLabel(w.dateISO) + '</span></div>' +
          '<div class="wo-detail">' + esc(w.steps && w.steps.length ? E.summarizeSteps(w.steps) : w.detail) + '</div>' +
          (w.actualMeters > 0 ? '<div class="note-line" style="color:var(--easy)">🏃 ' + E.fromMeters(w.actualMeters).toFixed(2).replace(/\.?0+$/, "") + ' ' + ul() + (w.actualSeconds > 0 ? ' · ' + E.fmtPace(actualPaceKm(w)) + '/' + ul() : "") + '</div>' : "") +
          (w.coachNote ? '<div class="note-line" style="color:var(--accent)">🧑‍🏫 ' + esc(w.coachNote) + '</div>' : "") +
          (w.note ? '<div class="note-line">📝 ' + esc(w.note) + '</div>' : "") + '</div>');
        wo.onclick = function () { openDetail(w.id); };
        box.appendChild(wo);
      });
      body.appendChild(box);
    });
  }

  // ============================================================ workout sheet
  function openDetail(id) {
    var f = findWorkout(id); if (!f) return;
    state.detail = { id: id, weekIndex: f.weekIndex };
    state.dwo = clone(f.w);
    if (state.dwo.completed == null) state.dwo.completed = false;
    if (state.dwo.note == null) state.dwo.note = "";
    state.editing = false;
    state.repeatRefs = (state.dwo.steps || []).filter(function (s) { return s.repeatCount > 1; });
    state.sets = state.repeatRefs.reduce(function (m, s) { return Math.max(m, s.repeatCount); }, 1);
    renderMain();
  }
  function closeDetail() { state.detail = null; state.dwo = null; state.editing = false; renderMain(); }

  function buildSheet() {
    var overlay = h('<div class="overlay"></div>');
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeDetail(); });
    var sheet = h('<div class="sheet"></div>');
    overlay.appendChild(sheet);
    drawSheet(sheet);
    return overlay;
  }

  function drawSheet(sheet) {
    var w = state.dwo;
    sheet.innerHTML = "";
    var head = h('<div class="sheet-head"><h2 style="margin:0">' + esc(w.title) + '</h2><button class="x">×</button></div>');
    head.querySelector(".x").onclick = closeDetail;
    sheet.appendChild(head);
    if (w.isCustomized) sheet.appendChild(h('<div class="muted small"><span class="badge-edit">edited</span></div>'));
    // move the session to another day within its week
    var wkForDate = activeData().plan ? activeData().plan.weeks.find(function (x) { return x.index === state.detail.weekIndex; }) : null;
    if (wkForDate && w.type !== "race") {
      var ws = new Date(wkForDate.startISO), we = new Date(ws); we.setDate(we.getDate() + 6);
      var dateRow = h('<div class="toggle-row"><span class="small">Date (within week)</span><input type="date" style="width:auto" /></div>');
      var di = dateRow.querySelector("input");
      di.min = isoDate(ws); di.max = isoDate(we); di.value = isoDate(new Date(w.dateISO));
      di.onchange = function () { if (di.value) { w.dateISO = new Date(di.value + "T12:00:00").toISOString(); drawSheet(sheet); } };
      sheet.appendChild(dateRow);
    } else {
      sheet.appendChild(h('<div class="muted small">' + dayLabel(w.dateISO) + '</div>'));
    }
    sheet.appendChild(h('<p style="margin:8px 0 0">' + esc(E.summarizeSteps(w.steps || []) || w.detail) + '</p>'));

    // ----- steps: view or edit -----
    if (w.steps && w.steps.length) {
      var sec = h('<div class="sec"></div>');
      var hd = h('<div class="row spread"><h4>Structured steps</h4></div>');
      var tog = h('<a class="link small">' + (state.editing ? "Done" : "Adjust") + '</a>');
      tog.onclick = function () {
        if (state.editing && w.isCustomizedPending) { w.isCustomized = true; }
        state.editing = !state.editing;
        if (!state.editing) { w.detail = E.summarizeSteps(w.steps); }
        drawSheet(sheet);
      };
      hd.appendChild(tog); sec.appendChild(hd);

      if (state.editing) {
        var typeRow = h('<div class="step-edit"><div class="grow"><div class="t">Session type</div><div class="s">swap the workout — paces stay from the VCR</div></div></div>');
        var tsel = h('<select style="width:auto;max-width:150px"></select>');
        E.SESSION_KINDS.forEach(function (o) { tsel.appendChild(h('<option value="' + o.k + '">' + o.t + '</option>')); });
        tsel.value = currentKind(w);
        tsel.onchange = function () { changeType(w, tsel.value); drawSheet(sheet); };
        typeRow.appendChild(tsel);
        sec.appendChild(typeRow);
        if (state.repeatRefs.length) {
          var srow = h('<div class="step-edit"><div class="grow"><div class="t">Sets (repeats)</div><div class="s">applies to every repeated block</div></div></div>');
          srow.appendChild(mkBtn("–", function () { setSets(state.sets - 1); drawSheet(sheet); }));
          srow.appendChild(h('<div class="mono" style="min-width:26px;text-align:center">' + state.sets + '</div>'));
          srow.appendChild(mkBtn("+", function () { setSets(state.sets + 1); drawSheet(sheet); }));
          sec.appendChild(srow);
        }
        w.steps.forEach(function (s, i) {
          var row = h('<div class="step-edit" style="flex-wrap:wrap"></div>');
          var pace = E.stepPaceText(s);
          var info = h('<div style="flex:1 1 110px;min-width:110px"><div class="t">' + (s.repeatCount > 1 ? s.repeatCount + "× " : "") + esc(s.label) + '</div>' + (pace ? '<div class="s">' + pace + ' /' + ul() + '</div>' : "") + '</div>');
          row.appendChild(info);
          var eb = 'inputmode="numeric" style="width:48px;text-align:center;flex:none"';
          if (s.durationType === "time") {
            var mm = Math.floor(s.durationValue / 60), ss = Math.round(s.durationValue % 60);
            var tw = h('<div class="row" style="gap:4px;flex:none"><input class="ed-min" ' + eb + ' value="' + mm + '" /><span class="muted">:</span><input class="ed-sec" ' + eb + ' value="' + String(ss).padStart(2, "0") + '" /></div>');
            var updT = function () { var m = parseInt(tw.querySelector(".ed-min").value, 10) || 0, se = parseInt(tw.querySelector(".ed-sec").value, 10) || 0; s.durationValue = Math.max(1, m * 60 + se); w.isCustomized = true; };
            tw.querySelector(".ed-min").oninput = updT; tw.querySelector(".ed-sec").oninput = updT;
            row.appendChild(tw);
          } else if (s.durationType === "distance") {
            var dw = h('<input class="ed-m" inputmode="numeric" style="width:74px;text-align:center;flex:none" value="' + Math.round(s.durationValue) + '" />');
            dw.oninput = function () { s.durationValue = Math.max(1, parseInt(dw.value, 10) || 0); w.isCustomized = true; };
            row.appendChild(dw); row.appendChild(h('<span class="muted" style="flex:none">m</span>'));
          }
          if (s.kind === "recovery" || s.kind === "rest") {
            var jt = mkBtn(E.recoveryIsJog(s) ? "jog" : "stop", function () { s.restIsJog = !E.recoveryIsJog(s); w.isCustomized = true; drawSheet(sheet); });
            jt.style.width = "auto"; jt.style.padding = "0 10px"; jt.style.fontSize = "13px"; row.appendChild(jt);
          }
          var rm = mkBtn("✕", function () { w.steps.splice(i, 1); w.isCustomized = true; drawSheet(sheet); }); rm.className = "stepbtn rm"; row.appendChild(rm);
          sec.appendChild(row);
        });
        // WU/CD toggles
        sec.appendChild(wcToggle(w, "warmup", "Warm-up", function () { drawSheet(sheet); }));
        sec.appendChild(wcToggle(w, "cooldown", "Cool-down", function () { drawSheet(sheet); }));
        var reset = h('<button class="btn secondary" style="margin-top:12px">Reset to original</button>');
        reset.onclick = function () { var o = findWorkout(w.id); if (o && o.w._orig) {} resetWorkout(w); state.repeatRefs = w.steps.filter(function (s) { return s.repeatCount > 1; }); state.sets = state.repeatRefs.reduce(function (m, s) { return Math.max(m, s.repeatCount); }, 1); drawSheet(sheet); };
        sec.appendChild(reset);
      } else {
        w.steps.forEach(function (s) {
          var sub = E.stepDurationText(s); if (E.isRecovery(s)) sub += " · " + (E.recoveryIsJog(s) ? "jog" : "standing rest");
          var pace = E.stepPaceText(s);
          sec.appendChild(h('<div class="step"><div><div>' + (s.repeatCount > 1 ? s.repeatCount + "× " : "") + esc(s.label) + '</div><div class="st-sub">' + sub + '</div></div>' + (pace ? '<div class="st-pace mono">' + pace + ' /' + ul() + '</div>' : "") + '</div>'));
        });
      }
      sheet.appendChild(sec);
    }

    var coach = !!state.coach;

    // ----- coach note -----
    if (coach) {
      var cn = h('<div class="sec"><h4>Coach note (the athlete sees this)</h4><textarea placeholder="Advice, tweaks, cues for this session…">' + esc(w.coachNote || "") + '</textarea></div>');
      cn.querySelector("textarea").oninput = function (e) { w.coachNote = e.target.value; };
      sheet.appendChild(cn);
    } else if (w.coachNote) {
      sheet.appendChild(h('<div class="sec"><h4>🧑‍🏫 Coach note</h4><div class="note-line" style="color:var(--accent)">' + esc(w.coachNote) + '</div></div>'));
    }

    // ----- log -----
    if (coach) {
      var ap = (w.actualMeters > 0) ? E.fromMeters(w.actualMeters).toFixed(2).replace(/\.?0+$/, "") + " " + ul() + (w.actualSeconds > 0 ? " in " + E.fmtHMS(w.actualSeconds) + " (" + E.fmtPace(actualPaceKm(w)) + "/" + ul() + ")" : "") : "";
      sheet.appendChild(h('<div class="sec"><h4>Athlete log</h4><div class="small muted">' +
        (w.completed || w.actualMeters > 0 ? "✓ Completed" : "Not completed yet") + (w.rpe ? " · RPE " + w.rpe + "/10" : "") + '</div>' +
        (ap ? '<div class="small" style="margin-top:4px">🏃 ' + ap + '</div>' : "") +
        (w.note ? '<div class="note-line">📝 ' + esc(w.note) + '</div>' : "") + '</div>'));
    } else {
      var log = h('<div class="sec"><h4>Log this session</h4></div>');
      var chk = h('<label class="chk"><input type="checkbox" ' + (w.completed ? "checked" : "") + ' /> Completed</label>');
      chk.querySelector("input").onchange = function (e) { w.completed = e.target.checked; };
      log.appendChild(chk);
      // actual run — typed by the athlete, feeds Progress accurately
      var act = h('<div style="margin-top:10px"><label class="field">Actual run — whole session incl. warm-up &amp; cool-down (optional)</label>' +
        '<label class="field" style="margin-top:2px">Total distance (' + ul() + ')</label><input id="act-km" inputmode="decimal" placeholder="e.g. 8.5" value="' + (w.actualMeters > 0 ? E.fromMeters(w.actualMeters).toFixed(2).replace(/\.?0+$/, "") : "") + '" />' +
        '<label class="field" style="margin-top:8px">Total time</label>' + hmsInputs("act-h", "act-m", "act-s", w.actualSeconds) +
        '<div class="small muted" id="act-pace" style="margin-top:6px"></div></div>');
      log.appendChild(act);
      var rpe = h('<div style="margin-top:10px"><div class="row spread"><span class="small">Effort (RPE)</span><span class="small mono" id="rpev">' + (w.rpe || "—") + ' / 10</span></div><input type="range" min="1" max="10" step="1" value="' + (w.rpe || 5) + '" /></div>');
      rpe.querySelector("input").oninput = function (e) { w.rpe = parseInt(e.target.value, 10); document.getElementById("rpev").textContent = w.rpe + " / 10"; };
      log.appendChild(rpe);
      var note = h('<div style="margin-top:10px"><label class="field">Notes</label><textarea placeholder="How did it feel? Weather, splits, niggles…">' + esc(w.note || "") + '</textarea></div>');
      note.querySelector("textarea").oninput = function (e) { w.note = e.target.value; };
      log.appendChild(note);
      sheet.appendChild(log);
      var km = log.querySelector("#act-km"), pv = log.querySelector("#act-pace");
      function syncActual() {
        var k = parseFloat(km.value), s = readHMS("act-h", "act-m", "act-s", log);
        w.actualMeters = k > 0 ? E.toMeters(k) : undefined;
        w.actualSeconds = s > 0 ? s : undefined;
        if (w.actualMeters && w.actualSeconds) { pv.textContent = "= " + E.fmtPace(actualPaceKm(w)) + " /" + ul(); if (!w.completed) { w.completed = true; chk.querySelector("input").checked = true; } }
        else pv.textContent = "";
      }
      km.oninput = syncActual;
      ["act-h", "act-m", "act-s"].forEach(function (id) { log.querySelector("#" + id).oninput = syncActual; });
      syncActual();
    }

    var save = h('<button class="btn" style="margin-top:18px">' + (coach ? "Save changes for athlete" : "Save") + '</button>');
    save.onclick = async function () { if (w.isCustomized) w.detail = E.summarizeSteps(w.steps); await commitWorkout(w); closeDetail(); };
    sheet.appendChild(save);
  }
  function mkBtn(txt, fn) { var b = h('<button class="stepbtn">' + txt + '</button>'); b.onclick = fn; return b; }
  function editSub(s) {
    var t = E.stepDurationText(s);
    var p = E.stepPaceText(s); if (p) t += " @ " + p + " /" + ul();
    return t;
  }
  function setSets(n) { n = Math.max(1, Math.min(30, n)); state.sets = n; state.repeatRefs.forEach(function (s) { s.repeatCount = n; }); state.dwo.isCustomized = true; }
  function wcToggle(w, kind, label, after) {
    var on = w.steps.some(function (s) { return s.kind === kind; });
    var row = h('<div class="toggle-row"><span class="small">' + label + '</span></div>');
    var btn = h('<button class="stepbtn" style="width:auto;padding:0 14px;font-size:13px">' + (on ? "On" : "Off") + '</button>');
    btn.onclick = function () {
      if (on) { w.steps = w.steps.filter(function (s) { return s.kind !== kind; }); }
      else if (kind === "warmup") { w.steps.unshift({ id: rid("s-"), kind: "warmup", label: "Warm-up easy + strides", durationType: "time", durationValue: 900, repeatCount: 1 }); }
      else { w.steps.push({ id: rid("s-"), kind: "cooldown", label: "Cool-down easy", durationType: "time", durationValue: 600, repeatCount: 1 }); }
      w.isCustomized = true; after();
    };
    row.appendChild(btn); return row;
  }
  function resetWorkout(w) {
    // regenerate just this workout's steps from the engine using current velocity + its kind
    var d = activeData();
    var v = E.velocityFromTest(d.testMeters, d.testMinutes);
    if (w.type === "quality" && w.kind) {
      var wk = (d.plan.weeks.find(function (x) { return x.index === state.detail.weekIndex; }) || {});
      var fresh = E.buildWorkoutOfKind(w.kind, wk.phase || "build", v, d.goal || null, w.plannedMeters, d.level);
      fresh.steps.forEach(function (s) { s.id = rid("s-"); });
      w.steps = fresh.steps; w.detail = fresh.detail; w.isCustomized = false;
    } else {
      w.isCustomized = false; // for long/easy just clear the flag
    }
  }
  // Swap a session for a completely different kind (interval → tempo → easy…),
  // paces regenerated from the athlete's VCR. Keeps date/id/logs/coach note.
  function changeType(w, kind) {
    var d = activeData();
    var v = E.velocityFromTest(d.testMeters, d.testMinutes);
    var wk = d.plan.weeks.find(function (x) { return x.index === state.detail.weekIndex; }) || {};
    var fresh = E.buildWorkoutOfKind(kind, wk.phase, v, d.goal || null, w.plannedMeters, d.level);
    fresh.steps.forEach(function (s) { s.id = rid("s-"); });
    w.type = fresh.type; w.title = fresh.title; w.zone = fresh.zone; w.kind = kind;
    w.steps = fresh.steps; w.detail = fresh.detail;
    w.plannedMeters = fresh.plannedMeters || E.estimateMeters(fresh.steps, v);
    w.isCustomized = true;
    state.repeatRefs = w.steps.filter(function (s) { return s.repeatCount > 1; });
    state.sets = state.repeatRefs.reduce(function (m, s) { return Math.max(m, s.repeatCount); }, 1);
  }

  async function commitWorkout(w) {
    var wk = activeData().plan.weeks.find(function (x) { return x.index === state.detail.weekIndex; });
    if (!wk) return;
    var idx = wk.workouts.findIndex(function (x) { return x.id === w.id; });
    if (idx >= 0) wk.workouts[idx] = w;
    wk.workouts.sort(function (a, b) { return new Date(a.dateISO) - new Date(b.dateISO); });
    await saveActive();
  }

  // ============================================================ paces tab
  function renderPaces(body) {
    if (!hasProfile()) { body.appendChild(h('<div class="card muted">Set up your test first (Plan tab).</div>')); return; }
    var v = E.velocityFromTest(state.data.testMeters, state.data.testMinutes);
    var card = h('<div class="card"><h2>Your training paces</h2><p class="muted small">Reference (100%) pace <b class="mono">' + E.fmtPace(E.referencePace(v)) + ' /' + ul() + '</b> · from ' + state.data.testMeters + ' m in ' + state.data.testMinutes + ' min</p></div>');
    E.allPrescriptions(v).forEach(function (rx) {
      card.appendChild(h('<div class="zone"><span class="dot" style="background:' + (DOT[rx.zone] || "var(--muted)") + '"></span><div><div class="z-title">' + rx.title + '</div>' + (rx.hr ? '<div class="z-hr">~' + rx.hr + ' bpm</div>' : "") + '</div><div class="z-pace mono">' + E.rangeText(rx) + '<div class="z-hr">/' + ul() + '</div></div></div>'));
    });
    body.appendChild(card);
  }

  // ============================================================ calculator tab
  function renderCalc(body) {
    body.appendChild(h('<div class="card"><h2>Distance · Time · Pace</h2><p class="muted small">Fill in any two, leave the third blank, press Calculate.</p>' +
      '<label class="field">Distance (' + ul() + ')</label><input id="c-d" inputmode="decimal" placeholder="10" />' +
      '<label class="field">Time</label>' + hmsInputs("ct-h", "ct-m", "ct-s", 0) +
      '<label class="field">Pace (/' + ul() + ')</label>' + msInputs("cp-m", "cp-s", 0) +
      '<button class="btn" id="calc">Calculate</button><div id="cout" class="small" style="margin-top:14px"></div></div>'));
    document.getElementById("calc").onclick = function () {
      var dv = parseFloat(document.getElementById("c-d").value), t = readHMS("ct-h", "ct-m", "ct-s"), pms = readMS("cp-m", "cp-s");
      var r = E.solveDTP({ distanceM: dv > 0 ? E.toMeters(dv) : undefined, timeSec: t > 0 ? t : undefined, paceSecPerKm: pms > 0 ? E.paceToPerKm(pms) : undefined });
      var out = document.getElementById("cout");
      if (!r) { out.className = "err"; out.textContent = "Enter at least two values."; return; }
      out.className = "";
      var dvo = E.fromMeters(r.distanceM).toFixed(2).replace(/\.?0+$/, "");
      document.getElementById("c-d").value = dvo;
      setHMS("ct-h", "ct-m", "ct-s", r.timeSec);
      setMS("cp-m", "cp-s", r.paceSecPerKm * (E.unitInfo().m / 1000));
      out.innerHTML = '<b>' + dvo + ' ' + ul() + '</b> in <b>' + E.fmtHMS(r.timeSec) + '</b> = <b>' + E.fmtPace(r.paceSecPerKm) + ' /' + ul() + '</b>';
    };
    var pred = h('<div class="card"><h2>Race predictions (Riegel)</h2><p class="muted small">From a recent race or hard effort — distance + time.</p>' +
      '<label class="field">From distance (' + ul() + ')</label><input id="r-d" inputmode="decimal" placeholder="10" />' +
      '<label class="field">In time</label>' + hmsInputs("pr-h", "pr-m", "pr-s", 0) +
      '<button class="btn" id="predict">Predict</button><div id="rout" style="margin-top:12px"></div></div>');
    body.appendChild(pred);
    document.getElementById("predict").onclick = function () {
      var dv = parseFloat(document.getElementById("r-d").value), t = readHMS("pr-h", "pr-m", "pr-s"), out = document.getElementById("rout");
      if (!(dv > 0) || !(t > 0)) { out.className = "err small"; out.textContent = "Enter distance and time."; return; }
      var d1 = E.toMeters(dv);
      out.className = ""; out.innerHTML = E.RACE_PRESETS.map(function (p) { var tt = E.riegelPredict(t, d1, p.meters); return '<div class="zone"><div class="z-title">' + p.title + '</div><div class="z-pace mono">' + E.fmtHMS(tt) + '<div class="z-hr">' + E.fmtPace(tt / (p.meters / 1000)) + ' /' + ul() + '</div></div></div>'; }).join("");
    };
    if (hasProfile()) { document.getElementById("r-d").value = E.fromMeters(state.data.testMeters).toFixed(2).replace(/\.?0+$/, ""); setHMS("pr-h", "pr-m", "pr-s", state.data.testMinutes * 60); }
  }

  // ============================================================ account tab
  function renderAccount(body) {
    body.appendChild(h('<div class="card"><h2>Account</h2><p class="muted small">Signed in as <b>' + esc(state.user.email) + '</b>' + (state.isAdmin ? ' · admin' : '') + '</p></div>'));
    var em = h('<div class="card"><h3>Change email</h3><label class="field">New email</label><input id="ne" type="email" /><button class="btn" id="be">Update email</button><div id="em-msg"></div></div>');
    body.appendChild(em);
    document.getElementById("be").onclick = async function () {
      var v = document.getElementById("ne").value.trim(), m = document.getElementById("em-msg"); m.className = ""; m.textContent = "Working…";
      var r = await sb.auth.updateUser({ email: v });
      if (r.error) { m.className = "err"; m.textContent = r.error.message; } else { m.className = "ok"; m.textContent = "Confirm the change from the link sent to your new email."; }
    };
    var pw = h('<div class="card"><h3>Change password</h3><label class="field">New password (min 6)</label><input id="np" type="password" /><button class="btn" id="bp">Update password</button><div id="pw-msg"></div></div>');
    body.appendChild(pw);
    document.getElementById("bp").onclick = async function () {
      var v = document.getElementById("np").value, m = document.getElementById("pw-msg"); m.className = "";
      if (v.length < 6) { m.className = "err"; m.textContent = "At least 6 characters."; return; }
      m.textContent = "Working…"; var r = await sb.auth.updateUser({ password: v });
      if (r.error) { m.className = "err"; m.textContent = r.error.message; } else { m.className = "ok"; m.textContent = "Password updated."; document.getElementById("np").value = ""; }
    };
    var so = h('<button class="btn danger">Sign out</button>'); so.onclick = signOut; body.appendChild(so);
  }

  // ============================================================ admin tab
  function renderAdmin(body) {
    body.appendChild(h('<div class="card"><h2>Coach dashboard</h2><p class="muted small">Everyone you coach at a glance — tap a row to open their plan.</p><div id="dash" class="muted small">Loading…</div></div>'));
    loadDashboard();
    body.appendChild(h('<div class="card"><h2>Invite codes</h2><p class="muted small">Generate a code and share it. Each works once.</p>' +
      '<div class="grid2"><div><label class="field">Note (who is it for?)</label><input id="a-note" placeholder="e.g. John from run club" /></div>' +
      '<div style="display:flex;align-items:flex-end"><button class="btn" id="a-gen" style="margin-top:0">Generate code</button></div></div>' +
      '<div id="a-msg"></div><div id="a-list" class="muted small" style="margin-top:14px">Loading…</div></div>'));
    document.getElementById("a-gen").onclick = async function () {
      var note = document.getElementById("a-note").value.trim(), code = "WS-" + rand4() + "-" + rand4();
      var r = await sb.from("invite_codes").insert({ code: code, note: note || null }), m = document.getElementById("a-msg");
      if (r.error) { m.className = "err"; m.textContent = r.error.message; return; }
      m.className = "ok"; m.textContent = "Created " + code; document.getElementById("a-note").value = ""; loadCodes();
    };
    loadCodes();

    body.appendChild(h('<div class="card"><h2>Members</h2><p class="muted small">Everyone who has unlocked the app. Toggle admin rights here.</p><div id="m-list" class="muted small">Loading…</div>' +
      '<p class="small muted" style="margin-top:12px">Need to edit raw data (plans, profiles)? Open your project in Supabase → <b>Table Editor</b> — you have full access there.</p></div>'));
    loadMembers();
  }
  async function loadCodes() {
    var box = document.getElementById("a-list"); var r = await sb.from("invite_codes").select("*").order("created_at", { ascending: false });
    if (r.error) { box.className = "err"; box.textContent = r.error.message; return; }
    if (!r.data.length) { box.textContent = "No codes yet."; return; }
    box.className = ""; box.innerHTML = '<table class="codes"><tr><th>Code</th><th>Note</th><th>Status</th><th></th></tr>' + r.data.map(function (c) {
      var st = c.disabled ? '<span class="pill off">disabled</span>' : (c.used_by ? '<span class="pill used">used</span>' : '<span class="pill free">available</span>');
      var act = (!c.disabled && !c.used_by) ? '<button class="mini" data-off="' + esc(c.code) + '">disable</button>' : "";
      return '<tr><td><code>' + esc(c.code) + '</code></td><td>' + esc(c.note || "") + '</td><td>' + st + '</td><td>' + act + '</td></tr>';
    }).join("") + '</table>';
    Array.prototype.forEach.call(box.querySelectorAll("[data-off]"), function (b) { b.onclick = async function () { await sb.from("invite_codes").update({ disabled: true }).eq("code", b.getAttribute("data-off")); loadCodes(); }; });
  }
  async function loadMembers() {
    var box = document.getElementById("m-list"); var r = await sb.from("members").select("*").order("created_at", { ascending: true });
    if (r.error) { box.className = "err"; box.textContent = r.error.message; return; }
    box.className = ""; box.innerHTML = '<table class="codes"><tr><th>Email</th><th>Joined</th><th>Role</th><th></th></tr>' + r.data.map(function (m) {
      var role = m.is_admin ? '<span class="pill used">admin</span>' : '<span class="pill free">member</span>';
      var me = m.user_id === state.user.id;
      var coachBtn = '<button class="mini" data-coach="' + m.user_id + '" data-email="' + esc(m.email || "") + '">plan ▸</button>';
      var adminBtn = me ? '<span class="muted small">you</span>' : '<button class="mini" data-uid="' + m.user_id + '" data-admin="' + (m.is_admin ? 1 : 0) + '">' + (m.is_admin ? "remove admin" : "make admin") + '</button>';
      return '<tr><td>' + esc(m.email || "") + '</td><td>' + new Date(m.created_at).toLocaleDateString() + '</td><td>' + role + '</td><td style="white-space:nowrap">' + coachBtn + ' ' + adminBtn + '</td></tr>';
    }).join("") + '</table>';
    Array.prototype.forEach.call(box.querySelectorAll("[data-uid]"), function (b) {
      b.onclick = async function () { await sb.from("members").update({ is_admin: b.getAttribute("data-admin") !== "1" }).eq("user_id", b.getAttribute("data-uid")); loadMembers(); };
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-coach]"), function (b) {
      b.onclick = function () { openCoach(b.getAttribute("data-coach"), b.getAttribute("data-email")); };
    });
  }
  function rand4() { var s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", o = ""; for (var i = 0; i < 4; i++) o += s[Math.floor(Math.random() * s.length)]; return o; }
  async function loadDashboard() {
    var box = document.getElementById("dash");
    var mem = await sb.from("members").select("user_id,email");
    if (mem.error) { box.className = "err"; box.textContent = mem.error.message; return; }
    var prof = await sb.from("profiles").select("user_id,data");
    var pmap = {}; (prof.data || []).forEach(function (p) { pmap[p.user_id] = p.data || {}; });
    var rows = (mem.data || []).map(function (m) {
      var d = pmap[m.user_id] || {}, r = { email: m.email, uid: m.user_id, order: 3, status: "no setup", cls: "off", sub: "" };
      if (d.testMeters && d.plan) {
        var cwi = E.currentWeekIndex(d.plan), wk = d.plan.weeks.find(function (x) { return x.index === cwi; });
        var done = wk ? wk.workouts.filter(function (w) { return w.completed || w.actualMeters > 0; }).length : 0, tot = wk ? wk.workouts.length : 0;
        r.sub = "Wk " + cwi + " · " + done + "/" + tot + " done" + (d.goal ? " · " + d.goal.title : "");
        if (d.goal) { var f = E.forecast(d.plan, d, cwi); if (f) { r.status = f.isOnTrack ? "on track" : "behind"; r.cls = f.isOnTrack ? "free" : "used"; r.order = f.isOnTrack ? 2 : 0; } }
        else { r.status = "no goal"; r.order = 1; }
      } else if (d.testMeters) { r.sub = "No plan yet"; r.order = 1; }
      return r;
    }).sort(function (a, b) { return a.order - b.order; });
    box.className = "";
    if (!rows.length) { box.textContent = "No members yet."; return; }
    box.innerHTML = '<table class="codes"><tr><th>Athlete</th><th>Status</th></tr>' + rows.map(function (r) {
      return '<tr data-uid="' + r.uid + '" data-email="' + esc(r.email || "") + '" style="cursor:pointer"><td>' + esc(r.email || "") + '<div class="muted small">' + esc(r.sub) + '</div></td><td><span class="pill ' + r.cls + '">' + r.status + '</span></td></tr>';
    }).join("") + '</table>';
    Array.prototype.forEach.call(box.querySelectorAll("[data-uid]"), function (tr) { tr.onclick = function () { openCoach(tr.getAttribute("data-uid"), tr.getAttribute("data-email")); }; });
  }

  // ============================================================ progress tab
  function renderProgress(body) {
    if (!hasProfile() || !state.data.plan) { body.appendChild(h('<div class="card muted">Set up your plan first (Plan tab).</div>')); return; }
    var plan = state.data.plan, v = E.velocityFromTest(state.data.testMeters, state.data.testMinutes);
    var cwi = E.currentWeekIndex(plan);
    var f = state.data.goal ? E.forecast(plan, state.data, cwi) : null;

    if (f) {
      var col = f.isOnTrack ? "var(--easy)" : "var(--quality)";
      var card = h('<div class="card"><h2>Progress</h2>' +
        '<div style="font-weight:700;color:' + col + ';font-size:16px;margin:2px 0 10px">' + esc(f.statusText) + '</div>' +
        '<div class="grid3">' +
          stat("Goal", E.fmtHMS(f.goalSeconds)) +
          stat("Projected finish", E.fmtHMS(f.predictedFinishSeconds)) +
          stat("Sessions done", Math.round(f.completionToDate * 100) + "%") +
        '</div></div>');
      card.appendChild(forecastChart(f));
      card.appendChild(h('<p class="muted small" style="margin-top:8px">Estimate from Riegel + your logged completion. Goal line = if you complete every session; projected = your actual pace so far, projected forward.</p>'));
      body.appendChild(card);
    } else {
      body.appendChild(h('<div class="card muted small">Add a goal race (Settings) with a target time to see your goal-vs-projected forecast. Below is your week-by-week review.</div>'));
    }

    // ---- actual vs target pace trend ----
    var trend = plan.weeks.filter(function (w) { return w.index <= cwi; }).map(function (w) { return E.weeklyReview(w, v); }).filter(function (r) { return r.averagePace > 0; });
    if (trend.length >= 1) {
      var target = (state.data.goal && state.data.goal.goalTimeSec) ? state.data.goal.goalTimeSec / (state.data.goal.meters / 1000) : E.prescription("threshold", v).pace;
      var pc = h('<div class="card"><h2>Actual pace trend</h2><p class="muted small">Your average logged pace each week vs your target.</p></div>');
      pc.appendChild(paceChart(trend, target));
      pc.appendChild(h('<div class="row small muted" style="gap:16px;margin-top:4px"><span><span style="color:var(--accent)">■</span> Actual</span><span>┈ Target ' + E.fmtPace(target) + '/' + ul() + '</span><span style="margin-left:auto">↑ faster</span></div>'));
      body.appendChild(pc);
    }

    // ---- reviews ----
    var rev = h('<div class="card"><h2>Weekly review</h2><label class="field">Week</label></div>');
    var sel = h('<select></select>');
    plan.weeks.forEach(function (w) { sel.appendChild(h('<option value="' + w.index + '">Week ' + w.index + ' · ' + w.phase + '</option>')); });
    sel.value = String(cwi);
    rev.appendChild(sel);
    var out = h('<div id="wr-out" style="margin-top:12px"></div>'); rev.appendChild(out);
    function drawWR() {
      var wk = plan.weeks.find(function (x) { return x.index === parseInt(sel.value, 10); });
      var r = E.weeklyReview(wk, v);
      out.innerHTML = '<div class="grid3">' + stat("Completed", r.completedCount + "/" + r.totalCount) + stat("Volume", Math.round(E.fromMeters(r.actualMeters)) + " " + ul()) + stat("Avg RPE", r.averageRPE ? r.averageRPE.toFixed(1) : "—") + '</div>' +
        (r.averagePace ? '<div class="muted small" style="margin-top:8px">Avg actual pace <b class="mono">' + E.fmtPace(r.averagePace) + ' /' + ul() + '</b></div>' : "") +
        (r.notes.length ? '<div class="sec"><h4>Notes</h4>' + r.notes.map(function (n) { return '<div class="note-line">📝 ' + esc(n) + '</div>'; }).join("") + '</div>' : "");
      var btn = h('<a class="btn secondary" style="display:block;text-align:center;text-decoration:none;margin-top:12px">Review this week with Claude ↗</a>');
      btn.href = E.claudeUrl(E.weeklyReviewPrompt(wk, v)); btn.target = "_blank";
      out.appendChild(btn);
    }
    sel.onchange = drawWR; drawWR();
    body.appendChild(rev);

    // ---- block review ----
    var block = h('<div class="card"><h2>Block review</h2><p class="muted small">Review several weeks together.</p><label class="field">How many recent weeks</label></div>');
    var nsel = h('<select><option>2</option><option>3</option><option>4</option><option>6</option></select>'); nsel.value = "3";
    block.appendChild(nsel);
    var bout = h('<div id="br-out" style="margin-top:12px"></div>'); block.appendChild(bout);
    function drawBR() {
      var n = parseInt(nsel.value, 10);
      var upto = plan.weeks.filter(function (w) { return w.index <= cwi; });
      var weeks = (upto.length ? upto : plan.weeks).slice(-n);
      var b = E.blockReview(weeks, v);
      bout.innerHTML = '<div class="grid3">' + stat("Weeks", "W" + weeks[0].index + "–" + weeks[weeks.length - 1].index) + stat("Completion", Math.round(b.completionRate * 100) + "%") + stat("Volume", Math.round(E.fromMeters(b.totalActualMeters)) + " " + ul()) + '</div>';
      var btn = h('<a class="btn secondary" style="display:block;text-align:center;text-decoration:none;margin-top:12px">Review this block with Claude ↗</a>');
      btn.href = E.claudeUrl(E.blockReviewPrompt(weeks, v)); btn.target = "_blank"; bout.appendChild(btn);
    }
    nsel.onchange = drawBR; drawBR();
    body.appendChild(block);

    var plc = h('<a class="btn" style="display:block;text-align:center;text-decoration:none">Plan with Claude (free) ↗</a>');
    plc.href = E.claudeUrl(E.planningPrompt(state.data, plan)); plc.target = "_blank";
    body.appendChild(plc);
  }
  function stat(label, val) { return '<div><div class="muted small">' + label + '</div><div style="font-size:20px;font-weight:700" class="mono">' + val + '</div></div>'; }
  function paceChart(rows, targetKm) {
    var W = 320, H = 120, pad = 8;
    var vals = rows.map(function (r) { return r.averagePace; }).concat([targetKm]);
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), rng = (max - min) || 1;
    var n = rows.length;
    var X = function (i) { return pad + (W - 2 * pad) * (n <= 1 ? 0.5 : i / (n - 1)); };
    var Y = function (s) { return pad + (H - 2 * pad) * ((s - min) / rng); };  // faster (smaller) = higher
    var d = rows.map(function (r, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(r.averagePace).toFixed(1); }).join(" ");
    var dots = rows.map(function (r, i) { return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(r.averagePace).toFixed(1) + '" r="3" fill="var(--accent)"/>'; }).join("");
    var ty = Y(targetKm).toFixed(1);
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="margin-top:8px;display:block">' +
      '<line x1="0" y1="' + ty + '" x2="' + W + '" y2="' + ty + '" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="5 4"/>' +
      '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2.5"/>' + dots + '</svg>';
    return h('<div>' + svg + '</div>');
  }
  function forecastChart(f) {
    var W = 320, H = 120, pad = 6;
    var pts = f.points, n = pts.length;
    var all = pts.map(function (p) { return p.goalSeconds; }).concat(pts.map(function (p) { return p.projectedSeconds; })).concat([f.goalSeconds]);
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all), rng = (max - min) || 1;
    var X = function (i) { return pad + (W - 2 * pad) * (n <= 1 ? 0.5 : i / (n - 1)); };
    var Y = function (s) { return pad + (H - 2 * pad) * (1 - (s - min) / rng); };  // faster (smaller) = higher
    var line = function (key, color, dash) {
      var d = pts.map(function (p, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p[key]).toFixed(1); }).join(" ");
      return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.5"' + (dash ? ' stroke-dasharray="5 4"' : "") + '/>';
    };
    var cx = X(pts.findIndex(function (p) { return p.week === f.currentWeek; }));
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="margin-top:12px;display:block">' +
      '<line x1="' + cx + '" y1="0" x2="' + cx + '" y2="' + H + '" stroke="var(--line)" stroke-width="1"/>' +
      line("goalSeconds", "var(--muted)", true) + line("projectedSeconds", "var(--accent)", false) +
      '</svg>' +
      '<div class="row small muted" style="gap:16px;margin-top:4px"><span>— <span style="color:var(--accent)">■</span> Projected</span><span>┈ Goal trajectory</span><span style="margin-left:auto">↑ faster</span></div>';
    return h('<div>' + svg + '</div>');
  }

  // ============================================================ settings tab
  function renderSettings(body) {
    // appearance
    var d = state.data; d.theme = d.theme || {};
    var isMi = (d.units === "mi");
    var ap = h('<div class="card"><h2>Appearance &amp; units</h2>' +
      '<div class="toggle-row"><span>Units</span><span><button class="mini" id="u-km"' + (isMi ? "" : ' style="background:var(--accent);color:#fff"') + '>km</button> <button class="mini" id="u-mi"' + (isMi ? ' style="background:var(--accent);color:#fff"' : "") + '>mi</button></span></div>' +
      '<div class="toggle-row"><span>Accent colour</span><input id="s-accent" type="color" style="width:52px;height:34px;padding:2px;border:1px solid var(--line);border-radius:8px" value="' + (d.theme.accent || "#2f6df6") + '" /></div>' +
      '<p class="muted small">Distances &amp; paces switch between km and miles across the whole app.</p>' +
      '<button class="btn secondary" id="s-theme-reset">Reset colour</button></div>');
    body.appendChild(ap);
    document.getElementById("s-accent").oninput = function (e) { d.theme.accent = e.target.value; applyTheme(); saveData(); };
    document.getElementById("s-theme-reset").onclick = function () { d.theme = {}; applyTheme(); saveData(); renderMain(); };
    document.getElementById("u-km").onclick = function () { d.units = "km"; E.setUnits("km"); saveData(); renderMain(); };
    document.getElementById("u-mi").onclick = function () { d.units = "mi"; E.setUnits("mi"); saveData(); renderMain(); };

    // fitness test / retest
    if (hasProfile()) {
      var t = h('<div class="card"><h2>Fitness test (VCR)</h2>' +
        '<p class="muted small">Active: <b>' + d.testMeters + ' m in ' + d.testMinutes + ' min</b> → ref pace ' + E.fmtPace(E.referencePace(E.velocityFromTest(d.testMeters, d.testMinutes))) + '/' + ul() + '</p>' +
        '<h3 style="margin-top:8px">Re-test</h3>' +
        '<div class="grid2"><div><label class="field">New distance (m)</label><input id="rt-m" type="number" inputmode="numeric" placeholder="e.g. 9300" /></div>' +
        '<div><label class="field">Length</label><select id="rt-min"><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select></div></div>' +
        '<button class="btn" id="rt-use">Use as new reference (rebuild paces)</button>' +
        '<button class="btn secondary" id="rt-keep">Just record (keep current)</button><div id="rt-msg"></div>' +
        '<div id="rt-hist" class="sec"></div></div>');
      body.appendChild(t);
      document.getElementById("rt-min").value = String(d.testMinutes);
      function retest(activate) {
        var m = parseFloat(document.getElementById("rt-m").value), mn = parseFloat(document.getElementById("rt-min").value), msg = document.getElementById("rt-msg"); msg.className = "";
        if (!(m >= 1000)) { msg.className = "err"; msg.textContent = "Enter at least 1000 m."; return; }
        d.testHistory = (d.testHistory || []).concat([{ id: rid("t-"), meters: m, minutes: mn, dateISO: new Date().toISOString() }]);
        if (activate) { d.testMeters = m; d.testMinutes = mn; regeneratePreserving(); }
        saveData(); renderMain();
      }
      document.getElementById("rt-use").onclick = function () { retest(true); };
      document.getElementById("rt-keep").onclick = function () { retest(false); };
      var hist = document.getElementById("rt-hist");
      var rows = (d.testHistory || []).slice().reverse();
      hist.innerHTML = '<h4>History</h4>' + (rows.length ? rows.map(function (r) {
        var active = r.meters === d.testMeters && r.minutes === d.testMinutes;
        return '<div class="toggle-row"><span class="small">' + new Date(r.dateISO).toLocaleDateString() + ' · ' + r.meters + ' m / ' + r.minutes + ' min · ' + E.fmtPace(E.referencePace(E.velocityFromTest(r.meters, r.minutes))) + '/' + ul() + '</span>' + (active ? '<span class="pill used">active</span>' : '<button class="stepbtn" style="width:auto;padding:0 10px;font-size:13px" data-uid="' + r.id + '">Use</button>') + '</div>';
      }).join("") : '<span class="muted small">No history yet.</span>');
      Array.prototype.forEach.call(hist.querySelectorAll("[data-uid]"), function (b) {
        b.onclick = function () { var r = d.testHistory.find(function (x) { return x.id === b.getAttribute("data-uid"); }); if (r) { d.testMeters = r.meters; d.testMinutes = r.minutes; regeneratePreserving(); saveData(); renderMain(); } };
      });
    }

    // races
    var rc = h('<div class="card"><h2>Races</h2><p class="muted small">The soonest upcoming race drives your plan.</p><div id="rc-list"></div>' +
      '<h3 style="margin-top:10px">Add a race</h3>' +
      '<label class="field">Distance</label><select id="rc-dist">' + raceOptions({}) + '</select>' +
      '<div class="grid2" id="rc-cw" style="display:none"><div><label class="field">Custom m</label><input id="rc-cm" type="number" /></div><div></div></div>' +
      '<label class="field">Date</label><input id="rc-date" type="date" />' +
      '<label class="field">Goal time (optional)</label>' + hmsInputs("rc-h", "rc-m", "rc-s", 0) +
      '<button class="btn" id="rc-add">Add race</button><div id="rc-msg"></div></div>');
    body.appendChild(rc);
    var rcd = document.getElementById("rc-dist");
    rcd.onchange = function () { document.getElementById("rc-cw").style.display = rcd.value === "custom" ? "" : "none"; };
    drawRaces();
    function drawRaces() {
      var list = document.getElementById("rc-list"), races = (d.races || []).slice().sort(function (a, b) { return new Date(a.dateISO) - new Date(b.dateISO); });
      var act = activeRace(d.races);
      list.innerHTML = races.length ? races.map(function (r) {
        return '<div class="toggle-row"><span class="small">' + esc(r.title) + ' · ' + (r.dateISO ? new Date(r.dateISO).toLocaleDateString() : "no date") + (r.goalTimeSec ? ' · ' + E.fmtHMS(r.goalTimeSec) : "") + (act && act.id === r.id ? ' <span class="pill used">active</span>' : "") + '</span><button class="stepbtn rm" style="width:auto;padding:0 10px;font-size:13px" data-rid="' + r.id + '">remove</button></div>';
      }).join("") : '<span class="muted small">No races yet.</span>';
      Array.prototype.forEach.call(list.querySelectorAll("[data-rid]"), function (b) {
        b.onclick = function () { d.races = d.races.filter(function (x) { return x.id !== b.getAttribute("data-rid"); }); regeneratePreserving(); saveData(); renderMain(); };
      });
    }
    document.getElementById("rc-add").onclick = function () {
      var dv = rcd.value, msg = document.getElementById("rc-msg"); msg.className = "";
      if (!dv) { msg.className = "err"; msg.textContent = "Pick a distance."; return; }
      var gm, title;
      if (dv === "custom") { gm = parseFloat(document.getElementById("rc-cm").value); title = E.km(gm) + " km"; }
      else { var p = E.RACE_PRESETS.find(function (x) { return x.key === dv; }); gm = p.meters; title = p.title; }
      if (!(gm >= 1000)) { msg.className = "err"; msg.textContent = "Distance too small."; return; }
      var dateV = document.getElementById("rc-date").value, gt = readHMS("rc-h", "rc-m", "rc-s");
      d.races = (d.races || []).concat([{ id: rid("r-"), meters: gm, title: title, dateISO: dateV ? new Date(dateV).toISOString() : null, goalTimeSec: gt > 0 ? gt : null }]);
      regeneratePreserving(); saveData(); renderMain();
    };

    // plan management
    if (state.data.plan) {
      var pm = h('<div class="card"><h2>Current plan</h2><p class="muted small">' + (state.data.goal ? "Goal: " + esc(state.data.goal.title) : "Rolling base block") + ' · ' + state.data.plan.weeks.length + ' weeks' + (state.data.archived && state.data.archived.length ? ' · ' + state.data.archived.length + ' archived' : "") + '</p>' +
        '<button class="btn secondary" id="export-ics">📅 Add plan to calendar (.ics)</button>' +
        '<button class="btn secondary" id="finish">Finish & archive this plan</button></div>');
      body.appendChild(pm);
      document.getElementById("export-ics").onclick = function () { downloadFile("widestrides-plan.ics", buildICS(state.data.plan), "text/calendar"); };
      document.getElementById("finish").onclick = function () {
        if (!confirm("Archive this plan? Its logged sessions are kept in history, and the plan clears so you can start the next block.")) return;
        d.archived = (d.archived || []).concat([{ title: state.data.goal ? state.data.goal.title : "Base block", at: new Date().toISOString(), weeks: state.data.plan.weeks.length }]);
        if (state.data.goal) d.races = (d.races || []).filter(function (r) { return r.id !== state.data.goal.id; });
        d.plan = null; d.goal = activeRace(d.races);
        if (d.goal) regeneratePreserving();
        saveData(); state.tab = "plan"; renderMain();
      };
    }

    // backup / restore
    var bk = h('<div class="card"><h2>Backup</h2><p class="muted small">Download all your data as a file, or restore it later / on another account.</p>' +
      '<button class="btn secondary" id="bk-exp">⬇︎ Download my data (.json)</button>' +
      '<label class="btn secondary" style="display:block;text-align:center;cursor:pointer">⬆︎ Restore from file<input id="bk-imp" type="file" accept="application/json,.json" style="display:none" /></label>' +
      '<div id="bk-msg"></div></div>');
    body.appendChild(bk);
    document.getElementById("bk-exp").onclick = function () { downloadFile("widestrides-backup.json", JSON.stringify(state.data, null, 2), "application/json"); };
    document.getElementById("bk-imp").onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var obj = JSON.parse(rd.result);
          if (!confirm("Restore this backup? It replaces your current data on this account.")) return;
          state.data = obj; if (state.data.plan) ensureIds(state.data.plan);
          E.setUnits(state.data.units || "km"); applyTheme();
          saveData(); state.tab = "plan"; renderMain();
        } catch (err) { var m = document.getElementById("bk-msg"); m.className = "err"; m.textContent = "That file isn't a valid backup."; }
      };
      rd.readAsText(f);
    };

    // reset
    var dz = h('<div class="card"><h2>Reset</h2><p class="muted small">Wipes your profile, plan, races and logs on this account.</p><button class="btn danger" id="reset-all">Reset everything</button></div>');
    body.appendChild(dz);
    document.getElementById("reset-all").onclick = async function () {
      if (!confirm("Erase everything and start over? This cannot be undone.")) return;
      state.data = {}; await saveData(); state.tab = "plan"; applyTheme(); renderMain();
    };
  }

  // ============================================================ coach view
  async function openCoach(userId, email) {
    state.tab = "admin";
    var r = await sb.from("profiles").select("data").eq("user_id", userId).maybeSingle();
    if (r.error) { alert(r.error.message); return; }
    state.coachData = (r.data && r.data.data) || {};
    if (state.coachData.plan) ensureIds(state.coachData.plan);
    state.coach = { userId: userId, email: email };
    renderMain();
  }

  function renderCoach(body) {
    var d = state.coachData;
    var back = h('<a class="link small">← Back to members</a>');
    back.onclick = function () { state.coach = null; state.coachData = null; renderMain(); };
    body.appendChild(back);
    body.appendChild(h('<header class="top" style="padding-top:8px"><h1 style="font-size:19px">🧑‍🏫 ' + esc(state.coach.email) + '</h1></header>'));

    if (!d || !(d.testMeters > 0)) { body.appendChild(h('<div class="card muted">This member hasn\'t set up a test yet.</div>')); return; }
    var v = E.velocityFromTest(d.testMeters, d.testMinutes);
    var info = h('<div class="card small"><div class="muted">Reference pace <b class="mono">' + E.fmtPace(E.referencePace(v)) + '/' + ul() + '</b> · test ' + d.testMeters + ' m / ' + d.testMinutes + ' min' + (d.goal ? ' · goal ' + esc(d.goal.title) : "") + '</div></div>');
    body.appendChild(info);
    if (d.goal && d.plan) {
      var f = E.forecast(d.plan, d, E.currentWeekIndex(d.plan));
      if (f) body.appendChild(h('<div class="card"><div style="font-weight:700;color:' + (f.isOnTrack ? "var(--easy)" : "var(--quality)") + '">' + esc(f.statusText) + '</div><div class="muted small" style="margin-top:4px">Projected ' + E.fmtHMS(f.predictedFinishSeconds) + ' vs goal ' + E.fmtHMS(f.goalSeconds) + '</div></div>'));
    }
    if (!d.plan) { body.appendChild(h('<div class="card muted">No plan generated yet.</div>')); return; }

    body.appendChild(h('<p class="muted small">Tap any session to adjust it or leave a coach note.</p>'));
    d.plan.weeks.forEach(function (wk) {
      body.appendChild(h('<div class="week-head"><span class="wnum">Week ' + wk.index + '</span><span class="phase">' + wk.phase + '</span><span class="muted small" style="margin-left:auto">' + weekRange(wk) + '</span></div>'));
      var box = h('<div class="wk"></div>');
      wk.workouts.forEach(function (w) {
        var b = BADGE[w.type] || ["", "var(--muted)"];
        var wo = h('<div class="wo"><div class="wo-top">' +
          '<span class="badge" style="background:' + b[1] + '">' + b[0] + '</span>' +
          '<span>' + (w.completed ? "✓ " : "") + esc(w.title) + '</span>' +
          (w.isCustomized ? '<span class="badge-edit"> ·edited</span>' : "") +
          '<span class="wo-day">' + dayLabel(w.dateISO) + '</span></div>' +
          '<div class="wo-detail">' + esc(w.steps && w.steps.length ? E.summarizeSteps(w.steps) : w.detail) + '</div>' +
          (w.coachNote ? '<div class="note-line" style="color:var(--accent)">🧑‍🏫 ' + esc(w.coachNote) + '</div>' : "") + '</div>');
        wo.onclick = function () { openDetail(w.id); };
        box.appendChild(wo);
      });
      body.appendChild(box);
    });
  }

  // ============================================================ dates / boot
  function dayLabel(iso) { return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  function weekRange(wk) { var s = new Date(wk.startISO), e = new Date(s); e.setDate(e.getDate() + 6); var f = function (d) { return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); }; return f(s) + " – " + f(e); }

  async function signOut() { if (sb) await sb.auth.signOut(); state.user = null; state.isMember = false; state.isAdmin = false; _loaded = false; state.data = null; state.tab = "plan"; render(); }
  async function checkMembership() { var r = await sb.from("members").select("is_admin").eq("user_id", state.user.id).maybeSingle(); state.isMember = !!r.data; state.isAdmin = !!(r.data && r.data.is_admin); }
  async function boot() {
    if (state.mode === "cloud") { var s = await sb.auth.getSession(); state.user = s.data.session ? s.data.session.user : null; if (state.user) await checkMembership(); }
    _loaded = false; state.data = null; render();
  }
  boot();

  // PWA: register the service worker (skips file://, where it isn't allowed)
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
