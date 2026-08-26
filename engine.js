/*
 * Widestrides engine — JavaScript port of the tested Swift engine.
 * Pöhlitz basic-endurance pace model (Lange/Pöhlitz 1995/2022) + Riegel race
 * prediction. Kept as pure functions so it can be unit-tested in Node and
 * reused unchanged in the web UI. Paces match the iOS app to the second.
 */
(function (root) {
  "use strict";

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

  function fmtPace(secPerKm) {            // "m:ss" per km
    if (!isFinite(secPerKm) || secPerKm <= 0) return "—:—";
    const s = Math.round(secPerKm);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + ":" + String(r).padStart(2, "0");
  }

  function fmtPace400(secPerKm) {
    if (!isFinite(secPerKm) || secPerKm <= 0) return "—:—";
    return fmtPace(secPerKm * 0.4);
  }

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
      const k = m / 1000;
      return (k === Math.round(k) ? String(k) : k.toFixed(1)) + " km";
    }
    return Math.round(m) + " m";
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
    if (p) t += " @ " + p + " /km";
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

  const api = {
    velocityFromTest, roundToTable, paceFromVelocity, fmtPace, fmtPace400,
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
