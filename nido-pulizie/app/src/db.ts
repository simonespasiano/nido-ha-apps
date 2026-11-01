import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export interface Session {
  id: number;
  start: number;
  end: number | null;
  source: string;           // chi l'ha avviata: "NIDO", "Programma …", "Home Assistant", "App Narwal o robot"
  rooms: number[];          // stanze richieste (vuoto = non note)
  visited: number[];        // stanze in cui il robot è passato davvero
  roomNames: Record<string, string>;
  mode: number | null;
  area: number | null;      // m²
  duration: number | null;  // s di pulizia effettiva
  batteryStart: number | null;
  batteryEnd: number | null;
  result: string | null;
  path: [number, number][]; // traiettoria in pixel della mappa, ridotta
  mapId: number | null;
}

export interface AppEvent { id: number; ts: number; kind: string; message: string; user: string | null }

const J = (v: string | null, d: any) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

export class Store {
  private db: DatabaseSync;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(`${dir}/nido-pulizie.db`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start INTEGER NOT NULL, end INTEGER, source TEXT NOT NULL,
        rooms TEXT, visited TEXT, room_names TEXT, mode INTEGER,
        area REAL, duration INTEGER, battery_start REAL, battery_end REAL,
        result TEXT, report TEXT, path TEXT, map_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(start);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, user TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY, battery REAL, activity TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  getSetting<T>(key: string): T | null {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
    return r ? J(r.value, null) : null;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  addEvent(kind: string, message: string, user: string | null = null, ts = Date.now()) {
    this.db.prepare(`INSERT INTO events (ts, kind, message, user) VALUES (?, ?, ?, ?)`).run(ts, kind, message, user);
  }
  events(since: number, limit = 300): AppEvent[] {
    return this.db.prepare(`SELECT id, ts, kind, message, user FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(since, limit) as any;
  }

  addSample(ts: number, battery: number | null, activity: string) {
    this.db.prepare(`INSERT OR REPLACE INTO samples (ts, battery, activity) VALUES (?, ?, ?)`).run(ts, battery, activity);
  }
  samples(since: number) {
    return this.db.prepare(`SELECT ts, battery, activity FROM samples WHERE ts >= ? ORDER BY ts`).all(since) as { ts: number; battery: number | null; activity: string }[];
  }

  openSession(s: Omit<Session, 'id' | 'end' | 'area' | 'duration' | 'batteryEnd' | 'result' | 'path' | 'visited'>): number {
    const r = this.db.prepare(`INSERT INTO sessions (start, source, rooms, visited, room_names, mode, battery_start, map_id) VALUES (?, ?, ?, '[]', ?, ?, ?, ?)`)
      .run(s.start, s.source, JSON.stringify(s.rooms), JSON.stringify(s.roomNames), s.mode, s.batteryStart, s.mapId);
    return Number(r.lastInsertRowid);
  }

  updateSession(id: number, p: Partial<Session> & { report?: unknown }) {
    const cols: string[] = [], vals: any[] = [];
    const set = (c: string, v: any) => { cols.push(`${c} = ?`); vals.push(v); };
    if (p.end !== undefined) set('end', p.end);
    if (p.area !== undefined) set('area', p.area);
    if (p.duration !== undefined) set('duration', p.duration);
    if (p.batteryEnd !== undefined) set('battery_end', p.batteryEnd);
    if (p.result !== undefined) set('result', p.result);
    if (p.visited !== undefined) set('visited', JSON.stringify(p.visited));
    if (p.rooms !== undefined) set('rooms', JSON.stringify(p.rooms));
    if (p.roomNames !== undefined) set('room_names', JSON.stringify(p.roomNames));
    if (p.path !== undefined) set('path', JSON.stringify(p.path));
    if (p.report !== undefined) set('report', JSON.stringify(p.report));
    if (!cols.length) return;
    this.db.prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  private row(r: any, withPath: boolean): Session & { report?: unknown } {
    return {
      id: r.id, start: r.start, end: r.end, source: r.source, rooms: J(r.rooms, []), visited: J(r.visited, []),
      roomNames: J(r.room_names, {}), mode: r.mode, area: r.area, duration: r.duration, batteryStart: r.battery_start,
      batteryEnd: r.battery_end, result: r.result, path: withPath ? J(r.path, []) : [], mapId: r.map_id,
      ...(withPath ? { report: J(r.report, null) } : {}),
    };
  }

  sessions(since: number, until = Number.MAX_SAFE_INTEGER, limit = 500): Session[] {
    return (this.db.prepare(`SELECT * FROM sessions WHERE start >= ? AND start <= ? ORDER BY start DESC LIMIT ?`).all(since, until, limit) as any[]).map(r => this.row(r, false));
  }
  session(id: number) {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    return r ? this.row(r, true) : null;
  }
  openSessions(): Session[] {
    return (this.db.prepare(`SELECT * FROM sessions WHERE end IS NULL ORDER BY start`).all() as any[]).map(r => this.row(r, true));
  }

  /** Ultima volta in cui il robot è passato in ciascuna stanza. */
  lastCleaned(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const s of this.sessions(0, Number.MAX_SAFE_INTEGER, 2000)) {
      const ts = s.end ?? s.start;
      for (const id of s.visited.length ? s.visited : s.rooms) if (!(id in out) || out[id] < ts) out[id] = ts;
    }
    return out;
  }

  prune(days: number) {
    const cut = Date.now() - days * 86400_000;
    this.db.prepare(`DELETE FROM sessions WHERE start < ?`).run(cut);
    this.db.prepare(`DELETE FROM events WHERE ts < ?`).run(cut);
    this.db.prepare(`DELETE FROM samples WHERE ts < ?`).run(Date.now() - 30 * 86400_000);
  }

  counts() {
    const n = (t: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n as number;
    return { sessions: n('sessions'), events: n('events'), samples: n('samples') };
  }

  reset() { this.db.exec(`DELETE FROM sessions; DELETE FROM events; DELETE FROM samples;`); }
}
