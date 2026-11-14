/**
 * Umidità della casa: grandezze fisiche, rischio di condensa e muffa, profili orari, picchi ricorrenti
 * ed efficacia dell'arieggiamento, tutto ricavato dallo storico dei sensori.
 */
import type { Store } from './db.js';
import type { Room, Sample } from './types.js';
import { absHumidity, dewPoint } from './house.js';

export { absHumidity, dewPoint };

/** Pressione di vapore saturo (hPa), formula di Magnus. */
const es = (t: number) => 6.112 * Math.exp((17.62 * t) / (243.12 + t));

/**
 * Umidità relativa sulla superficie interna di una parete esterna. La temperatura della superficie
 * si stima con il fattore di temperatura fRsi: Ts = Tout + f·(Tin − Tout). Con f = 0,7 (muri non isolati,
 * angoli, dietro i mobili) l'80 % in superficie è la soglia oltre cui la muffa può crescere.
 */
export function surfaceRH(tin: number, rh: number, tout: number, f = 0.7) {
  const ts = tout + f * (tin - tout);
  return Math.min(100, (rh * es(tin)) / es(ts));
}

/** Umidità interna oltre cui, con questa temperatura esterna, le superfici fredde superano l'80 %. */
export function criticalRH(tin: number, tout: number, f = 0.7) {
  const ts = tout + f * (tin - tout);
  return Math.min(100, (80 * es(ts)) / es(tin));
}

const r1 = (v: number | null | undefined) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const HOUR = 3_600_000;

export interface Spike { ts: number; from: number; peak: number; rise: number; recoverMin: number | null }
export interface Pattern { hour: number; minute: number; days: number; ofDays: number; weekdays: boolean; weekends: boolean; rise: number; recoverMin: number | null; text: string }

/** Picchi: aumento di almeno `minRise` punti in 20 minuti. Il rientro è il tempo per tornare entro 2 punti dal valore di partenza. */
export function findSpikes(hist: Sample[], minRise = 7): Spike[] {
  const pts = hist.filter(s => s.hRoom != null) as (Sample & { hRoom: number })[];
  const out: Spike[] = [];
  let i = 0;
  while (i < pts.length) {
    // valore minimo nei 20 minuti precedenti
    let j = i;
    while (j > 0 && pts[i].ts - pts[j - 1].ts <= 20 * 60_000) j--;
    const base = Math.min(...pts.slice(j, i + 1).map(p => p.hRoom));
    if (pts[i].hRoom - base >= minRise) {
      // si sale fino al massimo, poi si cerca il rientro
      let k = i, peak = pts[i].hRoom, peakTs = pts[i].ts;
      while (k + 1 < pts.length && pts[k + 1].ts - pts[k].ts < 15 * 60_000 && pts[k + 1].hRoom >= peak - 0.5 && pts[k + 1].ts - pts[i].ts < 90 * 60_000) { k++; if (pts[k].hRoom > peak) { peak = pts[k].hRoom; peakTs = pts[k].ts; } }
      let rec: number | null = null, m = k;
      while (m + 1 < pts.length && pts[m + 1].ts - peakTs < 6 * HOUR) { m++; if (pts[m].hRoom <= base + 2) { rec = Math.round((pts[m].ts - peakTs) / 60_000); break; } }
      out.push({ ts: pts[i].ts - 10 * 60_000, from: Math.round(base), peak: Math.round(peak), rise: Math.round(peak - base), recoverMin: rec });
      // si salta oltre il picco
      while (i < pts.length && pts[i].ts < peakTs + 30 * 60_000) i++;
      continue;
    }
    i++;
  }
  return out;
}

const dayKey = (ts: number) => new Date(ts).toDateString();

/** Picchi che tornano più o meno alla stessa ora in molti giorni (es. la doccia del mattino). */
export function findPatterns(spikes: Spike[], days: number): Pattern[] {
  if (!spikes.length) return [];
  const used = new Set<number>();
  const out: Pattern[] = [];
  const mins = spikes.map(s => { const d = new Date(s.ts); return d.getHours() * 60 + d.getMinutes(); });
  const order = spikes.map((_, i) => i).sort((a, b) => mins[a] - mins[b]);
  for (const i of order) {
    if (used.has(i)) continue;
    const group = order.filter(j => !used.has(j) && Math.min(Math.abs(mins[j] - mins[i]), 1440 - Math.abs(mins[j] - mins[i])) <= 50);
    const ds = new Set(group.map(j => dayKey(spikes[j].ts)));
    if (ds.size < 3 || ds.size < days * 0.3) continue;
    group.forEach(j => used.add(j));
    const avg = Math.round(group.reduce((a, j) => a + mins[j], 0) / group.length);
    const wk = group.filter(j => { const d = new Date(spikes[j].ts).getDay(); return d > 0 && d < 6; }).length;
    const rise = Math.round(group.reduce((a, j) => a + spikes[j].rise, 0) / group.length);
    const recs = group.map(j => spikes[j].recoverMin).filter((x): x is number => x != null).sort((a, b) => a - b);
    const rec = recs.length ? recs[Math.floor(recs.length / 2)] : null;
    const weekdays = wk >= group.length * 0.9, weekends = wk <= group.length * 0.1;
    const freq = ds.size / days;
    const hh = Math.floor(avg / 60), mm = Math.round((avg % 60) / 15) * 15;
    const when = `${String(mm === 60 ? hh + 1 : hh).padStart(2, '0')}:${String(mm === 60 ? 0 : mm).padStart(2, '0')}`;
    out.push({
      hour: hh, minute: mm % 60, days: ds.size, ofDays: days, weekdays, weekends, rise, recoverMin: rec,
      text: `${weekdays ? 'Nei giorni feriali' : weekends ? 'Nel fine settimana' : freq >= 0.75 ? 'Quasi ogni giorno' : 'Spesso'} verso le ${when}: +${rise} punti${rec != null ? `, rientra in circa ${rec} minuti` : ', rientra lentamente'} (${ds.size} giorni su ${days})`,
    });
  }
  return out.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

export function roomHumidity(store: Store, room: Room, days: number, outdoorAt: (ts: number) => { temp: number | null; hum: number | null }, now = Date.now()) {
  const from = now - days * 86_400_000;
  const hist = store.history(room.id, from, 20_000).filter(s => s.hRoom != null && s.tRoom != null);
  const last = hist.at(-1) ?? null;
  if (!hist.length) return { room: room.id, name: room.name, available: false as const };
  const cur = { rh: last!.hRoom, t: last!.tRoom, ah: r1(absHumidity(last!.tRoom!, last!.hRoom!)), dew: r1(dewPoint(last!.tRoom!, last!.hRoom!)) };
  const out = outdoorAt(now);
  const srhNow = out.temp != null ? r1(surfaceRH(cur.t!, cur.rh!, out.temp)) : null;
  const crit = out.temp != null ? r1(criticalRH(cur.t!, out.temp)) : null;

  // durata delle fasce, pesata sul tempo fra campioni
  let tot = 0, t60 = 0, t70 = 0, t40 = 0, mould = 0;
  const hourW = { feriali: Array.from({ length: 24 }, () => [0, 0]), festivi: Array.from({ length: 24 }, () => [0, 0]) };
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], gap = hist[i].ts - a.ts;
    if (gap > 15 * 60_000) continue;
    const rh = a.hRoom as number;
    tot += gap; if (rh > 60) t60 += gap; if (rh > 70) t70 += gap; if (rh < 40) t40 += gap;
    const o = outdoorAt(a.ts);
    if (o.temp != null && surfaceRH(a.tRoom as number, rh, o.temp) >= 80) mould += gap;
    const d = new Date(a.ts), grp = d.getDay() === 0 || d.getDay() === 6 ? hourW.festivi : hourW.feriali;
    grp[d.getHours()][0] += rh * gap; grp[d.getHours()][1] += gap;
  }
  const pct = (x: number) => tot ? Math.round((x / tot) * 100) : null;
  const prof = (g: number[][]) => g.map(([s, w]) => (w ? r1(s / w) : null));
  const spikes = findSpikes(hist);
  const effDays = Math.max(1, Math.round((now - hist[0].ts) / 86_400_000));
  const patterns = findPatterns(spikes, effDays);
  const recs = spikes.map(s => s.recoverMin).filter((x): x is number => x != null).sort((a, b) => a - b);
  const mean = hist.reduce((a, s) => a + (s.hRoom as number), 0) / hist.length;
  // ultime 24 ore, campionate ogni 15 minuti per il grafico
  const day = store.history(room.id, now - 24 * HOUR, 96);
  return {
    room: room.id, name: room.name, available: true as const,
    now: { ...cur, surfaceRH: srhNow, criticalRH: crit },
    period: {
      days: effDays, mean: r1(mean), min: Math.min(...hist.map(s => s.hRoom as number)), max: Math.max(...hist.map(s => s.hRoom as number)),
      above60: pct(t60), above70: pct(t70), below40: pct(t40), mouldHours: Math.round(mould / HOUR),
    },
    profile: { feriali: prof(hourW.feriali), festivi: prof(hourW.festivi) },
    spikes: spikes.slice(-30).reverse(), spikesPerDay: r1(spikes.length / effDays),
    recoverMedian: recs.length ? recs[Math.floor(recs.length / 2)] : null,
    patterns,
    last24: day.map(s => ({ ts: s.ts, h: s.hRoom, t: s.tRoom })),
  };
}

/** Riepilogo della casa, confronto con l'esterno e consigli pratici. */
export function houseHumidity(store: Store, rooms: Room[], days: number,
  outdoorAt: (ts: number) => { temp: number | null; hum: number | null },
  forecast: { ts: number; temp: number | null; hum: number | null }[], now = Date.now()) {
  const list = rooms.map(r => roomHumidity(store, r, days, outdoorAt, now));
  const ok = list.filter((x): x is Extract<typeof x, { available: true }> => x.available);
  const out = outdoorAt(now);
  const ahOut = out.temp != null && out.hum != null ? r1(absHumidity(out.temp, out.hum)) : null;
  const ahIn = ok.length ? r1(ok.reduce((a, r) => a + (r.now.ah ?? 0), 0) / ok.length) : null;
  // carico di umidità: quanto vapore in più c'è dentro rispetto a fuori (2–3 g/m³ è normale in inverno)
  const load = ahIn != null && ahOut != null ? r1(ahIn - ahOut) : null;

  // ore migliori per arieggiare nelle prossime 24: aria esterna più secca e non troppo fredda
  const best = forecast.filter(p => p.ts > now && p.ts < now + 24 * HOUR && p.temp != null && p.hum != null)
    .map(p => ({ ts: p.ts, temp: p.temp as number, ah: absHumidity(p.temp as number, p.hum as number) }))
    .map(p => ({ ...p, score: p.ah + Math.max(0, 5 - p.temp) * 0.25 }))
    .sort((a, b) => a.score - b.score).slice(0, 3).sort((a, b) => a.ts - b.ts)
    .map(p => ({ ts: p.ts, temp: r1(p.temp), ah: r1(p.ah) }));

  const advice: { level: 'alto' | 'medio' | 'info'; text: string }[] = [];
  for (const r of ok) {
    if (r.now.surfaceRH != null && r.now.surfaceRH >= 80) advice.push({ level: 'alto', text: `${r.name}: con questa temperatura esterna le pareti più fredde arrivano al ${Math.round(r.now.surfaceRH)} % di umidità, sopra la soglia della muffa. Tieni l'umidità sotto il ${Math.round(r.now.criticalRH ?? 60)} % e non scostare i mobili dai muri di meno di 5 cm.` });
    if (r.period.mouldHours >= 12) advice.push({ level: 'medio', text: `${r.name}: ${r.period.mouldHours} ore di rischio condensa sulle pareti negli ultimi ${r.period.days} giorni.` });
    for (const p of r.patterns) if (p.rise >= 10 && (p.recoverMin == null || p.recoverMin > 45)) advice.push({ level: 'medio', text: `${r.name}: ${p.text.toLowerCase()}. Aprire 10 minuti subito dopo accorcia molto il rientro.` });
    if ((r.period.below40 ?? 0) > 30) advice.push({ level: 'info', text: `${r.name}: aria secca (sotto il 40 %) per il ${r.period.below40} % del tempo. Evita di arieggiare a lungo con il freddo; una bacinella sul termosifone aiuta poco, un umidificatore sì.` });
  }
  if (load != null && load > 4) advice.push({ level: 'medio', text: `In casa c'è molto più vapore che fuori (+${load.toString().replace('.', ',')} g/m³, normale fino a 3): serve arieggiare di più o usare le cappe in cucina e in bagno.` });
  if (best.length) advice.push({ level: 'info', text: `Ore migliori per arieggiare nelle prossime 24: ${best.map(b => new Date(b.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })).join(', ')} (aria esterna più secca).` });
  if (ahOut != null && ahIn != null && ahOut >= ahIn) advice.push({ level: 'info', text: 'Adesso fuori l\'aria contiene più vapore che dentro: aprire le finestre ora non abbassa l\'umidità.' });

  return { days, outdoor: { ...out, ah: ahOut }, house: { ah: ahIn, load }, best, advice, rooms: list };
}
