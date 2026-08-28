/*
 * Widestrides engine — JavaScript port of the tested Swift engine.
 * Pöhlitz basic-endurance pace model (Lange/Pöhlitz 1995/2022) + Riegel race
 * prediction. Kept as pure functions so it can be unit-tested in Node and
 * reused unchanged in the web UI. Paces match the iOS app to the second.
 */
(function (root) {
  "use strict";

  // ---- Display units (km default; mi optional) -----------------------------
  var UNITS = "km";
  function setUnits(u) { UNITS = (u === "mi") ? "mi" : "km"; }
  function unitInfo() { return UNITS === "mi" ? { lab: "mi", m: 1609.344 } : { lab: "km", m: 1000 }; }
  function unitLabel() { return unitInfo().lab; }
  function toMeters(v) { return v * unitInfo().m; }        // value in current unit → metres
  function fromMeters(m) { return m / unitInfo().m; }      // metres → value in current unit
  function paceToPerKm(secPerUnit) { return secPerUnit * 1000 / unitInfo().m; }  // typed pace → sec/km

  // ---- Velocity & pace -----------------------------------------------------

  function velocityFromTest(meters, minutes) {
    if (minutes <= 0) return 0;
    return meters / (minutes * 60);           // m/s
  }

  // Snap to the table's 0.1 m/s grid, with a floor so a half-typed test can't
  // divide by zero (the old iOS crash).
  function roundToTable(v) {
    const snapped = Math.round(v * 10) / 10;
    return Math.max(0.1, snapped);
  }

  function paceFromVelocity(v) {          // seconds per km
    if (!(v > 0)) return Infinity;
    return 1000 / v;
  }

  function adjustPace(secPerKm, deltaSec) {
    return secPerKm + deltaSec;
  }

  function fmtMMSS(sec) {
    if (!isFinite(sec) || sec <= 0) return "—:—";
    const s = Math.round(sec);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  // Pace shown per the CURRENT display unit (km or mi).
  function fmtPace(secPerKm) { return fmtMMSS(secPerKm * (unitInfo().m / 1000)); }
  // 400 m split is always metric.
  function fmtPace400(secPerKm) { return fmtMMSS(secPerKm * 0.4); }

  // ---- Zones ---------------------------------------------------------------

  // Order: easiest → hardest (matches the iOS TrainingZone.allCases order).
  const ZONES = [
    { key: "regeneration",     title: "Regeneration",      pct: 70, band: 8, hr: 130 },
    { key: "enduranceEasy",    title: "Easy endurance",    pct: 85, band: 6, hr: 150 },
    { key: "enduranceSteady",  title: "Steady endurance",  pct: 90, band: 5, hr: 150 },
    { key: "threshold",        title: "Threshold / Tempo", pct: 97, band: 4, hr: 168 },
    { key: "extensiveInterval",title: "Extensive intervals", pct: null, band: 0, hr: null },
  ];
  const INTERVAL_FAST = -20, INTERVAL_SLOW = -10;   // s/km faster than 100%

  function zoneByKey(k) { return ZONES.find(z => z.key === k); }

  // Prescription for one zone from a reference velocity (m/s).
  function prescription(zoneKey, velocity) {
    const v = roundToTable(velocity);
    const refPace = paceFromVelocity(v);
    const z = zoneByKey(zoneKey);
    if (zoneKey === "extensiveInterval") {
      const fast = adjustPace(refPace, INTERVAL_FAST);
      const slow = adjustPace(refPace, INTERVAL_SLOW);
      return { zone: zoneKey, title: z.title, hr: null,
               pace: fast, paceSlow: slow, rangeFast: fast, rangeSlow: slow,
               isInterval: true };
    }
    const center = paceFromVelocity(v * (z.pct / 100));
    return {
      zone: zoneKey, title: z.title, hr: z.hr,
      pace: center,
      rangeFast: adjustPace(center, -z.band),
      rangeSlow: adjustPace(center, z.band),
      isInterval: false,
    };
  }

  function rangeText(rx) {
    if (rx.isInterval) return fmtPace(rx.pace) + "–" + fmtPace(rx.paceSlow);
    return fmtPace(rx.rangeFast) + "–" + fmtPace(rx.rangeSlow);
  }

  function allPrescriptions(velocity) {
    return ZONES.map(z => prescription(z.key, velocity));
  }

  function referencePace(velocity) { return paceFromVelocity(roundToTable(velocity)); }

  // ---- Race math (Riegel) --------------------------------------------------

  const RIEGEL = 1.06;
  // Predict time (s) at distance d2 from a known time t1 over d1.
  function riegelPredict(t1, d1, d2) { return t1 * Math.pow(d2 / d1, RIEGEL); }

  // Flexible solver: given any two of {distanceM, timeSec, paceSecPerKm}, return all three.
  function solveDTP({ distanceM, timeSec, paceSecPerKm }) {
    const has = x => typeof x === "number" && isFinite(x) && x > 0;
    if (has(distanceM) && has(timeSec)) {
      return { distanceM, timeSec, paceSecPerKm: timeSec / (distanceM / 1000) };
    }
    if (has(distanceM) && has(paceSecPerKm)) {
      return { distanceM, paceSecPerKm, timeSec: paceSecPerKm * (distanceM / 1000) };
    }
    if (has(timeSec) && has(paceSecPerKm)) {
      return { timeSec, paceSecPerKm, distanceM: (timeSec / paceSecPerKm) * 1000 };
    }
    return null;   // need at least two
  }

  function fmtHMS(sec) {
    if (!isFinite(sec) || sec < 0) return "—";
    const s = Math.round(sec);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = n => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  // ---- Race distances ------------------------------------------------------

  const RACE_PRESETS = [
    { key: "fiveK",   title: "5K",             meters: 5000 },
    { key: "tenK",    title: "10K",            meters: 10000 },
    { key: "tenMile", title: "10 Mile",        meters: 16093 },
    { key: "half",    title: "Half Marathon",  meters: 21097 },
    { key: "marathon",title: "Marathon",       meters: 42195 },
    { key: "ultra",   title: "Ultra (50K+)",   meters: 50000 },
  ];

  function isSpeedFocused(m) { return m <= 10000; }
  function peakLongRunMeters(m) {
    if (m < 7000) return 12000;
    if (m < 12000) return 15000;
    if (m < 18000) return 18000;
    if (m < 25000) return 22000;
    if (m < 45000) return 32000;
    return 38000;
  }
  function taperWeeks(m) { return m < 12000 ? 1 : (m < 25000 ? 2 : 3); }
  function km(m) {
    const k = m / 1000;
    return k === Math.round(k) ? String(k) : k.toFixed(1);
  }

  // ---- Workout formatting (mirrors WorkoutFormatting.swift) -----------------

  function timeText(seconds) {
    const s = Math.round(seconds);
    if (s < 60) return s + " s";
    if (s % 60 === 0) return (s / 60) + " min";
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " min";
  }
  function distanceText(m) {
    if (m >= 1000) {
      const info = unitInfo(), v = m / info.m;
      return (v === Math.round(v) ? String(v) : v.toFixed(1)) + " " + info.lab;
    }
    return Math.round(m) + " m";   // short reps stay metric
  }
  function stepDurationText(step) {
    if (step.durationType === "time") return timeText(step.durationValue);
    if (step.durationType === "distance") return distanceText(step.durationValue);
    return "until recovered";
  }
  function recoveryIsJog(step) { return step.restIsJog !== false; }  // default jog
  function isRecovery(step) { return step.kind === "recovery" || step.kind === "rest"; }
  function restText(step) {
    return stepDurationText(step) + " " + (recoveryIsJog(step) ? "jog" : "standing rest");
  }
  function stepPaceText(step) {
    if (!isFinite(step.paceHigh)) return null;
    if (isFinite(step.paceLow) && step.paceLow !== step.paceHigh) {
      return fmtPace(step.paceHigh) + "–" + fmtPace(step.paceLow);
    }
    return fmtPace(step.paceHigh);
  }
  function workText(step) {
    let t = stepDurationText(step);
    if (step.repeatCount > 1) t = step.repeatCount + " × " + t;
    const p = stepPaceText(step);
    if (p) t += " @ " + p + " /" + unitLabel();
    return t;
  }
  function summarizeSteps(steps) {
    const parts = [];
    let i = 0;
    while (i < steps.length) {
      const s = steps[i];
      if (s.kind === "warmup") { parts.push("WU " + stepDurationText(s)); i++; }
      else if (s.kind === "cooldown") { parts.push("CD " + stepDurationText(s)); i++; }
      else if (isRecovery(s)) { parts.push(restText(s)); i++; }
      else {
        let seg = workText(s);
        if (i + 1 < steps.length) {
          const n = steps[i + 1];
          if (isRecovery(n) && n.repeatCount === s.repeatCount) { seg += " w/ " + restText(n); i++; }
        }
        parts.push(seg); i++;
      }
    }
    return parts.join(" · ");
  }

  function step(kind, label, durationType, durationValue, opts) {
    opts = opts || {};
    return {
      kind, label, durationType, durationValue,
      repeatCount: opts.repeatCount || 1,
      paceLow: opts.paceLow, paceHigh: opts.paceHigh,
      hr: opts.hr, restIsJog: opts.restIsJog,
    };
  }

  // ---- Quality library (mirrors Quality.swift) -----------------------------

  function qualityRotation(speed) {
    return speed
      ? ["intervals", "fartlek", "cruiseIntervals", "tempo", "hills", "stridesEasy"]
      : ["tempo", "cruiseIntervals", "fartlek", "progression", "intervals", "stridesEasy"];
  }
  function qualityKind(weekIndex, phase, speed) {
    if (phase === "taper") return speed ? "intervals" : "cruiseIntervals";
    const rot = qualityRotation(speed);
    return rot[Math.max(0, weekIndex - 1) % rot.length];
  }
  const QUALITY_TITLE = {
    intervals: "Intervals", tempo: "Tempo Run", cruiseIntervals: "Cruise Intervals",
    fartlek: "Fartlek", progression: "Progression Run", hills: "Hill Reps", stridesEasy: "Easy + Strides",
  };

  function qualityWorkout(kind, phase, velocity) {
    const v = roundToTable(velocity);
    const wu = step("warmup", "Warm-up easy + strides", "time", 15 * 60);
    const cd = step("cooldown", "Cool-down easy", "time", 10 * 60);
    const iv = prescription("extensiveInterval", v);
    const thr = prescription("threshold", v);
    const easy = prescription("enduranceEasy", v);
    const steady = prescription("enduranceSteady", v);
    let title, steps;

    if (kind === "intervals") {
      const map = { base: [5, 800], build: [6, 1000], peak: [8, 1000], taper: [4, 600], raceWeek: [3, 400] };
      const [reps, m] = map[phase];
      steps = [wu,
        step("work", Math.round(m) + " m hard", "distance", m, { repeatCount: reps, paceLow: iv.paceSlow, paceHigh: iv.pace }),
        step("recovery", "Jog recovery", "distance", 200, { repeatCount: reps, restIsJog: true }),
        cd];
      title = QUALITY_TITLE.intervals;
    } else if (kind === "tempo") {
      const map = { base: 15, build: 20, peak: 25, taper: 12, raceWeek: 10 };
      const min = map[phase];
      steps = [wu,
        step("work", "Tempo @ threshold", "time", min * 60, { paceLow: adjustPace(thr.pace, 5), paceHigh: thr.pace, hr: 168 }),
        cd];
      title = QUALITY_TITLE.tempo;
    } else if (kind === "cruiseIntervals") {
      const map = { base: [4, 5], build: [5, 6], peak: [3, 10], taper: [3, 4], raceWeek: [2, 4] };
      const [reps, min] = map[phase];
      steps = [wu,
        step("work", min + " min cruise", "time", min * 60, { repeatCount: reps, paceLow: adjustPace(thr.pace, 5), paceHigh: thr.pace, hr: 168 }),
        step("recovery", "Float", "time", 90, { repeatCount: reps, restIsJog: true }),
        cd];
      title = QUALITY_TITLE.cruiseIntervals;
    } else if (kind === "fartlek") {
      const map = { base: [8, 60, 60], build: [10, 60, 60], peak: [6, 120, 90], taper: [6, 45, 60], raceWeek: [5, 40, 60] };
      const [reps, hard, e] = map[phase];
      steps = [wu,
        step("work", hard + " s surge", "time", hard, { repeatCount: reps, paceLow: iv.paceSlow, paceHigh: iv.pace }),
        step("recovery", e + " s easy", "time", e, { repeatCount: reps, restIsJog: true }),
        cd];
      title = QUALITY_TITLE.fartlek;
    } else if (kind === "progression") {
      const map = { base: [30, 10], build: [40, 15], peak: [45, 20], taper: [25, 8], raceWeek: [20, 6] };
      const [total, fast] = map[phase];
      steps = [
        step("work", "Easy build", "time", (total - fast) * 60, { paceLow: adjustPace(easy.pace, 15), paceHigh: steady.pace }),
        step("work", "Finish at threshold", "time", fast * 60, { paceLow: adjustPace(thr.pace, 6), paceHigh: thr.pace, hr: 168 }),
      ];
      title = QUALITY_TITLE.progression;
    } else if (kind === "hills") {
      const map = { base: [6, 45], build: [8, 45], peak: [10, 60], taper: [5, 30], raceWeek: [4, 30] };
      const [reps, secs] = map[phase];
      steps = [wu,
        step("work", secs + " s uphill hard", "time", secs, { repeatCount: reps }),
        step("recovery", "Jog down", "lapButton", 0, { repeatCount: reps, restIsJog: true }),
        cd];
      title = QUALITY_TITLE.hills;
    } else { // stridesEasy
      const [min, strides] = (phase === "taper" || phase === "raceWeek") ? [30, 6] : [40, 8];
      steps = [
        step("work", "Easy run", "time", min * 60, { paceLow: adjustPace(easy.pace, 30), paceHigh: easy.pace, hr: 150 }),
        step("work", "20 s stride", "time", 20, { repeatCount: strides }),
      ];
      title = QUALITY_TITLE.stridesEasy;
    }
    return { type: "quality", title, kind, zone: kindZone(kind), steps, detail: summarizeSteps(steps) };
  }
  function kindZone(kind) {
    if (kind === "tempo" || kind === "cruiseIntervals" || kind === "progression") return "threshold";
    if (kind === "stridesEasy") return "enduranceEasy";
    return "extensiveInterval";
  }

  // ---- Plan generator (mirrors PlanGenerator.swift) ------------------------

  function longRunMeters(i, phase, buildWeeks, peak) {
    const round500 = m => Math.round(m / 500) * 500;
    if (phase === "taper") {
      const taperWeekNo = i - buildWeeks;
      const f = [0.6, 0.45, 0.35][Math.min(Math.max(0, taperWeekNo - 1), 2)];
      return round500(peak * f);
    }
    const denom = Math.max(1, buildWeeks - 1);
    let frac = 0.55 + (1.0 - 0.55) * (i - 1) / denom;
    if (i % 3 === 0 && i !== buildWeeks) frac *= 0.82;
    return round500(peak * Math.min(frac, 1.0));
  }
  function phaseFor(i, total, buildWeeks, taperWeeksN) {
    if (taperWeeksN > 0) {
      if (i === total) return "raceWeek";
      if (i > buildWeeks) return "taper";
    }
    const third = Math.max(1, Math.floor(buildWeeks / 3));
    if (i <= third) return "base";
    if (i <= 2 * third) return "build";
    return "peak";
  }
  function longRunWorkout(meters, velocity, goal) {
    const v = roundToTable(velocity);
    const easy = prescription("enduranceEasy", v);
    const kmv = meters / 1000;
    const steps = [step("work", "Long run — relaxed & continuous", "distance", meters,
      { paceLow: adjustPace(easy.pace, 20), paceHigh: easy.pace, hr: 150 })];
    if (goal && !isSpeedFocused(goal.meters) && kmv >= 16) {
      const steady = prescription("enduranceSteady", v);
      steps.push(step("work", "Final 3 km steady", "distance", 3000,
        { paceLow: adjustPace(steady.pace, 8), paceHigh: steady.pace, hr: 150 }));
    }
    return { type: "longRun", title: "Long Run", zone: "enduranceEasy", plannedMeters: meters, steps, detail: summarizeSteps(steps) };
  }
  function easyWorkout(minutes, velocity, titleOverride, zoneKey) {
    const v = roundToTable(velocity);
    const rx = prescription(zoneKey, v);
    const steps = [step("work", titleOverride || "Easy run", "time", minutes * 60,
      { paceLow: adjustPace(rx.pace, 30), paceHigh: rx.pace, hr: rx.hr })];
    return { type: "easy", title: titleOverride || "Easy Run", zone: zoneKey,
             plannedSeconds: minutes * 60, steps, detail: summarizeSteps(steps) };
  }
  function raceWorkout(goal) {
    const gp = goal.goalTimeSec ? goal.goalTimeSec / (goal.meters / 1000) : null;
    const steps = [step("work", "RACE — " + goal.title, "distance", goal.meters,
      { paceLow: gp ? adjustPace(gp, 5) : undefined, paceHigh: gp || undefined })];
    let detail = "Race day — " + goal.title + ".";
    if (gp) detail += " Goal pace " + fmtPace(gp) + " /km.";
    return { type: "race", title: "🏁 " + goal.title, plannedMeters: goal.meters, steps, detail };
  }

  // profile: {name, testMeters, testMinutes, daysPerWeek, goal:{meters,title,dateISO,goalTimeSec}|null, startISO}
  function generatePlan(profile) {
    const velocity = velocityFromTest(profile.testMeters, profile.testMinutes);
    if (!(velocity > 0)) return { weeks: [], goal: profile.goal || null };
    const speed = profile.goal ? isSpeedFocused(profile.goal.meters) : true;
    const start = mondayOf(profile.startISO ? new Date(profile.startISO) : new Date());

    let totalWeeks, raceWeekIndex = null;
    if (profile.goal && profile.goal.dateISO) {
      const raceMonday = mondayOf(new Date(profile.goal.dateISO));
      const weeksBetween = Math.round((raceMonday - start) / (7 * 86400000));
      totalWeeks = Math.max(1, weeksBetween + 1);
      raceWeekIndex = totalWeeks;
    } else {
      totalWeeks = Math.max(3, profile.defaultWeeks || 8);
    }
    const taperN = profile.goal ? taperWeeks(profile.goal.meters) : 0;
    const buildWeeks = Math.max(1, totalWeeks - taperN);
    const peak = profile.goal ? peakLongRunMeters(profile.goal.meters) : 16000;

    const weeks = [];
    for (let i = 1; i <= totalWeeks; i++) {
      const weekStart = new Date(start.getTime() + (i - 1) * 7 * 86400000);
      const phase = phaseFor(i, totalWeeks, buildWeeks, taperN);
      const isRaceWeek = i === raceWeekIndex;
      const workouts = [];

      if (isRaceWeek && profile.goal) {
        const shakeouts = Math.min(2, Math.max(0, profile.daysPerWeek - 1));
        for (let k = 0; k < shakeouts; k++) {
          workouts.push(withDate(easyWorkout(25, velocity, "Shakeout", "regeneration"), addDays(weekStart, k * 2)));
        }
        workouts.push(withDate(raceWorkout(profile.goal), new Date(profile.goal.dateISO)));
      } else {
        const lm = longRunMeters(i, phase, buildWeeks, peak);
        workouts.push(withDate(longRunWorkout(lm, velocity, profile.goal), addDays(weekStart, 6)));   // long = Sunday
        const qk = qualityKind(i, phase, speed);
        workouts.push(withDate(qualityWorkout(qk, phase, velocity), addDays(weekStart, 2)));           // quality = Wed
        const easyMin = phase === "taper" ? 30 : 40;
        const easyDays = [0, 4].slice(0, Math.max(0, profile.daysPerWeek - 2));                        // Mon, Fri…
        for (const d of easyDays) workouts.push(withDate(easyWorkout(easyMin, velocity, null, "enduranceEasy"), addDays(weekStart, d)));
      }
      workouts.sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO));
      weeks.push({ index: i, startISO: iso(weekStart), phase, workouts });
    }
    return { weeks, goal: profile.goal || null, velocity };
  }

  // date helpers
  function mondayOf(d) {
    const x = new Date(d); const day = (x.getDay() + 6) % 7; // Mon=0
    x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - day); return x;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function iso(d) { return new Date(d).toISOString(); }
  function withDate(w, d) { w.dateISO = iso(d); return w; }

  // ---- Volume estimate (mirrors WorkoutFormatting.estimatedMeters) ---------

  function stepFactor(step) {
    if (step.kind === "work") return 0.95;
    if (step.kind === "warmup" || step.kind === "cooldown") return 0.80;
    return step.restIsJog !== false ? 0.70 : 0.0;   // recovery
  }
  function estimateMeters(steps, velocity) {
    if (!(velocity > 0) || !steps) return 0;
    var total = 0;
    steps.forEach(function (s) {
      var reps = Math.max(1, s.repeatCount || 1);
      if (s.durationType === "distance") total += reps * s.durationValue;
      else if (s.durationType === "time") total += reps * s.durationValue * velocity * stepFactor(s);
      else total += reps * 60 * velocity * 0.7;
    });
    return total;
  }
  function workoutMeters(w, velocity) {
    if (w.plannedMeters > 0) return w.plannedMeters;
    if (w.steps) return estimateMeters(w.steps, velocity);
    return 0;
  }
  function weekPlannedMeters(week, velocity) {
    return (week.workouts || []).reduce(function (a, w) { return a + workoutMeters(w, velocity); }, 0);
  }
  // How "done" a single session is: if the athlete typed an actual distance,
  // use actual ÷ planned (capped at 1); otherwise the Completed tick = 1/0.
  function sessionCompletion(w, velocity) {
    var planned = workoutMeters(w, velocity);
    if (w.actualMeters > 0 && planned > 0) return Math.min(1, w.actualMeters / planned);
    return w.completed ? 1 : 0;
  }
  function weekCompletion(week, velocity) {
    var wos = week.workouts || [];
    if (!wos.length) return 0;
    return wos.reduce(function (a, w) { return a + sessionCompletion(w, velocity); }, 0) / wos.length;
  }

  // Build a fresh session of any kind, paces from the athlete's VCR velocity.
  const SESSION_KINDS = [
    { k: "intervals", t: "Intervals" }, { k: "tempo", t: "Tempo Run" }, { k: "cruiseIntervals", t: "Cruise Intervals" },
    { k: "fartlek", t: "Fartlek" }, { k: "progression", t: "Progression" }, { k: "hills", t: "Hill Reps" },
    { k: "stridesEasy", t: "Easy + Strides" }, { k: "easy", t: "Easy Run" }, { k: "long", t: "Long Run" },
  ];
  function buildWorkoutOfKind(kind, phase, velocity, goal, plannedMeters) {
    if (kind === "easy") return easyWorkout(40, velocity, null, "enduranceEasy");
    if (kind === "long") return longRunWorkout(plannedMeters > 3000 ? plannedMeters : 12000, velocity, goal);
    return qualityWorkout(kind, phase || "build", velocity);
  }

  // ---- Which week is "now" --------------------------------------------------

  function currentWeekIndex(plan, nowDate) {
    var now = nowDate ? nowDate.getTime() : Date.now();
    var weeks = plan.weeks;
    for (var i = 0; i < weeks.length; i++) {
      var s = new Date(weeks[i].startISO).getTime(), e = s + 7 * 86400000;
      if (now >= s && now < e) return weeks[i].index;
    }
    var first = new Date(weeks[0].startISO).getTime();
    if (now < first) return weeks[0].index;
    return weeks[weeks.length - 1].index;   // past the end
  }

  // ---- Progress forecast (mirrors ProgressForecast.swift) -------------------

  function fmtShort(seconds) {
    var t = Math.round(Math.abs(seconds));
    if (t >= 3600) return Math.floor(t / 3600) + ":" + String(Math.floor((t % 3600) / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  }

  function forecast(plan, profile, cwi) {
    var goal = profile.goal;
    if (!goal || !(profile.testMeters > 0) || !(profile.testMinutes > 0) || !plan.weeks.length) return null;
    var v = velocityFromTest(profile.testMeters, profile.testMinutes);
    var t1 = profile.testMinutes * 60, d2 = goal.meters;
    var start = t1 * Math.pow(d2 / profile.testMeters, RIEGEL);
    var goalTime = goal.goalTimeSec || start * 0.95;
    var neededGain = Math.max(0, Math.min(0.25, (start - goalTime) / start));
    var weeks = plan.weeks.slice().sort(function (a, b) { return a.index - b.index; });
    var totalPlanned = Math.max(1, weeks.reduce(function (a, w) { return a + weekPlannedMeters(w, v); }, 0));
    var doneWeeks = weeks.filter(function (w) { return w.index <= cwi; });
    var pastQs = doneWeeks.map(function (w) { return weekCompletion(w, v); });
    var assumedFutureQ = pastQs.length ? Math.max(0, pastQs.reduce(function (a, b) { return a + b; }, 0) / pastQs.length) : 1.0;

    var pts = [], goalCum = 0, projCum = 0;
    weeks.forEach(function (w) {
      var weight = weekPlannedMeters(w, v) / totalPlanned;
      var q = w.index <= cwi ? weekCompletion(w, v) : assumedFutureQ;
      goalCum += neededGain * weight;
      projCum += neededGain * weight * q;
      pts.push({ week: w.index, goalSeconds: start * (1 - goalCum), projectedSeconds: start * (1 - projCum), isActual: w.index <= cwi });
    });
    var predictedFinish = pts.length ? pts[pts.length - 1].projectedSeconds : start;
    var cur = pts.find(function (p) { return p.week === cwi; });
    var onTrackDelta = predictedFinish - goalTime;
    var doneTot = 0, doneDone = 0;
    doneWeeks.forEach(function (w) { doneTot += w.workouts.length; doneDone += w.workouts.filter(function (x) { return x.completed; }).length; });
    var isOnTrack = onTrackDelta <= 5;
    var statusText = isOnTrack
      ? (onTrackDelta < -5 ? "On track — " + fmtShort(Math.abs(onTrackDelta)) + " ahead of goal" : "On track for your goal")
      : "Behind by " + fmtShort(Math.abs(onTrackDelta)) + " — more consistency needed";
    return {
      points: pts, startSeconds: start, goalSeconds: goalTime,
      predictedFinishSeconds: predictedFinish,
      currentPredictedSeconds: cur ? cur.projectedSeconds : predictedFinish,
      onTrackDelta: onTrackDelta, isOnTrack: isOnTrack, statusText: statusText,
      completionToDate: doneTot ? doneDone / doneTot : 0,
      goalTitle: goal.title, currentWeek: cwi, raceWeek: weeks[weeks.length - 1].index,
    };
  }

  // ---- Weekly / block review (mirrors ClaudeLink.swift) --------------------

  function weeklyReview(week, velocity) {
    var wos = week.workouts || [];
    var planned = wos.reduce(function (a, w) { return a + workoutMeters(w, velocity); }, 0);
    // Real logged distance when typed, else planned distance for ticked sessions.
    var actual = wos.reduce(function (a, w) {
      if (w.actualMeters > 0) return a + w.actualMeters;
      return a + (w.completed ? workoutMeters(w, velocity) : 0);
    }, 0);
    var total = wos.length, completed = wos.filter(function (w) { return w.completed || w.actualMeters > 0; }).length;
    var rpes = wos.map(function (w) { return w.rpe; }).filter(function (r) { return r > 0; });
    var avg = rpes.length ? rpes.reduce(function (a, b) { return a + b; }, 0) / rpes.length : null;
    // Average actual pace from sessions where both distance + time were typed.
    var pSec = 0, pKm = 0;
    wos.forEach(function (w) { if (w.actualMeters > 0 && w.actualSeconds > 0) { pSec += w.actualSeconds; pKm += w.actualMeters / 1000; } });
    var avgPace = pKm > 0 ? pSec / pKm : null;
    var notes = wos.filter(function (w) { return w.note; }).map(function (w) { return w.title + ": " + w.note; });
    return { index: week.index, phase: week.phase, plannedMeters: planned, actualMeters: actual, totalCount: total, completedCount: completed, averageRPE: avg, averagePace: avgPace, notes: notes, completionRate: total ? completed / total : 0 };
  }
  function blockReview(weeks, velocity) {
    var rows = weeks.map(function (w) { return weeklyReview(w, velocity); });
    var sum = function (f) { return rows.reduce(function (a, r) { return a + f(r); }, 0); };
    var allRpe = [];
    weeks.forEach(function (w) { (w.workouts || []).forEach(function (x) { if (x.rpe > 0) allRpe.push(x.rpe); }); });
    var notes = [];
    weeks.forEach(function (w) { (w.workouts || []).forEach(function (x) { if (x.note) notes.push("W" + w.index + " " + x.title + ": " + x.note); }); });
    return {
      rows: rows, weekCount: rows.length,
      totalPlannedMeters: sum(function (r) { return r.plannedMeters; }),
      totalActualMeters: sum(function (r) { return r.actualMeters; }),
      totalSessions: sum(function (r) { return r.totalCount; }),
      completedSessions: sum(function (r) { return r.completedCount; }),
      averageRPE: allRpe.length ? allRpe.reduce(function (a, b) { return a + b; }, 0) / allRpe.length : null,
      allNotes: notes,
      completionRate: sum(function (r) { return r.totalCount; }) ? sum(function (r) { return r.completedCount; }) / sum(function (r) { return r.totalCount; }) : 0,
    };
  }

  // ---- Claude hand-off prompts ---------------------------------------------

  function claudeUrl(prompt) { return "https://claude.ai/new?q=" + encodeURIComponent(prompt); }

  function planningPrompt(profile, plan) {
    var v = velocityFromTest(profile.testMeters, profile.testMinutes);
    var L = ["You are my running coach. Help me refine my training plan."];
    if (v > 0) L.push("My VCR reference velocity is " + roundToTable(v).toFixed(1) + " m/s (100% pace " + fmtPace(referencePace(v)) + "/km).");
    if (profile.goal) L.push("Goal: " + profile.goal.title + (profile.goal.dateISO ? " on " + new Date(profile.goal.dateISO).toDateString() : "") + (profile.goal.goalTimeSec ? ", target " + fmtHMS(profile.goal.goalTimeSec) : "") + ".");
    L.push("I train " + profile.daysPerWeek + " days/week (1 long, 1 quality, rest easy).");
    if (plan && plan.weeks[0]) {
      L.push("This week:");
      plan.weeks[0].workouts.forEach(function (w) { L.push("• " + w.title + ": " + w.detail); });
    }
    L.push("What would you adjust, and is my long-run progression sensible for the goal?");
    return L.join("\n");
  }
  function weeklyReviewPrompt(week, velocity) {
    var r = weeklyReview(week, velocity);
    var L = ["You are my running coach. Review my training week and suggest next steps.",
      "Week " + week.index + " (" + week.phase + "):",
      "Planned " + Math.round(r.plannedMeters / 1000) + " km, completed " + r.completedCount + "/" + r.totalCount + " sessions, actual " + Math.round(r.actualMeters / 1000) + " km."];
    if (r.averageRPE) L.push("Average RPE " + r.averageRPE.toFixed(1) + "/10.");
    (week.workouts || []).forEach(function (w) {
      var l = "• " + w.title + ": " + (w.completed ? "done" : "missed");
      if (w.rpe) l += ", RPE " + w.rpe;
      if (w.note) l += ' — "' + w.note + '"';
      L.push(l);
    });
    L.push("Was the load about right? What should I change next week?");
    return L.join("\n");
  }
  function blockReviewPrompt(weeks, velocity) {
    var b = blockReview(weeks, velocity);
    var L = ["You are my running coach. Review my last " + b.weekCount + " weeks of training as a block and tell me the trend.",
      "Totals: planned " + Math.round(b.totalPlannedMeters / 1000) + " km, completed " + b.completedSessions + "/" + b.totalSessions + " sessions (" + Math.round(b.completionRate * 100) + "%), actual " + Math.round(b.totalActualMeters / 1000) + " km."];
    if (b.averageRPE) L.push("Average RPE across the block: " + b.averageRPE.toFixed(1) + "/10.");
    L.push("");
    b.rows.forEach(function (r) {
      var l = "Week " + r.index + " (" + r.phase + "): " + r.completedCount + "/" + r.totalCount + " done, " + Math.round(r.actualMeters / 1000) + " km";
      if (r.averageRPE) l += ", RPE " + r.averageRPE.toFixed(1);
      L.push(l);
    });
    if (b.allNotes.length) { L.push(""); L.push("Notes I logged:"); b.allNotes.slice(0, 20).forEach(function (n) { L.push("• " + n); }); }
    L.push(""); L.push("Is my load trending up, flat, or down? Am I recovering well, and what should the next block focus on?");
    return L.join("\n");
  }

  const api = {
    setUnits, unitLabel, unitInfo, toMeters, fromMeters, paceToPerKm, fmtMMSS,
    velocityFromTest, roundToTable, paceFromVelocity, fmtPace, fmtPace400,
    estimateMeters, workoutMeters, weekPlannedMeters, weekCompletion, sessionCompletion, currentWeekIndex,
    buildWorkoutOfKind, SESSION_KINDS,
    forecast, fmtShort, weeklyReview, blockReview,
    claudeUrl, planningPrompt, weeklyReviewPrompt, blockReviewPrompt,
    prescription, allPrescriptions, rangeText, referencePace, ZONES,
    riegelPredict, solveDTP, fmtHMS, RACE_PRESETS, isSpeedFocused, km,
    peakLongRunMeters, taperWeeks,
    timeText, distanceText, stepDurationText, restText, stepPaceText, summarizeSteps,
    recoveryIsJog, isRecovery, qualityKind, qualityWorkout, generatePlan,
    QUALITY_TITLE,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
