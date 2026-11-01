import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Backend } from './backend.js';

export interface Recording { id: number; started: number; rel: string; stopAt: number; maxAt: number }

/** Una registrazione alla volta: parte al movimento, si allunga finché il movimento continua. */
export class Recorder {
  private proc?: ChildProcess;
  current?: Recording;
  private timer?: NodeJS.Timeout;
  private finishCb?: (r: Recording, bytes: number, error: string | null) => void;
  private stderr = '';

  constructor(private backend: Backend, private mediaDir: string, private log: (m: string) => void) {}

  get busy() { return !!this.current; }

  start(id: number, postSec: number, maxSec: number, done: (r: Recording, bytes: number, error: string | null) => void): Recording {
    const now = Date.now();
    const d = new Date(now);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const name = `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}-${id}.mp4`;
    const rel = `clip/${day}/${name}`;
    const full = join(this.mediaDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    this.current = { id, started: now, rel, stopAt: now + postSec * 1000, maxAt: now + maxSec * 1000 };
    this.finishCb = done;
    this.stderr = '';
    const args = ['-hide_banner', '-loglevel', 'error', '-y', ...this.backend.inputArgs(), ...this.backend.codecArgs(),
      '-t', String(maxSec + 5), '-movflags', '+faststart', '-f', 'mp4', `${full}.part`];
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc = p;
    p.stderr!.on('data', d => { this.stderr += d; if (this.stderr.length > 3000) this.stderr = this.stderr.slice(-3000); });
    p.on('error', e => { this.stderr += e.message; });
    p.on('close', code => this.finished(full, code));
    this.timer = setInterval(() => {
      const r = this.current;
      if (r && Date.now() >= Math.min(r.stopAt, r.maxAt)) this.stop();
    }, 500);
    return this.current;
  }

  /** Il movimento continua: sposta in avanti la fine della clip (senza superare la durata massima). */
  extend(postSec: number) { if (this.current) this.current.stopAt = Math.max(this.current.stopAt, Date.now() + postSec * 1000); }

  stop() {
    clearInterval(this.timer);
    const p = this.proc;
    if (!p || p.exitCode != null) return;
    try { p.stdin!.write('q'); p.stdin!.end(); } catch { /* già chiuso */ }
    setTimeout(() => { if (p.exitCode == null) p.kill('SIGINT'); }, 4000);
    setTimeout(() => { if (p.exitCode == null) p.kill('SIGKILL'); }, 10_000);
  }

  private finished(full: string, code: number | null) {
    clearInterval(this.timer);
    const r = this.current!;
    this.current = undefined; this.proc = undefined;
    let bytes = 0, error: string | null = null;
    try {
      bytes = statSync(`${full}.part`).size;
      if (bytes < 2000) { unlinkSync(`${full}.part`); bytes = 0; error = this.stderr.trim().split('\n').at(-1) || 'clip vuota'; }
      else renameSync(`${full}.part`, full);
    } catch { error = this.stderr.trim().split('\n').at(-1) || `ffmpeg terminato (${code})`; }
    if (error) this.log(`Registrazione non riuscita: ${error}`);
    this.finishCb?.(r, bytes, error);
  }
}
