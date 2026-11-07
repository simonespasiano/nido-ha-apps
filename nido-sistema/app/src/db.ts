import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export interface Sample { ts: number; cpu: number | null; rp1: number | null; ssd: number | null; rpm: number | null; fan: number | null; load: number | null; freq: number | null }

export class Store {
  private db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(`${dir}/nido-sistema.db`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS samples (ts INTEGER PRIMARY KEY, cpu REAL, rp1 REAL, ssd REAL, rpm REAL, fan REAL, load REAL, freq REAL);
      CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, user TEXT);
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
  addSample(s: Sample) {
    this.db.prepare(`INSERT OR REPLACE INTO samples (ts, cpu, rp1, ssd, rpm, fan, load, freq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(s.ts, s.cpu, s.rp1, s.ssd, s.rpm, s.fan, s.load, s.freq);
  }
  /** Campioni mediati su intervalli di `bucket` ms. */
  series(since: number, bucket: number): Sample[] {
    return this.db.prepare(`SELECT CAST(ts / ? AS INTEGER) * ? AS ts, AVG(cpu) AS cpu, AVG(rp1) AS rp1, AVG(ssd) AS ssd, AVG(rpm) AS rpm, AVG(fan) AS fan, AVG(load) AS load, AVG(freq) AS freq
      FROM samples WHERE ts >= ? GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts`).all(bucket, bucket, since, bucket) as any;
  }
  summary(since: number) {
    return this.db.prepare(`SELECT MIN(cpu) AS cpuMin, MAX(cpu) AS cpuMax, AVG(cpu) AS cpuAvg, AVG(fan) AS fanAvg, MAX(ssd) AS ssdMax, COUNT(*) AS n FROM samples WHERE ts >= ?`).get(since) as any;
  }
  log(kind: string, message: string, user: string | null = null) { this.db.prepare(`INSERT INTO log (ts, kind, message, user) VALUES (?, ?, ?, ?)`).run(Date.now(), kind, message, user); }
  logs(since: number) { return this.db.prepare(`SELECT * FROM log WHERE ts >= ? ORDER BY ts DESC LIMIT 300`).all(since) as any[]; }
  prune(days: number) {
    const cut = Date.now() - days * 86400_000;
    this.db.prepare(`DELETE FROM samples WHERE ts < ?`).run(cut);
    this.db.prepare(`DELETE FROM log WHERE ts < ?`).run(Date.now() - 90 * 86400_000);
  }
}
