/* DeerCast astronomy + season engine.
   Sun and moon formulas follow the widely used SunCalc approach (V. Agafonkin, BSD),
   which is based on Astronomy Answers formulas. Accuracy: a minute or two for rise/set,
   ~1% for moon illumination: plenty for comparing hunting conditions. */
(function (root) {
  const PI = Math.PI, sin = Math.sin, cos = Math.cos, tan = Math.tan,
    asin = Math.asin, atan = Math.atan2, acos = Math.acos, rad = PI / 180;
  const dayMs = 86400000, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;

  const toDays = (ms) => ms / dayMs - 0.5 + J1970 - J2000;
  const rightAscension = (l, b) => atan(sin(l) * cos(e) - tan(b) * sin(e), cos(l));
  const declination = (l, b) => asin(sin(b) * cos(e) + cos(b) * sin(e) * sin(l));
  const altitude = (H, phi, dec) => asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
  const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
  const astroRefraction = (h) => { if (h < 0) h = 0; return 0.0002967 / tan(h + 0.00312536 / (h + 0.08901179)); };

  function sunCoords(d) {
    const M = rad * (357.5291 + 0.98560028 * d);
    const C = rad * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M));
    const L = M + C + rad * 102.9372 + PI;
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }
  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.22935 * d);
    const l = L + rad * 6.289 * sin(M), b = rad * 5.128 * sin(F), dt = 385001 - 20905 * cos(M);
    return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
  }
  function sunAltitude(ms, lat, lon) {
    const d = toDays(ms), c = sunCoords(d), H = siderealTime(d, rad * -lon) - c.ra;
    return altitude(H, rad * lat, c.dec) / rad;
  }
  function moonAltitude(ms, lat, lon) {
    const d = toDays(ms), c = moonCoords(d), H = siderealTime(d, rad * -lon) - c.ra;
    const h = altitude(H, rad * lat, c.dec);
    return (h + astroRefraction(h)) / rad;
  }
  function moonIllumination(ms) {
    const d = toDays(ms), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phi = acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra));
    const inc = atan(sdist * sin(phi), m.dist - sdist * cos(phi));
    const angle = atan(cos(s.dec) * sin(s.ra - m.ra), sin(s.dec) * cos(m.dec) - cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra));
    return { fraction: (1 + cos(inc)) / 2, phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / PI };
  }
  const PHASES = ["New moon", "Waxing crescent", "First quarter", "Waxing gibbous", "Full moon", "Waning gibbous", "Last quarter", "Waning crescent"];
  function moonPhaseName(ms) { return PHASES[Math.round(moonIllumination(ms).phase * 8) % 8]; }

  // Find sunrise/sunset for the local calendar day containing ms (device time zone).
  function crossings(fn, t0, t1, level, stepMin) {
    const out = [], step = stepMin * 60000;
    let pt = t0, pv = fn(pt) - level;
    for (let t = t0 + step; t <= t1; t += step) {
      const v = fn(t) - level;
      if ((pv < 0) !== (v < 0)) {
        let a = pt, b = t, va = pv;
        for (let i = 0; i < 20; i++) { const m = (a + b) / 2, vm = fn(m) - level; if ((va < 0) === (vm < 0)) { a = m; va = vm; } else b = m; }
        out.push({ t: (a + b) / 2, rising: pv < 0 });
      }
      pt = t; pv = v;
    }
    return out;
  }
  function localMidnight(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function sunTimes(ms, lat, lon) {
    const m0 = localMidnight(ms);
    const c = crossings((t) => sunAltitude(t, lat, lon), m0, m0 + dayMs, -0.833, 10);
    const rise = c.find((x) => x.rising), set = c.find((x) => !x.rising);
    return { sunrise: rise ? rise.t : null, sunset: set ? set.t : null };
  }
  // Moon events (rise, set, overhead = upper transit, underfoot = lower transit) between t0 and t1.
  function moonEvents(t0, t1, lat, lon) {
    const f = (t) => moonAltitude(t, lat, lon), step = 10 * 60000, ev = [];
    crossings(f, t0, t1, 0.133, 10).forEach((c) => ev.push({ t: c.t, kind: c.rising ? "rise" : "set" }));
    let a = f(t0 - step), b = f(t0);
    for (let t = t0 + step; t <= t1; t += step) {
      const c = f(t);
      if (b > a && b >= c) ev.push({ t: t - step, kind: "overhead" });
      if (b < a && b <= c) ev.push({ t: t - step, kind: "underfoot" });
      a = b; b = c;
    }
    return ev.sort((x, y) => x.t - y.t);
  }
  function fmtTime(ms) {
    if (ms == null) return "–";
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  // ---------- Arkansas 2026-27 deer seasons (AGFC, Deer Seasons and Limits by Zone) ----------
  const R = (a, b) => [a, b];
  const ALT_A = [R("2026-10-17", "2026-10-25"), R("2026-12-12", "2026-12-14")];
  const ALT_B = [R("2026-10-17", "2026-10-25"), R("2026-12-19", "2026-12-21")];
  const ALT_C = [R("2026-10-17", "2026-10-25")];
  const GUN_A = [R("2026-11-14", "2026-12-06"), R("2026-12-26", "2026-12-28")];
  const GUN_B = [R("2026-11-14", "2026-11-22"), R("2026-12-26", "2026-12-28")];
  const GUN_C = [R("2026-11-14", "2026-12-13"), R("2026-12-26", "2026-12-28")];
  const GUN_D = [R("2026-11-14", "2026-12-20"), R("2026-12-26", "2026-12-28")];
  const GUN_E = [R("2026-11-14", "2026-12-28")];
  const ZONES = {
    "1": [ALT_A, GUN_A], "2": [ALT_A, GUN_A], "3": [ALT_A, GUN_A], "4": [[], GUN_B], "4A": [ALT_B, GUN_C],
    "5": [[], GUN_B], "5A": [ALT_B, GUN_C], "6": [ALT_A, GUN_A], "7": [ALT_A, GUN_A], "8": [ALT_A, GUN_A],
    "9": [ALT_C, GUN_D], "10": [ALT_A, GUN_A], "11": [ALT_A, GUN_A], "12": [ALT_C, GUN_D], "13": [ALT_C, GUN_D],
    "14": [ALT_B, GUN_C], "15": [ALT_B, GUN_C], "16": [ALT_C, GUN_E], "16A": [ALT_C, GUN_E], "17": [ALT_C, GUN_E],
  };
  const ZONE_LIST = Object.keys(ZONES);
  const STATEWIDE = {
    early: [R("2026-08-29", "2026-08-31")],
    archery: [R("2026-09-26", "2027-02-28")],
    youth: [R("2026-11-07", "2026-11-08"), R("2027-01-02", "2027-01-03")],
  };
  function ymd(ms) {
    const d = new Date(ms);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  const inAny = (s, ranges) => ranges.some((r) => s >= r[0] && s <= r[1]);
  function seasonSegment(ms, zone) {
    const s = ymd(ms), z = ZONES[zone] || ZONES["1"];
    if (inAny(s, z[1])) return "Modern gun";
    if (inAny(s, STATEWIDE.youth)) return "Youth gun weekend";
    if (inAny(s, z[0])) return "Alternative firearms";
    if (inAny(s, STATEWIDE.early)) return "Early buck archery";
    if (inAny(s, STATEWIDE.archery)) return "Archery only";
    if (s < "2026-08-29" || s > "2027-02-28") return "Outside 2026-27 calendar";
    return "Closed";
  }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function weekOfSeason(ms) {
    const d = new Date(ms), day = d.getDate(), m = MONTHS[d.getMonth()];
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const a = day <= 7 ? 1 : day <= 14 ? 8 : day <= 21 ? 15 : 22, b = a === 22 ? last : a + 6;
    return { label: `${m} ${a}–${b}`, sort: d.getMonth() < 6 ? (d.getMonth() + 12) * 100 + a : d.getMonth() * 100 + a };
  }

  // Everything the app stamps on a tap (no network needed).
  function stamp(ms, lat, lon, zone) {
    const out = { season: seasonSegment(ms, zone), moonPhase: moonPhaseName(ms), moonIllumPct: Math.round(moonIllumination(ms).fraction * 100) };
    if (lat != null && lon != null) {
      const st = sunTimes(ms, lat, lon);
      out.minFromSunrise = st.sunrise ? Math.round((ms - st.sunrise) / 60000) : null;
      out.minToSunset = st.sunset ? Math.round((st.sunset - ms) / 60000) : null;
      out.moonPosition = moonPositionLabel(ms, moonEvents(ms - 14 * 3600000, ms + 14 * 3600000, lat, lon));
    }
    return out;
  }
  function moonPositionLabel(ms, events) {
    const near = (k) => events.some((e) => e.kind === k && Math.abs(e.t - ms) <= 3600000);
    if (near("overhead")) return "Moon overhead (±1 hr)";
    if (near("underfoot")) return "Moon underfoot (±1 hr)";
    if (near("rise") || near("set")) return "Moonrise / moonset (±1 hr)";
    return "Between moon events";
  }

  root.Astro = { sunAltitude, moonAltitude, moonIllumination, moonPhaseName, sunTimes, moonEvents, moonPositionLabel, fmtTime,
    seasonSegment, weekOfSeason, ZONE_LIST, stamp, ymd, localMidnight, PHASES };
})(typeof window !== "undefined" ? window : globalThis);
