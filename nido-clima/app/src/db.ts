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
    `);
  }

  insertSample(room: string, s: Sample) {
    this.db.prepare(
      `INSERT INTO samples (ts, room, t_room, h_room, t_valve, setpoint, mode, heating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(s.ts, room, s.tRoom, s.hRoom, s.tValve, s.setpoint, s.mode, s.heating ? 1 : 0);
  }

  history(room: string, since: number, maxPoints = 600): Sample[] {
    const rows = this.db.prepare(
      `SELECT ts, t_room, h_room, t_valve, setpoint, mode, heating
       FROM samples WHERE room = ? AND ts >= ? ORDER BY ts`
    ).all(room, since) as any[];
    const step = Math.max(1, Math.ceil(rows.length / maxPoints));
    const out: Sample[] = [];
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i];
      out.push({
        ts: r.ts, tRoom: r.t_room, hRoom: r.h_room, tValve: r.t_valve,
        setpoint: r.setpoint, mode: r.mode, heating: r.heating === 1,
      });
    }
    return out;
  }

  insertEvent(e: AppEvent) {
    this.db.prepare(`INSERT INTO events (ts, room, kind, message) VALUES (?, ?, ?, ?)`)
      .run(e.ts, e.room, e.kind, e.message);
  }

  events(limit = 200, room?: string, since = 0): AppEvent[] {
    const sql = room
      ? `SELECT * FROM events WHERE room = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`
      : `SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?`;
    const args = room ? [room, since, limit] : [since, limit];
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

  isEmpty(): boolean {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM samples`).get() as any;
    return r.n === 0;
  }
}
