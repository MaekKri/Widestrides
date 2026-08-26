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
    data: null, tab: "plan", authMode: "signin",
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
    var tabs = [["plan", "Plan"], ["paces", "Paces"], ["progress", "Progress"], ["calc", "Calculator"], ["settings", "Settings"]];
    if (state.isAdmin) tabs.push(["admin", "Admin"]);
    if (state.mode === "cloud") tabs.push(["account", "Account"]);
    $app.innerHTML = "";
    var head = h('<header class="top"><h1>Widestrides</h1></header>');
    if (state.mode === "cloud") { var who = h('<div class="who"></div>'); who.textContent = state.user.email; head.appendChild(who); }
    $app.appendChild(head);
    if (state.mode === "local") $app.appendChild(h('<div class="banner">Running locally — your plan is saved in this browser only. Add your Supabase keys in <code>config.js</code> to enable sign-in, invite codes and cloud save.</div>'));

    var nav = h('<nav class="tabs"></nav>');
    tabs.forEach(function (t) { var b = h('<button>' + t[1] + '</button>'); if (state.tab === t[0] && !state.coach) b.className = "active"; b.onclick = function () { state.coach = null; state.coachData = null; state.tab = t[0]; renderMain(); }; nav.appendChild(b); });
    $app.appendChild(nav);

    var body = h('<div id="body"></div>'); $app.appendChild(body);
    if (state.coach) { renderCoach(body); if (state.detail && state.dwo) $app.appendChild(buildSheet()); return; }
    if (state.tab === "plan") renderPlan(body);
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
      '<h3 style="margin-top:20px">Goal race (optional)</h3>' +
      '<label class="field">Distance</label><select id="f-dist">' + raceOptions(g) + '</select>' +
      '<div class="grid2" id="custom-wrap" style="display:none"><div><label class="field">Custom metres</label><input id="f-cm" type="number" value="' + (g.meters || "") + '" /></div><div></div></div>' +
      '<div class="grid2"><div><label class="field">Race date</label><input id="f-date" type="date" value="' + (g.dateISO ? g.dateISO.slice(0, 10) : "") + '" /></div>' +
      '<div><label class="field">Goal time (optional)</label><input id="f-time" placeholder="h:mm:ss" value="' + (g.goalTimeSec ? E.fmtHMS(g.goalTimeSec) : "") + '" /></div></div>' +
      '<button class="btn" id="gen">Generate my plan</button><div id="gmsg"></div></div>'));
    if (d.testMinutes) document.getElementById("f-min").value = String(d.testMinutes);
    if (d.daysPerWeek) document.getElementById("f-days").value = String(d.daysPerWeek);
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
        if (gm >= 1000) { var gt = parseTime(document.getElementById("f-time").value); goal = { meters: gm, title: title, dateISO: dateV ? new Date(dateV).toISOString() : null, goalTimeSec: isFinite(gt) ? gt : null }; }
      }
      var now = new Date().toISOString();
      state.data = Object.assign({}, state.data, { name: document.getElementById("f-name").value.trim(), testMeters: meters, testMinutes: minutes, daysPerWeek: days, startISO: now });
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
          '<div class="wo-detail">' + esc(w.detail) + '</div>' +
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
    sheet.appendChild(h('<div class="muted small">' + dayLabel(w.dateISO) + (w.isCustomized ? ' · <span class="badge-edit">edited</span>' : "") + '</div>'));
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
        if (state.repeatRefs.length) {
          var srow = h('<div class="step-edit"><div class="grow"><div class="t">Sets (repeats)</div><div class="s">applies to every repeated block</div></div></div>');
          srow.appendChild(mkBtn("–", function () { setSets(state.sets - 1); drawSheet(sheet); }));
          srow.appendChild(h('<div class="mono" style="min-width:26px;text-align:center">' + state.sets + '</div>'));
          srow.appendChild(mkBtn("+", function () { setSets(state.sets + 1); drawSheet(sheet); }));
          sec.appendChild(srow);
        }
        w.steps.forEach(function (s, i) {
          var row = h('<div class="step-edit"></div>');
          var info = h('<div class="grow"><div class="t">' + (s.repeatCount > 1 ? s.repeatCount + "× " : "") + esc(s.label) + '</div><div class="s">' + editSub(s) + '</div></div>');
          row.appendChild(info);
          if (s.durationType !== "lapButton") {
            var stp = s.durationType === "time" ? 10 : 100, min = s.durationType === "time" ? 10 : 100;
            row.appendChild(mkBtn("–", function () { s.durationValue = Math.max(min, s.durationValue - stp); w.isCustomized = true; drawSheet(sheet); }));
            row.appendChild(mkBtn("+", function () { s.durationValue += stp; w.isCustomized = true; drawSheet(sheet); }));
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
          sec.appendChild(h('<div class="step"><div><div>' + (s.repeatCount > 1 ? s.repeatCount + "× " : "") + esc(s.label) + '</div><div class="st-sub">' + sub + '</div></div>' + (pace ? '<div class="st-pace mono">' + pace + ' /km</div>' : "") + '</div>'));
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
      sheet.appendChild(h('<div class="sec"><h4>Athlete log</h4><div class="small muted">' +
        (w.completed ? "✓ Completed" : "Not completed yet") + (w.rpe ? " · RPE " + w.rpe + "/10" : "") + '</div>' +
        (w.note ? '<div class="note-line">📝 ' + esc(w.note) + '</div>' : "") + '</div>'));
    } else {
      var log = h('<div class="sec"><h4>Log this session</h4></div>');
      var chk = h('<label class="chk"><input type="checkbox" ' + (w.completed ? "checked" : "") + ' /> Completed</label>');
      chk.querySelector("input").onchange = function (e) { w.completed = e.target.checked; };
      log.appendChild(chk);
      var rpe = h('<div style="margin-top:10px"><div class="row spread"><span class="small">Effort (RPE)</span><span class="small mono" id="rpev">' + (w.rpe || "—") + ' / 10</span></div><input type="range" min="1" max="10" step="1" value="' + (w.rpe || 5) + '" /></div>');
      rpe.querySelector("input").oninput = function (e) { w.rpe = parseInt(e.target.value, 10); document.getElementById("rpev").textContent = w.rpe + " / 10"; };
      log.appendChild(rpe);
      var note = h('<div style="margin-top:10px"><label class="field">Notes</label><textarea placeholder="How did it feel? Weather, splits, niggles…">' + esc(w.note || "") + '</textarea></div>');
      note.querySelector("textarea").oninput = function (e) { w.note = e.target.value; };
      log.appendChild(note);
      sheet.appendChild(log);
    }

    var save = h('<button class="btn" style="margin-top:18px">' + (coach ? "Save changes for athlete" : "Save") + '</button>');
    save.onclick = async function () { if (w.isCustomized) w.detail = E.summarizeSteps(w.steps); await commitWorkout(w); closeDetail(); };
    sheet.appendChild(save);
  }
  function mkBtn(txt, fn) { var b = h('<button class="stepbtn">' + txt + '</button>'); b.onclick = fn; return b; }
  function editSub(s) {
    var t = E.stepDurationText(s);
    var p = E.stepPaceText(s); if (p) t += " @ " + p + " /km";
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
      var fresh = E.qualityWorkout(w.kind, wk.phase || "build", v);
      fresh.steps.forEach(function (s) { s.id = rid("s-"); });
      w.steps = fresh.steps; w.detail = fresh.detail; w.isCustomized = false;
    } else {
      w.isCustomized = false; // for long/easy just clear the flag
    }
  }
  async function commitWorkout(w) {
    var wk = activeData().plan.weeks.find(function (x) { return x.index === state.detail.weekIndex; });
    if (!wk) return;
    var idx = wk.workouts.findIndex(function (x) { return x.id === w.id; });
    if (idx >= 0) wk.workouts[idx] = w;
    await saveActive();
  }

  // ============================================================ paces tab
  function renderPaces(body) {
    if (!hasProfile()) { body.appendChild(h('<div class="card muted">Set up your test first (Plan tab).</div>')); return; }
    var v = E.velocityFromTest(state.data.testMeters, state.data.testMinutes);
    var card = h('<div class="card"><h2>Your training paces</h2><p class="muted small">Reference (100%) pace <b class="mono">' + E.fmtPace(E.referencePace(v)) + ' /km</b> · from ' + state.data.testMeters + ' m in ' + state.data.testMinutes + ' min</p></div>');
    E.allPrescriptions(v).forEach(function (rx) {
      card.appendChild(h('<div class="zone"><span class="dot" style="background:' + (DOT[rx.zone] || "var(--muted)") + '"></span><div><div class="z-title">' + rx.title + '</div>' + (rx.hr ? '<div class="z-hr">~' + rx.hr + ' bpm</div>' : "") + '</div><div class="z-pace mono">' + E.rangeText(rx) + '<div class="z-hr">/km</div></div></div>'));
    });
    body.appendChild(card);
  }

  // ============================================================ calculator tab
  function renderCalc(body) {
    body.appendChild(h('<div class="card"><h2>Distance · Time · Pace</h2><p class="muted small">Fill in any two, leave the third blank, press Calculate.</p>' +
      '<div class="grid3"><div><label class="field">Distance (km)</label><input id="c-d" inputmode="decimal" placeholder="10" /></div>' +
      '<div><label class="field">Time (h:mm:ss)</label><input id="c-t" placeholder="45:00" /></div>' +
      '<div><label class="field">Pace (/km)</label><input id="c-p" placeholder="4:30" /></div></div>' +
      '<button class="btn" id="calc">Calculate</button><div id="cout" class="small" style="margin-top:14px"></div></div>'));
    document.getElementById("calc").onclick = function () {
      var dKm = parseFloat(document.getElementById("c-d").value), t = parseTime(document.getElementById("c-t").value), p = parsePace(document.getElementById("c-p").value);
      var r = E.solveDTP({ distanceM: dKm > 0 ? dKm * 1000 : undefined, timeSec: isFinite(t) ? t : undefined, paceSecPerKm: isFinite(p) ? p : undefined });
      var out = document.getElementById("cout");
      if (!r) { out.className = "err"; out.textContent = "Enter at least two values."; return; }
      out.className = "";
      document.getElementById("c-d").value = (r.distanceM / 1000).toFixed(2).replace(/\.?0+$/, "");
      document.getElementById("c-t").value = E.fmtHMS(r.timeSec);
      document.getElementById("c-p").value = E.fmtPace(r.paceSecPerKm);
      out.innerHTML = '<b>' + (r.distanceM / 1000).toFixed(2).replace(/\.?0+$/, "") + ' km</b> in <b>' + E.fmtHMS(r.timeSec) + '</b> = <b>' + E.fmtPace(r.paceSecPerKm) + ' /km</b>';
    };
    var pred = h('<div class="card"><h2>Race predictions (Riegel)</h2><p class="muted small">From a recent race or hard effort — distance + time.</p>' +
      '<div class="grid2"><div><label class="field">From distance (km)</label><input id="r-d" inputmode="decimal" placeholder="10" /></div><div><label class="field">In time</label><input id="r-t" placeholder="45:00" /></div></div>' +
      '<button class="btn" id="predict">Predict</button><div id="rout" style="margin-top:12px"></div></div>');
    body.appendChild(pred);
    document.getElementById("predict").onclick = function () {
      var d = parseFloat(document.getElementById("r-d").value), t = parseTime(document.getElementById("r-t").value), out = document.getElementById("rout");
      if (!(d > 0) || !isFinite(t)) { out.className = "err small"; out.textContent = "Enter distance and time."; return; }
      out.className = ""; out.innerHTML = E.RACE_PRESETS.map(function (p) { var tt = E.riegelPredict(t, d * 1000, p.meters); return '<div class="zone"><div class="z-title">' + p.title + '</div><div class="z-pace mono">' + E.fmtHMS(tt) + '<div class="z-hr">' + E.fmtPace(tt / (p.meters / 1000)) + ' /km</div></div></div>'; }).join("");
    };
    if (hasProfile()) { document.getElementById("r-d").value = (state.data.testMeters / 1000).toFixed(2).replace(/\.?0+$/, ""); document.getElementById("r-t").value = E.fmtHMS(state.data.testMinutes * 60); }
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
      out.innerHTML = '<div class="grid3">' + stat("Completed", r.completedCount + "/" + r.totalCount) + stat("Volume", Math.round(r.actualMeters / 1000) + " km") + stat("Avg RPE", r.averageRPE ? r.averageRPE.toFixed(1) : "—") + '</div>' +
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
      bout.innerHTML = '<div class="grid3">' + stat("Weeks", "W" + weeks[0].index + "–" + weeks[weeks.length - 1].index) + stat("Completion", Math.round(b.completionRate * 100) + "%") + stat("Volume", Math.round(b.totalActualMeters / 1000) + " km") + '</div>';
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
    var ap = h('<div class="card"><h2>Appearance</h2>' +
      '<div class="toggle-row"><span>Accent colour</span><input id="s-accent" type="color" style="width:52px;height:34px;padding:2px;border:1px solid var(--line);border-radius:8px" value="' + (d.theme.accent || "#2f6df6") + '" /></div>' +
      '<p class="muted small">Sets the highlight colour across buttons, tabs and links.</p>' +
      '<button class="btn secondary" id="s-theme-reset">Reset colour</button></div>');
    body.appendChild(ap);
    document.getElementById("s-accent").oninput = function (e) { d.theme.accent = e.target.value; applyTheme(); saveData(); };
    document.getElementById("s-theme-reset").onclick = function () { d.theme = {}; applyTheme(); saveData(); renderMain(); };

    // fitness test / retest
    if (hasProfile()) {
      var t = h('<div class="card"><h2>Fitness test (VCR)</h2>' +
        '<p class="muted small">Active: <b>' + d.testMeters + ' m in ' + d.testMinutes + ' min</b> → ref pace ' + E.fmtPace(E.referencePace(E.velocityFromTest(d.testMeters, d.testMinutes))) + '/km</p>' +
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
        return '<div class="toggle-row"><span class="small">' + new Date(r.dateISO).toLocaleDateString() + ' · ' + r.meters + ' m / ' + r.minutes + ' min · ' + E.fmtPace(E.referencePace(E.velocityFromTest(r.meters, r.minutes))) + '/km</span>' + (active ? '<span class="pill used">active</span>' : '<button class="stepbtn" style="width:auto;padding:0 10px;font-size:13px" data-uid="' + r.id + '">Use</button>') + '</div>';
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
      '<div class="grid2"><div><label class="field">Date</label><input id="rc-date" type="date" /></div><div><label class="field">Goal time (optional)</label><input id="rc-time" placeholder="h:mm:ss" /></div></div>' +
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
      var dateV = document.getElementById("rc-date").value, gt = parseTime(document.getElementById("rc-time").value);
      d.races = (d.races || []).concat([{ id: rid("r-"), meters: gm, title: title, dateISO: dateV ? new Date(dateV).toISOString() : null, goalTimeSec: isFinite(gt) ? gt : null }]);
      regeneratePreserving(); saveData(); renderMain();
    };

    // plan management
    if (state.data.plan) {
      var pm = h('<div class="card"><h2>Current plan</h2><p class="muted small">' + (state.data.goal ? "Goal: " + esc(state.data.goal.title) : "Rolling base block") + ' · ' + state.data.plan.weeks.length + ' weeks' + (state.data.archived && state.data.archived.length ? ' · ' + state.data.archived.length + ' archived' : "") + '</p>' +
        '<button class="btn secondary" id="finish">Finish & archive this plan</button></div>');
      body.appendChild(pm);
      document.getElementById("finish").onclick = function () {
        if (!confirm("Archive this plan? Its logged sessions are kept in history, and the plan clears so you can start the next block.")) return;
        d.archived = (d.archived || []).concat([{ title: state.data.goal ? state.data.goal.title : "Base block", at: new Date().toISOString(), weeks: state.data.plan.weeks.length }]);
        if (state.data.goal) d.races = (d.races || []).filter(function (r) { return r.id !== state.data.goal.id; });
        d.plan = null; d.goal = activeRace(d.races);
        if (d.goal) regeneratePreserving();
        saveData(); state.tab = "plan"; renderMain();
      };
    }

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
    var info = h('<div class="card small"><div class="muted">Reference pace <b class="mono">' + E.fmtPace(E.referencePace(v)) + '/km</b> · test ' + d.testMeters + ' m / ' + d.testMinutes + ' min' + (d.goal ? ' · goal ' + esc(d.goal.title) : "") + '</div></div>');
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
          '<div class="wo-detail">' + esc(w.detail) + '</div>' +
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
})();
