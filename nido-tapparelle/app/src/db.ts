import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export type Origin = 'nido' | 'utente' | 'automazione' | 'muro' | 'sistema';

export interface AppEvent {
  id?: number; ts: number; shutter: string | null; kind: string; message: string;
  origin?: Origin | null; who?: string | null;
}

export interface Move {
  ts: number; shutter: string; from: number | null; to: number | null; origin: Origin; who: string | null; reason: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(`${dir}/nido-tapparelle.db`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, shutter TEXT,
        kind TEXT NOT NULL, message TEXT NOT NULL, origin TEXT, who TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, shutter TEXT NOT NULL,
        from_pos REAL, to_pos REAL, origin TEXT NOT NULL, who TEXT, reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_moves_ts ON moves(ts);
      CREATE INDEX IF NOT EXISTS idx_moves_shutter_ts ON moves(shutter, ts);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  insertEvent(e: AppEvent) {
    this.db.prepare(`INSERT INTO events (ts, shutter, kind, message, origin, who) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(e.ts, e.shutter, e.kind, e.message, e.origin ?? null, e.who ?? null);
  }

  events(limit = 200, shutter?: string, kind?: string, since = 0): AppEvent[] {
    const where = ['ts >= ?']; const args: any[] = [since];
    if (shutter) { where.push('shutter = ?'); args.push(shutter); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    args.push(limit);
    return this.db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args) as unknown as AppEvent[];
  }

  insertMove(m: Move) {
    this.db.prepare(`INSERT INTO moves (ts, shutter, from_pos, to_pos, origin, who, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(m.ts, m.shutter, m.from, m.to, m.origin, m.who, m.reason);
  }

  moves(since: number, until = Number.MAX_SAFE_INTEGER, shutter?: string): Move[] {
    const rows = (shutter
      ? this.db.prepare(`SELECT * FROM moves WHERE shutter = ? AND ts >= ? AND ts < ? ORDER BY ts`).all(shutter, since, until)
      : this.db.prepare(`SELECT * FROM moves WHERE ts >= ? AND ts < ? ORDER BY ts`).all(since, until)) as any[];
    return rows.map(r => ({ ts: r.ts, shutter: r.shutter, from: r.from_pos, to: r.to_pos, origin: r.origin, who: r.who, reason: r.reason }));
  }

  /** Ultima posizione nota prima di un istante (per ricostruire le linee del tempo). */
  positionBefore(shutter: string, ts: number): number | null {
    const r = this.db.prepare(`SELECT to_pos FROM moves WHERE shutter = ? AND ts < ? ORDER BY ts DESC LIMIT 1`).get(shutter, ts) as any;
    return r?.to_pos ?? null;
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

  prune(days: number) {
    const limit = Date.now() - days * 86_400_000;
    this.db.prepare(`DELETE FROM events WHERE ts < ?`).run(limit);
    this.db.prepare(`DELETE FROM moves WHERE ts < ?`).run(limit);
  }

  counts() {
    const e = this.db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as any;
    const m = this.db.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS first FROM moves`).get() as any;
    return { events: e.n as number, moves: m.n as number, since: (m.first as number | null) ?? null };
  }

  reset() { this.db.exec(`DELETE FROM events; DELETE FROM moves;`); this.db.exec('VACUUM'); }
}
