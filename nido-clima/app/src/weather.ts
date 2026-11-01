import type { Store } from './db.js';

/** Modelli meteorologici confrontati (identificativi Open-Meteo). L'ordine fissa anche i colori nell'interfaccia. */
export const MODEL_NAMES: Record<string, string> = {
  icon_seamless: 'DWD ICON',
  ecmwf_ifs025: 'ECMWF IFS',
  gfs_seamless: 'NOAA GFS',
  meteofrance_seamless: 'Météo-France',
  ukmo_seamless: 'UK Met Office',
  italia_meteo_arpae_icon_2i: 'ItaliaMeteo ICON-2I',
};
export const DEFAULT_MODELS = Object.keys(MODEL_NAMES);
/** Modello usato come "osservato" quando non c'è un sensore esterno: la miglior combinazione scelta da Open-Meteo. */
const REFERENCE = 'best_match';

export interface Point { ts: number; temp: number | null; hum: number | null }
export interface ModelSeries { id: string; name: string; points: Point[]; error?: string }

const HOUR = 3_600_000;
const hourFloor = (ts: number) => Math.floor(ts / HOUR) * HOUR;

export class Weather {
  models: ModelSeries[] = [];
  updated = 0;
  errors: string[] = [];
  private sensorHour = { hour: 0, t: 0, h: 0, nt: 0, nh: 0 };

  constructor(
    private store: Store,
    private loc: () => { lat: number; lon: number } | null,
    private modelIds: string[],
    private hasSensor: () => boolean,
    private log: (m: string) => void,
    private demo: ((ts: number) => { temp: number; hum: number }) | null,
  ) {}

  start() {
    const run = () => this.refresh().catch(e => this.log(`Meteo: ${e}`));
    run();
    setInterval(run, HOUR);
  }

  /** Scarica (o simula) le previsioni di ogni modello, salva le previsioni e lo storico esterno. */
  async refresh() {
    const now = Date.now();
    const made = hourFloor(now);
    const ids = [REFERENCE, ...this.modelIds.filter(m => m !== REFERENCE)];
    const results: ModelSeries[] = [];
    this.errors = [];
    for (const id of ids) {
      try {
        const points = this.demo ? this.simulate(id, now) : await this.fetchModel(id);
        results.push({ id, name: id === REFERENCE ? 'Open-Meteo (riferimento)' : (MODEL_NAMES[id] ?? id), points });
      } catch (err) {
        const prev = this.models.find(m => m.id === id);
        results.push({ id, name: MODEL_NAMES[id] ?? id, points: prev?.points ?? [], error: String(err) });
        this.errors.push(`${MODEL_NAMES[id] ?? id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.models = results;
    this.updated = now;

    // demo: ricostruisce previsioni "fatte nei giorni scorsi" per poter mostrare subito l'accuratezza
    if (this.demo && !this.store.hasForecasts()) {
      for (let m = made - 72 * HOUR; m < made; m += 3 * HOUR) {
        for (const id of ids) this.store.saveForecasts(m, id, this.simulate(id, m).filter(p => p.ts > m && p.ts <= m + 48 * HOUR));
      }
    }

    for (const m of results) {
      if (m.error || !m.points.length) continue;
      const future = m.points.filter(p => p.ts > made && p.ts <= made + 72 * HOUR);
      if (future.length) this.store.saveForecasts(made, m.id, future);
      // le ore passate del riferimento diventano lo storico esterno, se manca un sensore
      if (m.id === REFERENCE && !this.hasSensor()) {
        for (const p of m.points) if (p.ts <= now) this.store.upsertOutdoor(p.ts, p.temp, p.hum, 'modello', false);
      }
    }
    this.store.pruneForecasts(40);
    if (this.errors.length) this.log(`Meteo, modelli non aggiornati: ${this.errors.join('; ')}`);
  }

  private async fetchModel(id: string): Promise<Point[]> {
    const l = this.loc();
    if (!l) throw new Error('posizione della casa sconosciuta');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${l.lat.toFixed(4)}&longitude=${l.lon.toFixed(4)}`
      + `&hourly=temperature_2m,relative_humidity_2m&models=${id}&past_days=2&forecast_days=3&timeformat=unixtime&timezone=GMT`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j: any = await res.json();
    const h = j.hourly;
    if (!h?.time) throw new Error('risposta senza dati orari');
    // con un solo modello le chiavi non hanno suffisso; per sicurezza si accettano entrambe le forme
    const t = h.temperature_2m ?? h[`temperature_2m_${id}`] ?? [];
    const rh = h.relative_humidity_2m ?? h[`relative_humidity_2m_${id}`] ?? [];
    const pts = (h.time as number[]).map((s, i) => ({ ts: s * 1000, temp: t[i] ?? null, hum: rh[i] ?? null }));
    if (!pts.some(p => p.temp != null)) throw new Error('nessun valore');
    return pts;
  }

  /** Modalità demo: ogni modello è la "verità" simulata con un suo errore sistematico e casuale. */
  private simulate(id: string, now: number): Point[] {
    const bias: Record<string, number> = {
      best_match: 0, icon_seamless: 0.4, ecmwf_ifs025: -0.2, gfs_seamless: 1.1,
      meteofrance_seamless: -0.6, ukmo_seamless: 0.2, italia_meteo_arpae_icon_2i: 0.1,
    };
    const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
    const out: Point[] = [];
    for (let ts = hourFloor(now) - 96 * HOUR; ts <= hourFloor(now) + 72 * HOUR; ts += HOUR) {
      const truth = this.demo!(ts);
      const lead = Math.max(0, (ts - now) / HOUR);
      const wobble = Math.sin(ts / 9e6 + seed) * (0.3 + lead * 0.03);
      out.push({ ts, temp: Math.round((truth.temp + (bias[id] ?? 0) * Math.min(1, lead / 6 + 0.3) + wobble) * 10) / 10,
        hum: Math.round(Math.min(100, Math.max(20, truth.hum + (bias[id] ?? 0) * 4 + wobble * 5))) });
    }
    return out;
  }

  /** Registra il sensore esterno, mediato per ora. */
  recordSensor(ts: number, temp: number | null, hum: number | null) {
    const h = hourFloor(ts);
    const s = this.sensorHour;
    if (s.hour !== h) { this.sensorHour = { hour: h, t: 0, h: 0, nt: 0, nh: 0 }; }
    const c = this.sensorHour;
    if (temp != null) { c.t += temp; c.nt++; }
    if (hum != null) { c.h += hum; c.nh++; }
    if (c.nt) this.store.upsertOutdoor(h, c.t / c.nt, c.nh ? c.h / c.nh : null, 'sensore');
  }

  /** Previsione di consenso (esclude il riferimento): media, minimo e massimo fra i modelli per ogni ora futura. */
  consensus(from: number, to: number) {
    const byTs = new Map<number, { t: number[]; h: number[] }>();
    for (const m of this.models) {
      if (m.id === REFERENCE) continue;
      for (const p of m.points) {
        if (p.ts < from || p.ts > to) continue;
        const e = byTs.get(p.ts) ?? { t: [], h: [] };
        if (p.temp != null) e.t.push(p.temp);
        if (p.hum != null) e.h.push(p.hum);
        byTs.set(p.ts, e);
      }
    }
    return [...byTs.entries()].sort((a, b) => a[0] - b[0]).filter(([, e]) => e.t.length).map(([ts, e]) => ({
      ts,
      mean: e.t.reduce((a, b) => a + b, 0) / e.t.length,
      min: Math.min(...e.t), max: Math.max(...e.t), n: e.t.length,
      hum: e.h.length ? e.h.reduce((a, b) => a + b, 0) / e.h.length : null,
    }));
  }

  /** Temperatura esterna "adesso": sensore, altrimenti riferimento, altrimenti consenso. */
  nowValue(now: number): { temp: number | null; hum: number | null; source: string } {
    const ref = this.models.find(m => m.id === REFERENCE)?.points ?? [];
    const near = ref.reduce<Point | null>((best, p) => !best || Math.abs(p.ts - now) < Math.abs(best.ts - now) ? p : best, null);
    if (near && Math.abs(near.ts - now) < 2 * HOUR) return { temp: near.temp, hum: near.hum, source: 'modello' };
    const c = this.consensus(now - HOUR, now + HOUR)[0];
    return { temp: c?.mean ?? null, hum: c?.hum ?? null, source: 'consenso' };
  }

  accuracy(days = 7) {
    const since = Date.now() - days * 86_400_000;
    const rows = this.store.forecastAccuracy(since, 1 * HOUR, 24 * HOUR);
    const sensor = this.hasSensor();
    return rows
      .filter(r => r.model !== REFERENCE || sensor)
      .map(r => ({ ...r, name: r.model === REFERENCE ? 'Open-Meteo (riferimento)' : (MODEL_NAMES[r.model] ?? r.model) }))
      .sort((a, b) => a.mae - b.mae);
  }
}
