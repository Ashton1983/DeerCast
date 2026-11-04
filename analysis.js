/* DeerCast analysis: turns sits + taps + weather into deer-per-hour by condition,
   and scores future days. Pure functions; runs on the phone. */
(function (root) {
  const A = root.Astro;
  const HOUR = 3600000, SLICE = 15 * 60000, PRIOR_HRS = 4;
  const DEER = { buck: 1, doe: 1, buckKill: 1, doeKill: 1 };
  const RUT = { chase: 1, fight: 1 };

  const order = (labels) => (l) => { const i = labels.indexOf(l); return i < 0 ? 99 : i; };
  const SUN_L = ["Before sunrise", "First hour after sunrise", "1–3 hrs after sunrise", "Midday", "1–3 hrs before sunset", "Last hour before sunset", "After sunset"];
  const ILL_L = ["Dark moon (under 33% lit)", "Partial moon (33–67%)", "Bright moon (over 67%)"];
  const POS_L = ["Moon overhead (±1 hr)", "Moon underfoot (±1 hr)", "Moonrise / moonset (±1 hr)", "Between moon events"];
  const TCH_L = ["8°+ colder than day before", "3–8° colder", "About the same (±3°)", "3–8° warmer", "8°+ warmer than day before"];
  const TMP_L = ["Below 35°F", "35–44°F", "45–54°F", "55–64°F", "65°F and up"];
  const PTR_L = ["Pressure rising", "Pressure steady", "Pressure falling"];
  const PRS_L = ["Below 29.80 inHg", "29.80–29.99 inHg", "30.00–30.19 inHg", "30.20+ inHg"];
  const WSP_L = ["Calm (0–4 mph)", "5–9 mph", "10–14 mph", "15+ mph"];
  const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const WDR_L = ["Calm wind"].concat(DIRS.map((d) => "Wind from " + d));
  const GST_L = ["No gusts", "Gusty"];
  const SEA_L = ["Early buck archery", "Archery only", "Alternative firearms", "Youth gun weekend", "Modern gun", "Closed", "Outside 2026-27 calendar"];

  function sunBucket(ms, st) {
    if (!st || st.sunrise == null || st.sunset == null) return null;
    const m = (ms - st.sunrise) / 60000, s = (st.sunset - ms) / 60000;
    if (m < 0) return SUN_L[0];
    if (s < 0) return SUN_L[6];
    if (m < 60) return SUN_L[1];
    if (s < 60) return SUN_L[5];
    if (m < 180) return SUN_L[2];
    if (s < 180) return SUN_L[4];
    return SUN_L[3];
  }
  const illBucket = (f) => (f < 0.33 ? ILL_L[0] : f <= 0.67 ? ILL_L[1] : ILL_L[2]);
  function tchBucket(x) {
    if (x == null || x === "" || isNaN(x)) return null;
    x = Number(x);
    return x <= -8 ? TCH_L[0] : x <= -3 ? TCH_L[1] : x < 3 ? TCH_L[2] : x < 8 ? TCH_L[3] : TCH_L[4];
  }
  const tmpBucket = (t) => (t == null ? null : t < 35 ? TMP_L[0] : t < 45 ? TMP_L[1] : t < 55 ? TMP_L[2] : t < 65 ? TMP_L[3] : TMP_L[4]);
  const prsBucket = (p) => (p == null ? null : p < 29.8 ? PRS_L[0] : p < 30 ? PRS_L[1] : p < 30.2 ? PRS_L[2] : PRS_L[3]);
  const wspBucket = (w) => (w == null ? null : w < 4.5 ? WSP_L[0] : w < 9.5 ? WSP_L[1] : w < 14.5 ? WSP_L[2] : WSP_L[3]);
  function wdrBucket(w, d) {
    if (w == null) return null;
    if (w < 3) return WDR_L[0];
    if (d == null) return null;
    if (typeof d === "string") return DIRS.indexOf(d) >= 0 ? "Wind from " + d : null;
    return "Wind from " + DIRS[Math.round((((d % 360) + 360) % 360) / 45) % 8];
  }
  const gstBucket = (h) => (h.wMph == null && h.gMph == null ? null : h.gMph != null && h.gMph >= 15 && (h.wMph == null || h.gMph - h.wMph >= 9) ? GST_L[1] : GST_L[0]);

  const FACTORS = [
    { key: "sun", label: "Time of day", sort: order(SUN_L) },
    { key: "moonPhase", label: "Moon phase", sort: order(A.PHASES) },
    { key: "moonIll", label: "Moon brightness", sort: order(ILL_L) },
    { key: "moonPos", label: "Moon position (solunar)", sort: order(POS_L) },
    { key: "tempChange", label: "Temperature change (last 24 hrs vs day before)", sort: order(TCH_L) },
    { key: "temp", label: "Temperature", sort: order(TMP_L) },
    { key: "pressTrend", label: "Barometric pressure trend (3 hrs)", sort: order(PTR_L) },
    { key: "pressure", label: "Barometric pressure", sort: order(PRS_L) },
    { key: "windSpeed", label: "Wind speed", sort: order(WSP_L) },
    { key: "windDir", label: "Wind direction", sort: order(WDR_L) },
    { key: "gust", label: "Gusts", sort: order(GST_L) },
    { key: "season", label: "Season segment", sort: order(SEA_L) },
    { key: "week", label: "Week of season", sort: null },
  ];

  function nearestHour(hours, t, field, maxMs) {
    let best = null, bd = Infinity;
    for (const h of hours) {
      const d = Math.abs(h.t - t);
      if (h[field] != null && d < bd) { bd = d; best = h; }
    }
    return best && bd <= maxMs ? best : null;
  }

  // Conditions at moment ms for a sit (sit-level caches in ctx).
  function conditions(ms, sit, ctx) {
    const c = {};
    const ill = A.moonIllumination(ms);
    c.moonPhase = A.PHASES[Math.round(ill.phase * 8) % 8];
    c.moonIll = illBucket(ill.fraction);
    c.season = A.seasonSegment(ms, sit.zone);
    const wk = A.weekOfSeason(ms);
    c.week = wk.label; ctx.weekSort[wk.label] = wk.sort;
    if (sit.lat != null && sit.lon != null) {
      const day = A.localMidnight(ms);
      if (!ctx.sun[day]) ctx.sun[day] = A.sunTimes(ms, sit.lat, sit.lon);
      c.sun = sunBucket(ms, ctx.sun[day]);
      if (!ctx.moonEv) ctx.moonEv = A.moonEvents(ctx.t0 - 14 * HOUR, ctx.t1 + 14 * HOUR, sit.lat, sit.lon);
      c.moonPos = A.moonPositionLabel(ms, ctx.moonEv);
    }
    const hours = sit.weather && sit.weather.hours;
    if (hours && hours.length) {
      c.tempChange = tchBucket(sit.tempChange24F);
      const ht = nearestHour(hours, ms, "tF", 1.5 * HOUR);
      c.temp = ht ? tmpBucket(ht.tF) : null;
      const hw = nearestHour(hours, ms, "wMph", 1.5 * HOUR);
      c.windSpeed = hw ? wspBucket(hw.wMph) : null;
      c.windDir = hw ? wdrBucket(hw.wMph, hw.wDir) : null;
      c.gust = hw ? gstBucket(hw) : null;
      const hp = nearestHour(hours, ms, "pInHg", 1.5 * HOUR), hp3 = nearestHour(hours, ms - 3 * HOUR, "pInHg", 1.5 * HOUR);
      c.pressure = hp ? prsBucket(hp.pInHg) : null;
      if (hp && hp3) { const d = hp.pInHg - hp3.pInHg; c.pressTrend = d > 0.02 ? PTR_L[0] : d < -0.02 ? PTR_L[2] : PTR_L[1]; }
    }
    return c;
  }

  const toMs = (v) => (typeof v === "number" ? v : Date.parse(v));

  function analyze(data, opts) {
    opts = opts || {};
    const deerTypes = opts.deer === "buck" ? { buck: 1, buckKill: 1 } : opts.deer === "doe" ? { doe: 1, doeKill: 1 } : DEER;
    const sits = data.sits.filter((s) => s.end && s.start && (!opts.lease || s.lease === opts.lease) && (!opts.hunter || s.hunter === opts.hunter));
    const sitIds = new Set(sits.map((s) => s.id));
    const events = data.events.filter((e) => !e.deleted && sitIds.has(e.sitId));
    const bySit = {};
    events.forEach((e) => (bySit[e.sitId] = bySit[e.sitId] || []).push(e));

    const acc = {}; FACTORS.forEach((f) => (acc[f.key] = {}));
    const rutWeek = {}, weekSort = {};
    let hours = 0, deer = 0, kills = 0, rut = 0, pending = 0;
    const counts = { buck: 0, doe: 0, buckKill: 0, doeKill: 0, chase: 0, fight: 0 };
    const harvest = [];

    for (const s of sits) {
      const t0 = toMs(s.start), t1 = toMs(s.end);
      if (!(t1 > t0)) continue;
      const sit = Object.assign({}, s, { lat: s.lat === "" ? null : s.lat, lon: s.lon === "" ? null : s.lon });
      if (!(sit.weather && sit.weather.hours && sit.weather.hours.length)) pending++;
      const ctx = { t0, t1, sun: {}, moonEv: null, weekSort };
      hours += (t1 - t0) / HOUR;
      for (let t = t0; t < t1; t += SLICE) {
        const len = Math.min(SLICE, t1 - t) / HOUR, c = conditions(t + Math.min(SLICE, t1 - t) / 2, sit, ctx);
        for (const f of FACTORS) {
          const b = c[f.key];
          if (b == null) continue;
          const cell = acc[f.key][b] = acc[f.key][b] || { hours: 0, n: 0, sits: new Set() };
          cell.hours += len; cell.sits.add(s.id);
        }
        const w = c.week; rutWeek[w] = rutWeek[w] || { hours: 0, n: 0 }; rutWeek[w].hours += len;
      }
      for (const e of bySit[s.id] || []) {
        counts[e.type] = (counts[e.type] || 0) + 1;
        const ms = toMs(e.time);
        if (RUT[e.type]) { rut++; const w = A.weekOfSeason(ms).label; rutWeek[w] = rutWeek[w] || { hours: 0, n: 0 }; rutWeek[w].n++; }
        if (e.type === "buckKill" || e.type === "doeKill") { kills++; harvest.push(Object.assign({ conditions: conditions(ms, sit, ctx) }, e)); }
        if (!deerTypes[e.type]) continue;
        deer++;
        const c = conditions(ms, sit, ctx);
        for (const f of FACTORS) {
          const b = c[f.key];
          if (b == null) continue;
          const cell = acc[f.key][b] = acc[f.key][b] || { hours: 0, n: 0, sits: new Set() };
          cell.n++;
        }
      }
    }

    const factors = FACTORS.map((f) => {
      const cells = acc[f.key];
      let H = 0, N = 0;
      Object.values(cells).forEach((c) => { H += c.hours; N += c.n; });
      const R = H > 0 ? N / H : 0;
      const sorter = f.sort || ((l) => weekSort[l] || 0);
      const buckets = Object.keys(cells).map((label) => {
        const c = cells[label];
        const rate = c.hours > 0 ? c.n / c.hours : 0;
        const shrunk = (c.n + PRIOR_HRS * R) / (c.hours + PRIOR_HRS);
        return { label, hours: c.hours, n: c.n, sits: c.sits.size, rate, lift: R > 0 ? shrunk / R : 1 };
      }).sort((a, b) => sorter(a.label) - sorter(b.label));
      return { key: f.key, label: f.label, baseline: R, hours: H, buckets };
    });

    const all = [];
    factors.forEach((f) => f.buckets.forEach((b) => {
      if (f.key === "week" || f.buckets.length < 2) return;
      if (b.hours >= 3 && b.sits >= 2) all.push(Object.assign({ factor: f.label, factorKey: f.key }, b));
    }));
    const top = all.filter((b) => b.lift > 1.05).sort((a, b) => b.lift - a.lift).slice(0, 6);
    const worst = all.filter((b) => b.lift < 0.95).sort((a, b) => a.lift - b.lift).slice(0, 3);
    const rutByWeek = Object.keys(rutWeek).map((l) => ({ label: l, hours: rutWeek[l].hours, n: rutWeek[l].n, rate: rutWeek[l].hours ? rutWeek[l].n / rutWeek[l].hours : 0, sort: weekSort[l] || 0 }))
      .sort((a, b) => a.sort - b.sort);

    return { totals: { sits: sits.length, hours, deer, rate: hours ? deer / hours : 0, kills, rut, pendingWeather: pending, counts },
      factors, top, worst, rutByWeek, harvest: harvest.sort((a, b) => toMs(b.time) - toMs(a.time)) };
  }

  function confidence(hours) { return hours < 5 ? "Early read" : hours < 15 ? "Fair" : "Solid"; }

  // ---------- planner ----------
  function lift(stats, key, label) {
    if (!label) return null;
    const f = stats.factors.find((x) => x.key === key);
    const b = f && f.buckets.find((x) => x.label === label);
    return b ? b : null;
  }
  // forecast: optional map ymd -> { tempChange, windMph, windDir }
  function planDays(stats, dayList, lat, lon, zone, forecast) {
    return dayList.map((dayMs) => {
      const noon = dayMs + 12 * HOUR, reasons = [];
      let score = 1;
      const use = (key, label, name) => {
        const b = lift(stats, key, label);
        if (!b || b.hours < 2) return;
        score *= b.lift;
        if (Math.abs(b.lift - 1) >= 0.1) reasons.push({ text: name ? name + ": " + label : label, lift: b.lift });
      };
      const ill = A.moonIllumination(noon);
      const phase = A.PHASES[Math.round(ill.phase * 8) % 8];
      use("moonPhase", phase);
      use("week", A.weekOfSeason(noon).label, "Week");
      let season = A.seasonSegment(noon, zone);
      if (/^Outside/.test(season)) season = null; // future seasons: dates not published yet
      const fc = forecast && forecast[A.ymd(noon)];
      if (fc) {
        use("tempChange", tchBucket(fc.tempChange));
        use("windSpeed", wspBucket(fc.windMph), "Morning wind");
        use("windDir", wdrBucket(fc.windMph, fc.windDir));
      }
      // moon events in shooting light
      let windows = [];
      if (lat != null && lon != null) {
        const st = A.sunTimes(noon, lat, lon);
        if (st.sunrise && st.sunset) {
          const lo = st.sunrise - 30 * 60000, hi = st.sunset + 30 * 60000;
          windows = A.moonEvents(dayMs, dayMs + 24 * HOUR, lat, lon).filter((e) => e.t >= lo && e.t <= hi).map((e) => {
            const label = e.kind === "overhead" ? "Moon overhead (±1 hr)" : e.kind === "underfoot" ? "Moon underfoot (±1 hr)" : "Moonrise / moonset (±1 hr)";
            const b = lift(stats, "moonPos", label);
            return { kind: e.kind, t: e.t, lift: b && b.hours >= 2 ? b.lift : null };
          });
        }
      }
      score = Math.max(0.4, Math.min(2.5, score));
      return { day: dayMs, score, phase, illum: Math.round(ill.fraction * 100), season, reasons: reasons.sort((a, b) => b.lift - a.lift), windows, forecast: !!fc };
    });
  }

  root.Analysis = { analyze, planDays, confidence, FACTORS, DEER, RUT, tchBucket };
})(typeof window !== "undefined" ? window : globalThis);
