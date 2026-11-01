import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import type { AppEvent, Sample } from './types.js';

export class Store {
  private db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(`${dir}/nido-clima.db`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples (
        ts INTEGER NOT NULL, room TEXT NOT NULL,
        t_room REAL, h_room REAL, t_valve REAL, setpoint REAL,
        mode TEXT, heating INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_samples_room_ts ON samples(room, ts);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, room TEXT, kind TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);
      -- temperatura esterna oraria "osservata": dal sensore esterno se c'è, altrimenti dall'analisi del modello
      CREATE TABLE IF NOT EXISTS outdoor_obs (ts INTEGER PRIMARY KEY, temp REAL, hum REAL, source TEXT NOT NULL);
      -- previsioni dei modelli salvate a ogni aggiornamento, per misurarne l'accuratezza
      CREATE TABLE IF NOT EXISTS forecasts (
        made INTEGER NOT NULL, target INTEGER NOT NULL, model TEXT NOT NULL, temp REAL, hum REAL,
        PRIMARY KEY (made, target, model)
      );
      CREATE INDEX IF NOT EXISTS idx_forecasts_target ON forecasts(target);
    `);
    // colonne aggiunte nella 0.4.2: temperatura della valvola e temperatura interna, separate
    const cols = (this.db.prepare(`PRAGMA table_info(samples)`).all() as any[]).map(c => c.name);
    if (!cols.includes('t_valve_local')) this.db.exec(`ALTER TABLE samples ADD COLUMN t_valve_local REAL`);
    if (!cols.includes('t_valve_internal')) this.db.exec(`ALTER TABLE samples ADD COLUMN t_valve_internal REAL`);
  }

  insertSample(room: string, s: Sample) {
    this.db.prepare(
      `INSERT INTO samples (ts, room, t_room, h_room, t_valve, setpoint, mode, heating, t_valve_local, t_valve_internal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(s.ts, room, s.tRoom, s.hRoom, s.tValve, s.setpoint, s.mode, s.heating ? 1 : 0, s.tValveLocal ?? null, null);
  }

  history(room: string, since: number, maxPoints = 600, until = Number.MAX_SAFE_INTEGER): Sample[] {
    const rows = this.db.prepare(
      `SELECT ts, t_room, h_room, t_valve, setpoint, mode, heating, t_valve_local, t_valve_internal
       FROM samples WHERE room = ? AND ts >= ? AND ts <= ? ORDER BY ts`
    ).all(room, since, until) as any[];
    const step = Math.max(1, Math.ceil(rows.length / maxPoints));
    const out: Sample[] = [];
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i];
      out.push({
        ts: r.ts, tRoom: r.t_room, hRoom: r.h_room, tValve: r.t_valve,
        setpoint: r.setpoint, mode: r.mode, heating: r.heating === 1,
        tValveLocal: r.t_valve_local,
      });
    }
    return out;
  }

  insertEvent(e: AppEvent) {
    this.db.prepare(`INSERT INTO events (ts, room, kind, message) VALUES (?, ?, ?, ?)`)
      .run(e.ts, e.room, e.kind, e.message);
  }

  events(limit = 200, room?: string, since = 0, until = Number.MAX_SAFE_INTEGER): AppEvent[] {
    const sql = room
      ? `SELECT * FROM events WHERE room = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`
      : `SELECT * FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`;
    const args = room ? [room, since, until, limit] : [since, until, limit];
    return this.db.prepare(sql).all(...args) as unknown as AppEvent[];
  }

  /** Minuti con calorifero caldo nell'intervallo, stimati dagli intervalli tra campioni. */
  heatingMinutes(room: string, from: number, to: number): number {
    const rows = this.db.prepare(
      `SELECT ts, heating FROM samples WHERE room = ? AND ts >= ? AND ts < ? ORDER BY ts`
    ).all(room, from, to) as any[];
    let ms = 0;
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i].ts - rows[i - 1].ts;
      if (rows[i - 1].heating === 1 && gap < 15 * 60_000) ms += gap;
    }
    return Math.round(ms / 60_000);
  }

  stats(room: string, from: number, to: number) {
    const r = this.db.prepare(
      `SELECT AVG(t_room) AS avg_t, MIN(t_room) AS min_t, MAX(t_room) AS max_t, AVG(h_room) AS avg_h
       FROM samples WHERE room = ? AND ts >= ? AND ts < ?`
    ).get(room, from, to) as any;
    return {
      avgTemp: r?.avg_t ?? null, minTemp: r?.min_t ?? null,
      maxTemp: r?.max_t ?? null, avgHum: r?.avg_h ?? null,
    };
  }

  prune(days: number) {
    const limit = Date.now() - days * 86_400_000;
    this.db.prepare(`DELETE FROM samples WHERE ts < ?`).run(limit);
    this.db.prepare(`DELETE FROM events WHERE ts < ?`).run(limit);
  }

  getSetting<T>(key: string): T | null {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
    if (!r) return null;
    try { return JSON.parse(r.value) as T; } catch { return null; }
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value));
  }

  deleteSetting(key: string) {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  /** Cancella storico e diario. Le impostazioni (soglie) restano, salvo richiesta. */
  reset(withSettings = false) {
    this.db.exec(`DELETE FROM samples; DELETE FROM events; DELETE FROM forecasts;${withSettings ? ' DELETE FROM settings;' : ''}`);
    this.db.exec('VACUUM');
  }

  counts() {
    const s = this.db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS first FROM samples`).get() as any;
    const e = this.db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as any;
    return { samples: s.n as number, events: e.n as number, since: (s.first as number | null) ?? null };
  }

  /** Medie della casa per intervalli di `bucketMs`: media, minimo e massimo fra le stanze, umidità, quota di termosifoni caldi. */
  houseSeries(from: number, to: number, bucketMs: number) {
    const rows = this.db.prepare(
      `SELECT CAST(ts / ? AS INTEGER) * ? AS b, AVG(t_room) AS t, MIN(t_room) AS tmin, MAX(t_room) AS tmax,
              AVG(h_room) AS h, AVG(heating) AS heat, COUNT(DISTINCT room) AS rooms
       FROM samples WHERE ts >= ? AND ts < ? AND t_room IS NOT NULL GROUP BY b ORDER BY b`
    ).all(bucketMs, bucketMs, from, to) as any[];
    return rows.map(r => ({ ts: r.b + bucketMs / 2, t: r.t, tmin: r.tmin, tmax: r.tmax, h: r.h, heat: r.heat, rooms: r.rooms }));
  }

  upsertOutdoor(ts: number, temp: number | null, hum: number | null, source: string, overwrite = true) {
    this.db.prepare(overwrite
      ? `INSERT INTO outdoor_obs (ts, temp, hum, source) VALUES (?, ?, ?, ?)
         ON CONFLICT(ts) DO UPDATE SET temp = excluded.temp, hum = excluded.hum, source = excluded.source`
      : `INSERT OR IGNORE INTO outdoor_obs (ts, temp, hum, source) VALUES (?, ?, ?, ?)`).run(ts, temp, hum, source);
  }

  outdoor(from: number, to: number) {
    return this.db.prepare(`SELECT ts, temp, hum, source FROM outdoor_obs WHERE ts >= ? AND ts <= ? ORDER BY ts`)
      .all(from, to) as unknown as { ts: number; temp: number | null; hum: number | null; source: string }[];
  }

  saveForecasts(made: number, model: string, rows: { ts: number; temp: number | null; hum: number | null }[]) {
    const st = this.db.prepare(`INSERT OR REPLACE INTO forecasts (made, target, model, temp, hum) VALUES (?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try { for (const r of rows) st.run(made, r.ts, model, r.temp, r.hum); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** Errore delle previsioni con anticipo fra minLead e maxLead rispetto alla temperatura osservata. */
  forecastAccuracy(since: number, minLead: number, maxLead: number) {
    return this.db.prepare(
      `SELECT f.model AS model, AVG(ABS(f.temp - o.temp)) AS mae, AVG(f.temp - o.temp) AS bias, COUNT(*) AS n, MIN(o.source) AS source
       FROM forecasts f JOIN outdoor_obs o ON o.ts = f.target
       WHERE f.target >= ? AND f.target - f.made BETWEEN ? AND ? AND f.temp IS NOT NULL AND o.temp IS NOT NULL
       GROUP BY f.model`
    ).all(since, minLead, maxLead) as unknown as { model: string; mae: number; bias: number; n: number; source: string }[];
  }

  hasForecasts() {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM forecasts`).get() as any).n > 0;
  }

  pruneForecasts(days: number) {
    this.db.prepare(`DELETE FROM forecasts WHERE target < ?`).run(Date.now() - days * 86_400_000);
  }

  isEmpty(): boolean {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM samples`).get() as any;
    return r.n === 0;
  }
}
