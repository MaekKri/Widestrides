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
  function pad(n) { return String(n).padStart(2, "0"); }
  function parsePace(s) { var m = /^(\d+):(\d{1,2})$/.exec((s || "").trim()); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
  function parseTime(s) {
    s = (s || "").trim(); var p = s.split(":").map(Number);
    if (p.some(isNaN)) return NaN;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 1) return p[0];
    return NaN;
  }
  var BADGE = { longRun: ["Long", "var(--long)"], quality: ["Quality", "var(--quality)"], easy: ["Easy", "var(--easy)"], race: ["Race", "var(--danger)"], test: ["Test", "var(--accent)"] };
  var DOT = { regeneration: "var(--easy)", enduranceEasy: "var(--easy)", enduranceSteady: "var(--accent)", threshold: "var(--quality)", extensiveInterval: "var(--danger)" };

  // ============================================================ render root
  async function render() {
    if (state.mode === "cloud" && !state.user) return renderAuth();
    if (state.mode === "cloud" && !state.isMember) return renderInvite();
    await ensureData();
    renderMain();
  }
  var _loaded = false;
  async function ensureData() { if (!_loaded) { await loadData(); _loaded = true; } }

  // ============================================================ auth
  function renderAuth() {
    var signup = state.authMode === "signup";
    $app.innerHTML = "";
    $app.appendChild(h(
      '<div class="auth-wrap">' +
        '<h1>Widestrides</h1>' +
        '<div class="tag">Running paces built around one honest number.</div>' +
        '<div class="card">' +
          '<h2>' + (signup ? "Create account" : "Sign in") + '</h2>' +
          '<label class="field">Email</label><input id="em" type="email" autocomplete="email" />' +
          '<label class="field">Password</label><input id="pw" type="password" autocomplete="' + (signup ? "new-password" : "current-password") + '" />' +
          '<button class="btn" id="go">' + (signup ? "Sign up" : "Sign in") + '</button>' +
          '<div id="msg"></div>' +
          '<p class="small muted" style="margin-top:16px">' +
            (signup ? "Have an account? " : "New here? ") +
            '<a class="link" id="toggle">' + (signup ? "Sign in" : "Create one") + '</a>' +
          '</p>' +
        '</div>' +
      '</div>'));
    document.getElementById("toggle").onclick = function () { state.authMode = signup ? "signin" : "signup"; renderAuth(); };
    document.getElementById("go").onclick = doAuth;
    [document.getElementById("em"), document.getElementById("pw")].forEach(function (i) {
      i.addEventListener("keydown", function (e) { if (e.key === "Enter") doAuth(); });
    });
  }
  async function doAuth() {
    var email = document.getElementById("em").value.trim();
    var pw = document.getElementById("pw").value;
    var msg = document.getElementById("msg");
    msg.className = ""; msg.textContent = "Working…";
    var fn = state.authMode === "signup" ? sb.auth.signUp({ email: email, password: pw }) : sb.auth.signInWithPassword({ email: email, password: pw });
    var r = await fn;
    if (r.error) { msg.className = "err"; msg.textContent = r.error.message; return; }
    if (state.authMode === "signup" && !r.data.session) {
      msg.className = "ok"; msg.textContent = "Check your email to confirm, then sign in. (You can turn email confirmation off in Supabase for instant sign-in.)";
      return;
    }
    await boot();
  }

  // ============================================================ invite
  function renderInvite() {
    $app.innerHTML = "";
    $app.appendChild(h(
      '<div class="auth-wrap">' +
        '<h1>One more step</h1>' +
        '<div class="tag">Widestrides is invite-only. Enter your code.</div>' +
        '<div class="card">' +
          '<label class="field">Invite code</label><input id="code" placeholder="WS-XXXX-XXXX" />' +
          '<button class="btn" id="redeem">Unlock</button>' +
          '<div id="imsg"></div>' +
          '<p class="small muted" style="margin-top:16px"><a class="link" id="out">Sign out</a></p>' +
        '</div>' +
      '</div>'));
    document.getElementById("out").onclick = signOut;
    document.getElementById("redeem").onclick = async function () {
      var code = document.getElementById("code").value.trim();
      var m = document.getElementById("imsg"); m.className = ""; m.textContent = "Checking…";
      var r = await sb.rpc("redeem_invite", { p_code: code });
      if (r.error) { m.className = "err"; m.textContent = r.error.message; return; }
      if (r.data === "ok") { await boot(); }
      else { m.className = "err"; m.textContent = "That code is invalid or already used."; }
    };
  }

  // ============================================================ main shell
  function renderMain() {
    var tabs = [["plan", "Plan"], ["paces", "Paces"], ["calc", "Calculator"]];
    if (state.isAdmin) tabs.push(["admin", "Admin"]);
    $app.innerHTML = "";
    var head = h('<header class="top"><h1>Widestrides</h1></header>');
    if (state.mode === "cloud") {
      var who = h('<div class="who"></div>');
      who.textContent = state.user.email + "  ·  ";
      var out = h('<a class="link small">Sign out</a>'); out.onclick = signOut; who.appendChild(out);
      head.appendChild(who);
    }
    $app.appendChild(head);

    if (state.mode === "local") {
      $app.appendChild(h('<div class="banner">Running locally — your plan is saved in this browser only. Add your Supabase keys in <code>config.js</code> to enable sign-in, invite codes and cloud save.</div>'));
    }

    var nav = h('<nav class="tabs"></nav>');
    tabs.forEach(function (t) {
      var b = h('<button>' + t[1] + '</button>');
      if (state.tab === t[0]) b.className = "active";
      b.onclick = function () { state.tab = t[0]; renderMain(); };
      nav.appendChild(b);
    });
    $app.appendChild(nav);

    var body = h('<div id="body"></div>');
    $app.appendChild(body);
    if (state.tab === "plan") renderPlan(body);
    else if (state.tab === "paces") renderPaces(body);
    else if (state.tab === "calc") renderCalc(body);
    else if (state.tab === "admin") renderAdmin(body);
  }

  // ============================================================ setup form
  function hasProfile() { var d = state.data; return d && d.testMeters > 0 && d.testMinutes > 0; }

  function renderSetup(body) {
    var d = state.data || {};
    var g = d.goal || {};
    body.appendChild(h('<div class="card"><h2>Set up your plan</h2>' +
      '<p class="muted small">Run one 30-min all-out test (15 min warm-up + 3–4 strides of 10 sec, 30 min hard, 10 min cool-down), then enter the distance you covered.</p>' +
      '<label class="field">Name (optional)</label><input id="f-name" value="' + esc(d.name || "") + '" />' +
      '<div class="grid2">' +
        '<div><label class="field">Test distance (metres)</label><input id="f-m" type="number" inputmode="numeric" value="' + (d.testMeters || "") + '" placeholder="e.g. 9000" /></div>' +
        '<div><label class="field">Test length</label><select id="f-min"><option value="30">30 min</option><option value="45">45 min</option><option value="60">60 min</option></select></div>' +
      '</div>' +
      '<label class="field">Training days per week</label><select id="f-days"><option>3</option><option>4</option><option>5</option><option>6</option></select>' +
      '<h3 style="margin-top:20px">Goal race (optional)</h3>' +
      '<label class="field">Distance</label><select id="f-dist">' + raceOptions(g) + '</select>' +
      '<div class="grid2" id="custom-wrap" style="display:none"><div><label class="field">Custom metres</label><input id="f-cm" type="number" value="' + (g.meters || "") + '" /></div><div></div></div>' +
      '<div class="grid2">' +
        '<div><label class="field">Race date</label><input id="f-date" type="date" value="' + (g.dateISO ? g.dateISO.slice(0, 10) : "") + '" /></div>' +
        '<div><label class="field">Goal time (optional)</label><input id="f-time" placeholder="h:mm:ss" value="' + (g.goalTimeSec ? E.fmtHMS(g.goalTimeSec) : "") + '" /></div>' +
      '</div>' +
      '<button class="btn" id="gen">Generate my plan</button>' +
      '<div id="gmsg"></div>' +
    '</div>'));
    if (d.testMinutes) document.getElementById("f-min").value = String(d.testMinutes);
    if (d.daysPerWeek) document.getElementById("f-days").value = String(d.daysPerWeek);
    var distSel = document.getElementById("f-dist");
    function syncCustom() { document.getElementById("custom-wrap").style.display = distSel.value === "custom" ? "" : "none"; }
    distSel.onchange = syncCustom; syncCustom();

    document.getElementById("gen").onclick = async function () {
      var meters = parseFloat(document.getElementById("f-m").value);
      var msg = document.getElementById("gmsg"); msg.className = "";
      if (!(meters >= 1000)) { msg.className = "err"; msg.textContent = "Enter a test distance of at least 1000 m."; return; }
      var minutes = parseFloat(document.getElementById("f-min").value);
      var days = parseInt(document.getElementById("f-days").value, 10);
      var goal = null;
      var dv = distSel.value, dateV = document.getElementById("f-date").value;
      if (dv) {
        var gm, title;
        if (dv === "custom") { gm = parseFloat(document.getElementById("f-cm").value); title = E.km(gm) + " km"; }
        else { var p = E.RACE_PRESETS.find(function (x) { return x.key === dv; }); gm = p.meters; title = p.title; }
        if (gm >= 1000) {
          var gt = parseTime(document.getElementById("f-time").value);
          goal = { meters: gm, title: title, dateISO: dateV ? new Date(dateV).toISOString() : null, goalTimeSec: isFinite(gt) ? gt : null };
        }
      }
      state.data = Object.assign({}, state.data, {
        name: document.getElementById("f-name").value.trim(),
        testMeters: meters, testMinutes: minutes, daysPerWeek: days, goal: goal,
        startISO: new Date().toISOString(),
      });
      state.data.plan = E.generatePlan(state.data);
      await saveData();
      renderMain();
    };
  }
  function raceOptions(g) {
    var opts = '<option value="">No race — rolling base block</option>';
    E.RACE_PRESETS.forEach(function (p) {
      var sel = g && !g.custom && g.title === p.title ? " selected" : "";
      opts += '<option value="' + p.key + '"' + sel + '>' + p.title + ' · ' + E.km(p.meters) + ' km</option>';
    });
    opts += '<option value="custom">Custom distance…</option>';
    return opts;
  }

  // ============================================================ plan tab
  function renderPlan(body) {
    if (!hasProfile() || !state.data.plan) { renderSetup(body); return; }
    var plan = state.data.plan;
    var bar = h('<div class="row spread" style="margin-bottom:6px"><div class="muted small">' +
      (plan.goal ? "Goal: " + esc(plan.goal.title) : "Rolling base block") + ' · ' + plan.weeks.length + ' weeks</div></div>');
    var edit = h('<a class="link small">Edit setup</a>'); edit.onclick = function () { var b = document.getElementById("body"); b.innerHTML = ""; renderSetup(b); };
    bar.appendChild(edit); body.appendChild(bar);

    plan.weeks.forEach(function (wk) {
      var head = h('<div class="week-head"><span class="wnum">Week ' + wk.index + '</span><span class="phase">' + wk.phase + '</span><span class="muted small" style="margin-left:auto">' + weekRange(wk) + '</span></div>');
      body.appendChild(head);
      var box = h('<div class="wk"></div>');
      wk.workouts.forEach(function (w) {
        var b = BADGE[w.type] || ["", "var(--muted)"];
        var wo = h('<div class="wo"><div class="wo-top">' +
          '<span class="badge" style="background:' + b[1] + '">' + b[0] + '</span>' +
          '<span>' + esc(w.title) + '</span>' +
          '<span class="wo-day">' + dayLabel(w.dateISO) + '</span></div>' +
          '<div class="wo-detail">' + esc(w.detail) + '</div>' +
          stepsHTML(w) + '</div>');
        if (w.steps && w.steps.length) wo.onclick = function () { wo.classList.toggle("open"); };
        box.appendChild(wo);
      });
      body.appendChild(box);
    });
  }
  function stepsHTML(w) {
    if (!w.steps || !w.steps.length) return "";
    var rows = w.steps.map(function (s) {
      var name = s.repeatCount > 1 ? s.repeatCount + "× " + esc(s.label) : esc(s.label);
      var sub = E.stepDurationText(s);
      if (E.isRecovery(s)) sub += " · " + (E.recoveryIsJog(s) ? "jog" : "standing rest");
      var pace = E.stepPaceText(s);
      return '<div class="step"><div><div>' + name + '</div><div class="st-sub">' + sub + '</div></div>' +
        (pace ? '<div class="st-pace mono">' + pace + ' /km</div>' : "") + '</div>';
    }).join("");
    return '<div class="steps">' + rows + '</div>';
  }

  // ============================================================ paces tab
  function renderPaces(body) {
    if (!hasProfile()) { body.appendChild(h('<div class="card muted">Set up your test first (Plan tab).</div>')); return; }
    var v = E.velocityFromTest(state.data.testMeters, state.data.testMinutes);
    var card = h('<div class="card"><h2>Your training paces</h2>' +
      '<p class="muted small">Reference (100%) pace <b class="mono">' + E.fmtPace(E.referencePace(v)) + ' /km</b> · from ' + state.data.testMeters + ' m in ' + state.data.testMinutes + ' min</p></div>');
    E.allPrescriptions(v).forEach(function (rx) {
      card.appendChild(h('<div class="zone">' +
        '<span class="dot" style="background:' + (DOT[rx.zone] || "var(--muted)") + '"></span>' +
        '<div><div class="z-title">' + rx.title + '</div>' + (rx.hr ? '<div class="z-hr">~' + rx.hr + ' bpm</div>' : "") + '</div>' +
        '<div class="z-pace mono">' + E.rangeText(rx) + '<div class="z-hr">/km</div></div>' +
      '</div>'));
    });
    body.appendChild(card);
  }

  // ============================================================ calculator tab
  function renderCalc(body) {
    body.appendChild(h('<div class="card"><h2>Distance · Time · Pace</h2>' +
      '<p class="muted small">Fill in any two, leave the third blank, press Calculate.</p>' +
      '<div class="grid3">' +
        '<div><label class="field">Distance (km)</label><input id="c-d" inputmode="decimal" placeholder="10" /></div>' +
        '<div><label class="field">Time (h:mm:ss)</label><input id="c-t" placeholder="45:00" /></div>' +
        '<div><label class="field">Pace (/km)</label><input id="c-p" placeholder="4:30" /></div>' +
      '</div>' +
      '<button class="btn" id="calc">Calculate</button>' +
      '<div id="cout" class="small" style="margin-top:14px"></div>' +
    '</div>'));
    document.getElementById("calc").onclick = function () {
      var dKm = parseFloat(document.getElementById("c-d").value);
      var t = parseTime(document.getElementById("c-t").value);
      var p = parsePace(document.getElementById("c-p").value);
      var r = E.solveDTP({ distanceM: dKm > 0 ? dKm * 1000 : undefined, timeSec: isFinite(t) ? t : undefined, paceSecPerKm: isFinite(p) ? p : undefined });
      var out = document.getElementById("cout");
      if (!r) { out.className = "err"; out.textContent = "Enter at least two values."; return; }
      out.className = "";
      document.getElementById("c-d").value = (r.distanceM / 1000).toFixed(2).replace(/\.00$/, "");
      document.getElementById("c-t").value = E.fmtHMS(r.timeSec);
      document.getElementById("c-p").value = E.fmtPace(r.paceSecPerKm);
      out.innerHTML = '<b>' + (r.distanceM / 1000).toFixed(2).replace(/\.?0+$/, "") + ' km</b> in <b>' + E.fmtHMS(r.timeSec) + '</b> = <b>' + E.fmtPace(r.paceSecPerKm) + ' /km</b>';
    };

    // Riegel predictions
    var pred = h('<div class="card"><h2>Race predictions (Riegel)</h2>' +
      '<p class="muted small">From a recent race or hard effort — distance + time.</p>' +
      '<div class="grid2">' +
        '<div><label class="field">From distance (km)</label><input id="r-d" inputmode="decimal" placeholder="10" /></div>' +
        '<div><label class="field">In time</label><input id="r-t" placeholder="45:00" /></div>' +
      '</div>' +
      '<button class="btn" id="predict">Predict</button>' +
      '<div id="rout" style="margin-top:12px"></div></div>');
    body.appendChild(pred);
    document.getElementById("predict").onclick = function () {
      var d = parseFloat(document.getElementById("r-d").value), t = parseTime(document.getElementById("r-t").value);
      var out = document.getElementById("rout");
      if (!(d > 0) || !isFinite(t)) { out.className = "err small"; out.textContent = "Enter distance and time."; return; }
      var d1 = d * 1000;
      var rows = E.RACE_PRESETS.map(function (p) {
        var tt = E.riegelPredict(t, d1, p.meters);
        return '<div class="zone"><div class="z-title">' + p.title + '</div><div class="z-pace mono">' + E.fmtHMS(tt) + '<div class="z-hr">' + E.fmtPace(tt / (p.meters / 1000)) + ' /km</div></div></div>';
      }).join("");
      out.className = ""; out.innerHTML = rows;
    };
    if (hasProfile()) {
      document.getElementById("r-d").value = (state.data.testMeters / 1000).toFixed(2).replace(/\.?0+$/, "");
      document.getElementById("r-t").value = E.fmtHMS(state.data.testMinutes * 60);
    }
  }

  // ============================================================ admin tab
  async function renderAdmin(body) {
    body.appendChild(h('<div class="card"><h2>Invite codes</h2>' +
      '<p class="muted small">Generate a code and share it. Each code works once.</p>' +
      '<div class="grid2"><div><label class="field">Note (who is it for?)</label><input id="a-note" placeholder="e.g. John from run club" /></div>' +
      '<div style="display:flex;align-items:flex-end"><button class="btn" id="a-gen" style="margin-top:0">Generate code</button></div></div>' +
      '<div id="a-msg"></div><div id="a-list" class="muted small" style="margin-top:14px">Loading…</div></div>'));
    document.getElementById("a-gen").onclick = async function () {
      var note = document.getElementById("a-note").value.trim();
      var code = "WS-" + rand4() + "-" + rand4();
      var r = await sb.from("invite_codes").insert({ code: code, note: note || null });
      var m = document.getElementById("a-msg");
      if (r.error) { m.className = "err"; m.textContent = r.error.message; return; }
      m.className = "ok"; m.textContent = "Created " + code; document.getElementById("a-note").value = "";
      loadCodes();
    };
    loadCodes();
  }
  async function loadCodes() {
    var box = document.getElementById("a-list");
    var r = await sb.from("invite_codes").select("*").order("created_at", { ascending: false });
    if (r.error) { box.className = "err"; box.textContent = r.error.message; return; }
    if (!r.data.length) { box.textContent = "No codes yet."; return; }
    var rows = r.data.map(function (c) {
      var status = c.disabled ? '<span class="pill off">disabled</span>' : (c.used_by ? '<span class="pill used">used</span>' : '<span class="pill free">available</span>');
      var act = (!c.disabled && !c.used_by) ? '<a class="link" data-off="' + esc(c.code) + '">disable</a>' : "";
      return '<tr><td><code>' + esc(c.code) + '</code></td><td>' + esc(c.note || "") + '</td><td>' + status + '</td><td>' + act + '</td></tr>';
    }).join("");
    box.className = ""; box.innerHTML = '<table class="codes"><tr><th>Code</th><th>Note</th><th>Status</th><th></th></tr>' + rows + '</table>';
    Array.prototype.forEach.call(box.querySelectorAll("[data-off]"), function (a) {
      a.onclick = async function () { await sb.from("invite_codes").update({ disabled: true }).eq("code", a.getAttribute("data-off")); loadCodes(); };
    });
  }
  function rand4() { var s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", o = ""; for (var i = 0; i < 4; i++) o += s[Math.floor(Math.random() * s.length)]; return o; }

  // ============================================================ date helpers
  function dayLabel(iso) { return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  function weekRange(wk) {
    var s = new Date(wk.startISO), e = new Date(s); e.setDate(e.getDate() + 6);
    var f = function (d) { return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }); };
    return f(s) + " – " + f(e);
  }

  // ============================================================ boot / auth glue
  async function signOut() { if (sb) await sb.auth.signOut(); state.user = null; state.isMember = false; state.isAdmin = false; _loaded = false; state.data = null; render(); }

  async function checkMembership() {
    var r = await sb.from("members").select("is_admin").eq("user_id", state.user.id).maybeSingle();
    state.isMember = !!(r.data); state.isAdmin = !!(r.data && r.data.is_admin);
  }
  async function boot() {
    if (state.mode === "cloud") {
      var s = await sb.auth.getSession();
      state.user = s.data.session ? s.data.session.user : null;
      if (state.user) { await checkMembership(); }
    }
    _loaded = false; state.data = null;
    render();
  }

  boot();
})();
