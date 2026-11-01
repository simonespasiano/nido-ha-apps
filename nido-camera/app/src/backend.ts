/**
 * Da dove arriva il video.
 * - Go2rtcBackend: avvia go2rtc, che riusa l'abbinamento HomeKit fatto in Home Assistant (sorgente "hass:")
 *   e offre diretta (MSE via WebSocket), foto e un flusso RTSP locale per registrare.
 * - DemoBackend: immagini di prova generate con ffmpeg, per provare l'app senza camera.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

export const STREAM = 'camera';
// porte non standard: con la rete dell'host non devono scontrarsi con il go2rtc interno di Home Assistant
export const GO2RTC_API_PORT = 18984;
const API = `http://127.0.0.1:${GO2RTC_API_PORT}`;

export interface BackendStatus { kind: 'go2rtc' | 'demo'; running: boolean; source: string | null; active: boolean; consumers: number; error: string | null }

export interface Backend {
  readonly kind: 'go2rtc' | 'demo';
  setSource(title: string | null): void;
  start(): void;
  status(): Promise<BackendStatus>;
  snapshot(timeoutMs?: number): Promise<Buffer>;
  /** Argomenti di ingresso per ffmpeg (registrazione). */
  inputArgs(): string[];
  /** Codifica da usare in registrazione: copia diretta del flusso o ricodifica (solo demo). */
  codecArgs(): string[];
  stop(): void;
}

function run(args: string[], input?: Buffer, timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('ffmpeg: tempo scaduto')); }, timeoutMs);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: ${err.trim().split('\n').at(-1) ?? code}`)); });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

export class Go2rtcBackend implements Backend {
  readonly kind = 'go2rtc' as const;
  private proc?: ChildProcess;
  private source: string | null = null;
  private lastError: string | null = null;
  private restarts = 0;
  private stopped = false;
  private logLines: string[] = [];

  constructor(private bin: string, private dataDir: string, private haConfigDir: string, private log: (m: string) => void, private debug = false) {}

  setSource(title: string | null) {
    if (title === this.source) return;
    this.source = title;
    if (this.proc) { this.writeConfig(); this.proc.kill(); } // si riavvia con la nuova configurazione
  }

  private writeConfig() {
    const q = (s: string) => JSON.stringify(s); // una stringa JSON è anche YAML valido
    const lines = [
      'api:', `  listen: "127.0.0.1:${GO2RTC_API_PORT}"`, '  origin: "*"',
      'rtsp:', '  listen: ":8554"',
      'webrtc:', '  listen: ""',
      'log:', `  level: ${this.debug ? 'debug' : 'info'}`,
      'hass:', `  config: ${q(this.haConfigDir)}`,
      'streams:',
    ];
    // l'audio HomeKit (AAC-ELD) non è riproducibile dai browser: go2rtc aggiunge una traccia AAC con ffmpeg
    if (this.source) lines.push(`  ${STREAM}:`, `    - ${q(`hass:${this.source}`)}`, `    - ${q(`ffmpeg:${STREAM}#audio=aac`)}`);
    else lines.push('  {}');
    writeFileSync(`${this.dataDir}/go2rtc.yaml`, lines.join('\n') + '\n');
  }

  start() {
    this.stopped = false;
    this.writeConfig();
    const p = spawn(this.bin, ['-config', `${this.dataDir}/go2rtc.yaml`], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    const onLine = (d: Buffer) => {
      for (const line of d.toString().split('\n').filter(Boolean)) {
        this.logLines.push(line); if (this.logLines.length > 200) this.logLines.shift();
        if (/ERR|WRN|error/i.test(line)) { this.lastError = line.replace(/^\S+\s+/, '').slice(0, 300); this.log(`go2rtc: ${this.lastError}`); }
        else if (this.debug) this.log(`go2rtc: ${line}`);
      }
    };
    p.stdout!.on('data', onLine); p.stderr!.on('data', onLine);
    p.on('error', e => { this.lastError = `go2rtc non avviato: ${e.message}`; this.log(this.lastError); });
    p.on('exit', code => {
      this.proc = undefined;
      if (this.stopped) return;
      this.restarts++;
      const wait = Math.min(60_000, 2000 * this.restarts);
      if (code) this.log(`go2rtc terminato (codice ${code}), riavvio tra ${wait / 1000} s`);
      setTimeout(() => this.start(), wait);
    });
  }

  stop() { this.stopped = true; this.proc?.kill(); }

  goLog() { return [...this.logLines]; }

  async status(): Promise<BackendStatus> {
    const base: BackendStatus = { kind: 'go2rtc', running: !!this.proc, source: this.source, active: false, consumers: 0, error: this.lastError };
    try {
      const r = await fetch(`${API}/api/streams`, { signal: AbortSignal.timeout(2000) });
      const j: any = await r.json();
      const s = j?.[STREAM];
      base.active = !!s?.producers?.some((p: any) => p.medias?.length || p.receivers?.length || p.state === 'open' || p.remote_addr);
      base.consumers = s?.consumers?.length ?? 0;
    } catch { base.running = false; }
    return base;
  }

  async snapshot(timeoutMs = 25_000): Promise<Buffer> {
    if (!this.source) throw new Error('Nessuna camera configurata');
    const r = await fetch(`${API}/api/frame.jpeg?src=${STREAM}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`go2rtc: ${(await r.text()).slice(0, 200) || r.status}`);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 1000) throw new Error('go2rtc: immagine vuota');
    return b;
  }

  inputArgs() { return ['-rtsp_transport', 'tcp', '-timeout', '15000000', '-i', `rtsp://127.0.0.1:8554/${STREAM}?video&audio=aac`]; }
  codecArgs() { return ['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy']; }
}

export class DemoBackend implements Backend {
  readonly kind = 'demo' as const;
  private source: string | null = 'Camera-Hub-G3-DEMO';
  setSource(t: string | null) { this.source = t; }
  start() { /* niente */ }
  stop() { /* niente */ }
  async status(): Promise<BackendStatus> { return { kind: 'demo', running: true, source: this.source, active: true, consumers: 0, error: null }; }
  private lavfi() { return ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=16000']; }
  async snapshot(): Promise<Buffer> {
    return run(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-frames:v', '1', '-q:v', '4', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1']);
  }
  inputArgs() { return ['-re', ...this.lavfi()]; }
  codecArgs() { return ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k']; }
  /** Diretta MJPEG di prova. */
  mjpeg(res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace;boundary=ffmpeg', 'Cache-Control': 'no-store' });
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=8', '-q:v', '6', '-f', 'mpjpeg', 'pipe:1']);
    p.stdout.pipe(res);
    res.on('close', () => p.kill('SIGKILL'));
  }
}
