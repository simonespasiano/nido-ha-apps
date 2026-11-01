import type { Store } from './db.js';
import type { Weather } from './weather.js';
import type { RoomView } from './engine.js';

const HOUR = 3_600_000;
const r1 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const r2 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

/** Punto di rugiada (formula di Magnus), °C. */
export function dewPoint(t: number, rh: number) {
  const g = Math.log(Math.max(1, rh) / 100) + (17.62 * t) / (243.12 + t);
  return (243.12 * g) / (17.62 - g);
}
/** Umidità assoluta, g/m³. */
export function absHumidity(t: number, rh: number) {
  return (216.7 * (rh / 100) * 6.112 * Math.exp((17.62 * t) / (243.12 + t))) / (273.15 + t);
}

function slopePerHour(pts: { ts: number; v: number }[]) {
  if (pts.length < 3) return null;
  const x0 = pts[0].ts;
  const xs = pts.map(p => (p.ts - x0) / HOUR), ys = pts.map(p => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let n = 0, d = 0;
  for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; }
  return d ? n / d : null;
}

/** Risolve un sistema lineare piccolo (eliminazione di Gauss con pivot). */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-9) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

interface Hourly { ts: number; tin: number; heat: number; tout: number | null }

/**
 * Modello termico della casa (una "resistenza-capacità" semplificata), stimato con i minimi quadrati sui dati orari:
 *   variazione oraria della media casa = a·(esterno − interno) + b·(quota di termosifoni caldi) + c
 * a = quanto la casa "sente" l'esterno (1/a è la costante di tempo, in ore), b = quanto scaldano i termosifoni, c = apporti fissi.
 */
function fitModel(rows: Hourly[]) {
  const data: { x: number[]; y: number }[] = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i], b = rows[i + 1];
    if (b.ts - a.ts !== HOUR || a.tout == null) continue;
    data.push({ x: [a.tout - a.tin, a.heat, 1], y: b.tin - a.tin });
  }
  const n = data.length;
  if (n < 24) return { ok: false as const, n, reason: `Servono almeno 24 ore complete di dati (ora ${n})` };
  const heatVar = (() => { const m = data.reduce((s, d) => s + d.x[1], 0) / n; return data.reduce((s, d) => s + (d.x[1] - m) ** 2, 0) / n; })();
  const usesHeat = heatVar > 1e-4;
  const cols = usesHeat ? [0, 1, 2] : [0, 2];
  const A = cols.map(i => cols.map(j => data.reduce((s, d) => s + d.x[i] * d.x[j], 0)));
  const bv = cols.map(i => data.reduce((s, d) => s + d.x[i] * d.y, 0));
  const sol = solve(A, bv);
  if (!sol) return { ok: false as const, n, reason: 'Dati troppo uniformi per stimare il modello' };
  const coef = [0, 0, 0];
  cols.forEach((c, k) => { coef[c] = sol[k]; });
  const [a, b, c] = coef;
  const pred = data.map(d => d.x[0] * a + d.x[1] * b + d.x[2] * c);
  const my = data.reduce((s, d) => s + d.y, 0) / n;
  const ssr = data.reduce((s, d, i) => s + (d.y - pred[i]) ** 2, 0);
  const sst = data.reduce((s, d) => s + (d.y - my) ** 2, 0);
  const sigma = Math.sqrt(ssr / Math.max(1, n - cols.length));
  if (a <= 0) return { ok: false as const, n, reason: 'Il modello non è ancora fisicamente sensato (la casa non risulta influenzata dall\'esterno): servono più giorni di dati' };
  return { ok: true as const, n, a, b, c, sigma, usesHeat, r2: sst > 0 ? 1 - ssr / sst : null, tau: 1 / a };
}

type Fit = ReturnType<typeof fitModel>;

function step(fit: Extract<Fit, { ok: true }>, tin: number, tout: number, heat: number) {
  return tin + fit.a * (tout - tin) + (fit.usesHeat ? fit.b * heat : 0) + fit.c;
}

export function houseDashboard(store: Store, weather: Weather, views: RoomView[], hours: number) {
  const now = Date.now();
  const bucket = hours <= 48 ? 10 * 60_000 : hours <= 168 ? 30 * 60_000 : HOUR;
  const history = store.houseSeries(now - hours * HOUR, now + 1, bucket);

  // --- adesso
  const live = views.filter(v => v.sample?.tRoom != null);
  const temps = live.map(v => v.sample!.tRoom as number);
  const hums = live.filter(v => v.sample?.hRoom != null).map(v => v.sample!.hRoom as number);
  const tAvg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
  const hAvg = hums.length ? hums.reduce((a, b) => a + b, 0) / hums.length : null;
  const recent = store.houseSeries(now - 3 * HOUR, now + 1, 10 * 60_000).filter(p => p.t != null).map(p => ({ ts: p.ts, v: p.t as number }));
  const sod = new Date(now); sod.setHours(0, 0, 0, 0);
  const t0 = sod.getTime();
  const mean = (arr: { t: number | null }[]) => { const v = arr.filter(p => p.t != null) as { t: number }[]; return v.length ? v.reduce((s, p) => s + p.t, 0) / v.length : null; };
  const today = store.houseSeries(t0, now + 1, HOUR);
  const yesterday = store.houseSeries(t0 - 86_400_000, t0, HOUR);
  const sameTimeYesterday = store.houseSeries(now - 86_400_000 - 30 * 60_000, now - 86_400_000 + 30 * 60_000, HOUR)[0]?.t ?? null;
  const rooms = live.map(v => {
    const t = v.sample!.tRoom as number, h = v.sample!.hRoom;
    return { id: v.room.id, name: v.room.name, t: r1(t), h: h == null ? null : Math.round(h),
      dew: h == null ? null : r1(dewPoint(t, h)), diff: tAvg == null ? null : r2(t - tAvg), heating: v.status?.heating ?? false };
  }).sort((a, b) => (b.t ?? 0) - (a.t ?? 0));

  // --- esterno
  const out = weather.nowValue(now);
  const obs = store.outdoor(now - hours * HOUR, now);
  const sensorObs = obs.some(o => o.source === 'sensore');
  const models = weather.models.filter(m => m.id !== 'best_match').map(m => ({
    id: m.id, name: m.name, error: m.error ?? null,
    points: m.points.filter(p => p.ts >= now - hours * HOUR && p.ts <= now + 48 * HOUR).map(p => ({ ts: p.ts, temp: p.temp, hum: p.hum })),
  }));
  const consensus = weather.consensus(now - 2 * HOUR, now + 48 * HOUR).map(c => ({ ts: c.ts, mean: r2(c.mean), min: c.min, max: c.max, n: c.n, hum: r1(c.hum) }));
  const next24 = consensus.filter(c => c.ts > now && c.ts <= now + 24 * HOUR);
  const modelTable = models.map(m => {
    const fut = m.points.filter(p => p.ts > now && p.ts <= now + 24 * HOUR && p.temp != null) as { ts: number; temp: number }[];
    const nowP = m.points.reduce<{ ts: number; temp: number | null } | null>((b, p) => !b || Math.abs(p.ts - now) < Math.abs(b.ts - now) ? p : b, null);
    const dev = fut.length && next24.length ? fut.reduce((s, p) => {
      const c = next24.find(x => x.ts === p.ts); return c?.mean != null ? s + Math.abs(p.temp - c.mean) : s;
    }, 0) / fut.length : null;
    return { id: m.id, name: m.name, error: m.error, now: nowP?.temp ?? null,
      min24: fut.length ? Math.min(...fut.map(p => p.temp)) : null, max24: fut.length ? Math.max(...fut.map(p => p.temp)) : null, devFromConsensus: r2(dev) };
  });
  const accuracy = weather.accuracy(7).map(a => ({ model: a.model, name: a.name, mae: r2(a.mae), bias: r2(a.bias), n: a.n, source: a.source }));

  // --- modello della casa (dati orari)
  const hourly: Hourly[] = [];
  const histH = store.houseSeries(now - 14 * 86_400_000, now + 1, HOUR);
  const obsH = new Map(store.outdoor(now - 14 * 86_400_000, now).map(o => [o.ts, o.temp]));
  for (const p of histH) {
    if (p.t == null) continue;
    const ts = p.ts - HOUR / 2;
    hourly.push({ ts, tin: p.t, heat: p.heat ?? 0, tout: obsH.get(ts) ?? null });
  }
  const fit = fitModel(hourly);
  let prediction: { ts: number; t: number; lo: number; hi: number }[] = [];
  let backtest: { model: number | null; persistenza: number | null; ieri: number | null; n: number } | null = null;
  if (fit.ok && tAvg != null) {
    // quota di termosifoni caldi tipica per ora del giorno (ultimi 7 giorni)
    const byHour = new Array(24).fill(0).map(() => ({ s: 0, n: 0 }));
    for (const h of hourly.filter(h => h.ts >= now - 7 * 86_400_000)) { const k = new Date(h.ts).getHours(); byHour[k].s += h.heat; byHour[k].n++; }
    let tin = tAvg;
    const start = Math.floor(now / HOUR) * HOUR;
    for (let k = 1; k <= 24; k++) {
      const ts = start + k * HOUR;
      const c = consensus.find(x => x.ts === ts - HOUR) ?? consensus.find(x => x.ts === ts);
      if (c?.mean == null) break;
      const bh = byHour[new Date(ts - HOUR).getHours()];
      tin = step(fit, tin, c.mean, bh.n ? bh.s / bh.n : 0);
      const band = 1.64 * fit.sigma * Math.sqrt(k);
      prediction.push({ ts, t: r2(tin)!, lo: r2(tin - band)!, hi: r2(tin + band)! });
    }
    // verifica a posteriori: previsione a 6 ore fatta in ciascuna delle ultime 24 ore, contro due metodi semplici
    const idx = new Map(hourly.map((h, i) => [h.ts, i]));
    const err = { model: [] as number[], pers: [] as number[], ieri: [] as number[] };
    for (const h of hourly.filter(h => h.ts >= now - 30 * HOUR && h.ts <= now - 6 * HOUR)) {
      const i = idx.get(h.ts)!;
      const tgt = hourly[i + 6];
      if (!tgt || tgt.ts !== h.ts + 6 * HOUR) continue;
      let t = h.tin, okRun = true;
      for (let k = 0; k < 6; k++) { const r = hourly[i + k]; if (r.tout == null) { okRun = false; break; } t = step(fit, t, r.tout, r.heat); }
      if (!okRun) continue;
      err.model.push(Math.abs(t - tgt.tin));
      err.pers.push(Math.abs(h.tin - tgt.tin));
      const y = idx.get(tgt.ts - 24 * HOUR);
      if (y != null) err.ieri.push(Math.abs(hourly[y].tin - tgt.tin));
    }
    const avg = (a: number[]) => a.length ? r2(a.reduce((s, x) => s + x, 0) / a.length) : null;
    backtest = { model: avg(err.model), persistenza: avg(err.pers), ieri: avg(err.ieri), n: err.model.length };
  }

  // --- consigli
  const advice: { level: 'info' | 'warn'; text: string }[] = [];
  const dew = tAvg != null && hAvg != null ? dewPoint(tAvg, hAvg) : null;
  const ahIn = tAvg != null && hAvg != null ? absHumidity(tAvg, hAvg) : null;
  const ahOut = out.temp != null && out.hum != null ? absHumidity(out.temp, out.hum) : null;
  if (hAvg != null && hAvg >= 65) advice.push({ level: 'warn', text: `Umidità media alta (${Math.round(hAvg)} %): rischio condensa e muffe su pareti fredde e angoli.` });
  else if (hAvg != null && hAvg <= 35) advice.push({ level: 'warn', text: `Aria secca (${Math.round(hAvg)} %): valuta un umidificatore o una ciotola d'acqua sui termosifoni.` });
  const humid = rooms.filter(r => r.h != null && r.h >= 65);
  if (humid.length && !(hAvg != null && hAvg >= 65)) advice.push({ level: 'warn', text: `Umidità alta in ${humid.map(r => r.name).join(', ')}: arieggia qualche minuto.` });
  if (ahIn != null && ahOut != null) {
    if (ahOut < ahIn - 1) advice.push({ level: 'info', text: `Fuori l'aria contiene meno acqua (${ahOut.toFixed(1).replace('.', ',')} g/m³ contro ${ahIn.toFixed(1).replace('.', ',')} in casa): aprire 5–10 minuti abbassa l'umidità.` });
    else if (ahOut > ahIn + 0.5) advice.push({ level: 'info', text: `Fuori l'aria è più umida che in casa: aprire le finestre ora non asciuga gli ambienti.` });
  }
  const spread = rooms.length > 1 ? (rooms[0].t ?? 0) - (rooms[rooms.length - 1].t ?? 0) : 0;
  if (spread >= 2) advice.push({ level: 'info', text: `Tra ${rooms[0].name} e ${rooms[rooms.length - 1].name} ci sono ${spread.toFixed(1).replace('.', ',')} °C di differenza.` });
  const nextMin = next24.length ? Math.min(...next24.map(c => c.mean ?? 99)) : null;
  if (nextMin != null && nextMin <= 3) advice.push({ level: 'info', text: `Nelle prossime 24 ore fuori si scende fino a ${nextMin.toFixed(1).replace('.', ',')} °C.` });

  return {
    updated: now, bucketMin: bucket / 60_000,
    now: {
      tAvg: r2(tAvg), hAvg: r1(hAvg), dew: r1(dew), ah: r1(ahIn),
      slope3h: r2(slopePerHour(recent)), todayAvg: r2(mean(today)), yesterdayAvg: r2(mean(yesterday)),
      sameTimeYesterday: r2(sameTimeYesterday), spread: r1(spread), rooms,
    },
    history: history.map(p => ({ ts: p.ts, t: r2(p.t), tmin: r2(p.tmin), tmax: r2(p.tmax), h: r1(p.h), heat: r2(p.heat) })),
    outdoor: { now: { temp: r1(out.temp), hum: out.hum == null ? null : Math.round(out.hum), ah: r1(ahOut), source: sensorObs ? 'sensore' : out.source },
      obs: obs.map(o => ({ ts: o.ts, temp: r1(o.temp), hum: o.hum == null ? null : Math.round(o.hum) })), source: sensorObs ? 'sensore' : 'modello' },
    forecast: { updated: weather.updated, errors: weather.errors, models, consensus, table: modelTable, accuracy },
    indoor: {
      model: fit.ok
        ? { ok: true, n: fit.n, r2: r2(fit.r2), sigma: r2(fit.sigma), tau: r1(fit.tau), lossPer10: r2(fit.a * 10), heatGain: fit.usesHeat ? r2(fit.b) : null, usesHeat: fit.usesHeat, c: r2(fit.c) }
        : { ok: false, n: fit.n, reason: fit.reason },
      prediction, backtest,
    },
    advice,
  };
}
