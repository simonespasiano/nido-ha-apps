import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export interface CamEvent {
  id: number;
  ts: number;
  end: number | null;
  kind: 'movimento' | 'foto' | 'manuale';
  trigger: string | null;       // entità che l'ha generato
  clip: string | null;          // percorso relativo in MEDIA_DIR
  thumb: string | null;
  bytes: number;
  recorded: boolean;
  notified: boolean;
  note: string | null;          // perché non è stato registrato o notificato
}

export interface LogLine { id: number; ts: number; kind: string; message: string; user: string | null }

const row = (r: any): CamEvent => ({ ...r, recorded: !!r.recorded, notified: !!r.notified });

export class Store {
  private db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(`${dir}/nido-camera.db`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, end INTEGER, kind TEXT NOT NULL, trigger TEXT,
        clip TEXT, thumb TEXT, bytes INTEGER NOT NULL DEFAULT 0, recorded INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0, note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, user TEXT);
      CREATE INDEX IF NOT EXISTS idx_log_ts ON log(ts);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  getSetting<T>(key: string): T | null {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any;
    try { return r ? JSON.parse(r.value) : null; } catch { return null; }
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
  }

  addEvent(e: Partial<CamEvent> & { ts: number; kind: CamEvent['kind'] }): number {
    const r = this.db.prepare(`INSERT INTO events (ts, end, kind, trigger, clip, thumb, bytes, recorded, notified, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.ts, e.end ?? null, e.kind, e.trigger ?? null, e.clip ?? null, e.thumb ?? null, e.bytes ?? 0, e.recorded ? 1 : 0, e.notified ? 1 : 0, e.note ?? null);
    return Number(r.lastInsertRowid);
  }
  updateEvent(id: number, p: Partial<CamEvent>) {
    const cols: string[] = [], vals: any[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (!['end', 'clip', 'thumb', 'bytes', 'recorded', 'notified', 'note'].includes(k)) continue;
      cols.push(`${k} = ?`); vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null);
    }
    if (cols.length) this.db.prepare(`UPDATE events SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
  }
  event(id: number): CamEvent | null { const r = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id); return r ? row(r) : null; }
  events(since: number, until = Number.MAX_SAFE_INTEGER, limit = 500): CamEvent[] {
    return (this.db.prepare(`SELECT * FROM events WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?`).all(since, until, limit) as any[]).map(row);
  }
  oldestWithFiles(limit: number): CamEvent[] {
    return (this.db.prepare(`SELECT * FROM events WHERE clip IS NOT NULL OR thumb IS NOT NULL ORDER BY ts ASC LIMIT ?`).all(limit) as any[]).map(row);
  }
  deleteEvent(id: number) { this.db.prepare(`DELETE FROM events WHERE id = ?`).run(id); }
  totalBytes(): number { return Number((this.db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS b FROM events`).get() as any).b); }
  stats(since: number) {
    const r = this.db.prepare(`SELECT COUNT(*) AS n, SUM(recorded) AS rec, SUM(notified) AS notif, COALESCE(SUM(bytes),0) AS bytes FROM events WHERE ts >= ?`).get(since) as any;
    const byHour = new Array(24).fill(0);
    for (const e of this.db.prepare(`SELECT ts FROM events WHERE ts >= ? AND kind = 'movimento'`).all(since) as any[]) byHour[new Date(e.ts).getHours()]++;
    return { events: r.n ?? 0, recorded: r.rec ?? 0, notified: r.notif ?? 0, bytes: r.bytes ?? 0, byHour };
  }

  log(kind: string, message: string, user: string | null = null) { this.db.prepare(`INSERT INTO log (ts, kind, message, user) VALUES (?, ?, ?, ?)`).run(Date.now(), kind, message, user); }
  logs(since: number, limit = 300): LogLine[] { return this.db.prepare(`SELECT * FROM log WHERE ts >= ? ORDER BY ts DESC LIMIT ?`).all(since, limit) as any; }
  pruneLog(days: number) { this.db.prepare(`DELETE FROM log WHERE ts < ?`).run(Date.now() - days * 86400_000); }
}
