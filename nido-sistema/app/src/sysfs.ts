/**
 * Lettura dell'hardware del Raspberry Pi da /sys e /proc, e scrittura della ventola.
 * Le radici sono configurabili per la demo, che usa un /sys simulato.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const read = (p: string): string | null => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
const num = (p: string): number | null => { const v = read(p); if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export interface Temps { cpu: number | null; rp1: number | null; ssd: number | null; others: { name: string; value: number }[] }

export interface Snapshot {
  ts: number;
  temps: Temps;
  fan: { rpm: number | null; pwm: number | null; percent: number | null; state: number | null; maxState: number | null };
  cpu: { freqMHz: number | null; maxMHz: number | null; load1: number | null; load5: number | null; cores: number; usage: number | null };
  memory: { totalMB: number; usedMB: number; percent: number } | null;
  disk: { totalGB: number; usedGB: number; percent: number } | null;
  uptime: number | null;
  power: { undervoltage: boolean | null; throttled: number | null; throttledFlags: string[] };
  model: string | null;
  ssd: { model: string | null } | null;
}

export interface FanControl { method: 'user_space' | 'disabled' | 'none'; writable: boolean; reason: string | null }

/** Bit di get_throttled del firmware Raspberry Pi. */
const THROTTLE_BITS: [number, string][] = [
  [0, 'Sottotensione adesso'], [1, 'Frequenza limitata adesso'], [2, 'Rallentato adesso'], [3, 'Limite di temperatura adesso'],
  [16, 'Sottotensione dall\'avvio'], [17, 'Frequenza limitata dall\'avvio'], [18, 'Rallentato dall\'avvio'], [19, 'Limite di temperatura dall\'avvio'],
];

export class Hardware {
  private hwmon = new Map<string, string>(); // nome → cartella
  private zone: string | null = null;
  private fanDev: string | null = null;
  private prevCpu: { idle: number; total: number } | null = null;
  private originalPolicy: string | null = null;
  private originalMode: string | null = null;
  control: FanControl = { method: 'none', writable: false, reason: null };
  private taken = false;
  /** Dove scrivere: /sys, oppure un sysfs montato a parte in scrittura quando /sys è in sola lettura. */
  private wroot: string | null = null;
  private w(path: string, value: string) { writeFileSync(this.wroot ? this.wroot + path.slice(this.sys.length) : path, value); }

  constructor(private sys = '/sys', private proc = '/proc', private diskPath = '/data') { this.discover(); }

  discover() {
    this.hwmon.clear();
    const hw = join(this.sys, 'class/hwmon');
    for (const d of safeList(hw)) {
      const name = read(join(hw, d, 'name'));
      if (name && !this.hwmon.has(name)) this.hwmon.set(name, join(hw, d));
    }
    const th = join(this.sys, 'class/thermal');
    this.zone = null; this.fanDev = null;
    for (const d of safeList(th)) {
      const type = read(join(th, d, 'type'));
      if (d.startsWith('thermal_zone') && (type === 'cpu-thermal' || type === 'cpu_thermal') && !this.zone) this.zone = join(th, d);
      if (d.startsWith('cooling_device') && type === 'pwm-fan') this.fanDev = join(th, d);
    }
    if (!this.zone) { const z = join(th, 'thermal_zone0'); if (existsSync(z)) this.zone = z; }
  }

  get fanHwmon() { return this.hwmon.get('pwmfan') ?? null; }
  hasFan() { return !!(this.fanHwmon || this.fanDev); }

  snapshot(): Snapshot {
    const temps: Temps = { cpu: null, rp1: null, ssd: null, others: [] };
    if (this.zone) { const t = num(join(this.zone, 'temp')); if (t != null) temps.cpu = t / 1000; }
    for (const [name, dir] of this.hwmon) {
      const t = num(join(dir, 'temp1_input'));
      if (t == null) continue;
      const c = t / 1000;
      if (name === 'cpu_thermal' && temps.cpu == null) temps.cpu = c;
      else if (name === 'rp1_adc') temps.rp1 = c;
      else if (name === 'nvme' || name === 'drivetemp') temps.ssd = c;
      else if (name !== 'cpu_thermal') temps.others.push({ name, value: c });
    }
    const fh = this.fanHwmon;
    const pwm = fh ? num(join(fh, 'pwm1')) : null;
    const fan = {
      rpm: fh ? num(join(fh, 'fan1_input')) : null, pwm,
      percent: pwm != null ? Math.round((pwm / 255) * 100) : null,
      state: this.fanDev ? num(join(this.fanDev, 'cur_state')) : null,
      maxState: this.fanDev ? num(join(this.fanDev, 'max_state')) : null,
    };
    const cur = num(join(this.sys, 'devices/system/cpu/cpu0/cpufreq/scaling_cur_freq'));
    const max = num(join(this.sys, 'devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq'));
    const la = read(join(this.proc, 'loadavg'))?.split(/\s+/).map(Number) ?? [];
    const cores = safeList(join(this.sys, 'devices/system/cpu')).filter(d => /^cpu\d+$/.test(d)).length || 4;
    const throttled = (() => {
      for (const p of ['devices/platform/soc/soc:firmware/get_throttled', 'devices/platform/soc@107c000000/soc@107c000000:firmware/get_throttled']) {
        const v = read(join(this.sys, p)); if (v != null) return parseInt(v, 16);
      }
      return null;
    })();
    const volt = this.hwmon.get('rpi_volt');
    const uv = volt ? num(join(volt, 'in0_lcrit_alarm')) : null;
    let nvmeModel: string | null = null;
    for (const d of safeList(join(this.sys, 'class/nvme'))) { nvmeModel = read(join(this.sys, 'class/nvme', d, 'model')); if (nvmeModel) break; }
    return {
      ts: Date.now(), temps, fan,
      cpu: { freqMHz: cur != null ? Math.round(cur / 1000) : null, maxMHz: max != null ? Math.round(max / 1000) : null, load1: la[0] ?? null, load5: la[1] ?? null, cores, usage: this.cpuUsage() },
      memory: this.memory(), disk: this.disk(),
      uptime: (() => { const u = read(join(this.proc, 'uptime')); return u ? Math.round(Number(u.split(' ')[0])) : null; })(),
      power: { undervoltage: uv != null ? uv > 0 : throttled != null ? !!(throttled & 1) : null, throttled, throttledFlags: throttled == null ? [] : THROTTLE_BITS.filter(([b]) => throttled & (1 << b)).map(([, l]) => l) },
      model: read(join(this.proc, 'device-tree/model'))?.replace(/\0/g, '') ?? read(join(this.sys, 'firmware/devicetree/base/model'))?.replace(/\0/g, '') ?? null,
      ssd: nvmeModel ? { model: nvmeModel } : null,
    };
  }

  private cpuUsage(): number | null {
    const line = read(join(this.proc, 'stat'))?.split('\n')[0];
    if (!line?.startsWith('cpu ')) return null;
    const v = line.split(/\s+/).slice(1).map(Number);
    const idle = (v[3] ?? 0) + (v[4] ?? 0), total = v.reduce((a, b) => a + b, 0);
    const prev = this.prevCpu; this.prevCpu = { idle, total };
    if (!prev || total <= prev.total) return null;
    return Math.max(0, Math.min(100, Math.round((1 - (idle - prev.idle) / (total - prev.total)) * 1000) / 10));
  }

  private memory() {
    const m = read(join(this.proc, 'meminfo'));
    if (!m) return null;
    const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(m)?.[1] ?? 0);
    const total = get('MemTotal'), avail = get('MemAvailable');
    if (!total) return null;
    return { totalMB: Math.round(total / 1024), usedMB: Math.round((total - avail) / 1024), percent: Math.round(((total - avail) / total) * 1000) / 10 };
  }

  private disk() {
    try {
      const s = statfsSync(this.diskPath);
      const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
      return { totalGB: Math.round(total / 1e9 * 10) / 10, usedGB: Math.round((total - free) / 1e9 * 10) / 10, percent: Math.round(((total - free) / total) * 1000) / 10 };
    } catch { return null; }
  }

  /** Il governatore termico del kernel smette di decidere la ventola; la decide l'app. */
  takeControl(): FanControl {
    if (this.taken) return this.control;
    if (!this.fanHwmon && !this.fanDev) return this.control = { method: 'none', writable: false, reason: 'Ventola non trovata (Active Cooler non collegato o driver pwm-fan assente)' };
    if (!this.zone) return this.control = { method: 'none', writable: false, reason: 'Zona termica della CPU non trovata' };
    const policyP = join(this.zone, 'policy'), modeP = join(this.zone, 'mode');
    this.originalPolicy = read(policyP); this.originalMode = read(modeP);
    const avail = read(join(this.zone, 'available_policies'))?.split(/\s+/) ?? [];
    const tries: [string, string, FanControl['method']][] = [];
    if (avail.includes('user_space')) tries.push([policyP, 'user_space', 'user_space']);
    tries.push([modeP, 'disabled', 'disabled']);
    const errors: string[] = [];
    const attempt = () => {
      for (const [path, value, method] of tries) {
        try { this.w(path, value); this.control = { method, writable: true, reason: null }; this.taken = true; return true; }
        catch (e: any) { errors.push(`${path.replace(this.sys, '/sys')}: ${e?.code ?? e?.message ?? e}`); }
      }
      return false;
    };
    if (attempt()) return this.control;
    // Home Assistant monta /sys in sola lettura in tutte le app: con il permesso SYS_ADMIN
    // si monta un secondo sysfs, in scrittura, in una cartella privata dell'app
    let remount = '';
    if (errors.some(x => x.includes('EROFS')) && this.sys === '/sys') {
      const dir = '/run/nido-sys';
      try {
        execFileSync('mkdir', ['-p', dir]);
        if (!existsSync(join(dir, 'class'))) execFileSync('mount', ['-t', 'sysfs', '-o', 'rw,nosuid,nodev,noexec', 'sysfs', dir], { stdio: 'pipe' });
        this.wroot = dir; remount = 'montato a parte in scrittura';
        if (attempt()) return this.control;
        this.wroot = null;
      } catch (e: any) { remount = `montaggio in scrittura non riuscito: ${String(e?.stderr ?? e?.message ?? e).trim().split('\n')[0]}`; }
    }
    const full = this.fullAccess();
    const hint = full === false
      ? 'L\'app non ha il permesso SYS_ADMIN che serve a scrivere in /sys: aggiorna l\'app all\'ultima versione e premi Arresta e poi Avvia.'
      : 'L\'app ha il permesso SYS_ADMIN ma il sistema non lascia comunque scrivere in /sys.';
    this.control = { method: 'none', writable: false, reason: `${hint} Dettaglio: ${errors.join('; ')}${remount ? ` · /sys ${remount}` : ''}` };
    return this.control;
  }

  /** L'app ha tutti i privilegi (Modalità protezione disattivata)? Si capisce dalle capability del processo. */
  fullAccess(): boolean | null {
    const st = read(join(this.proc, 'self/status'));
    const cap = st ? /^CapEff:\s+([0-9a-f]+)/m.exec(st)?.[1] : null;
    if (!cap) return null;
    return (BigInt('0x' + cap) & (1n << 21n)) !== 0n; // CAP_SYS_ADMIN
  }

  /** Restituisce la ventola al firmware/kernel. */
  releaseControl() {
    if (!this.taken || !this.zone) return;
    try { if (this.control.method === 'user_space' && this.originalPolicy) this.w(join(this.zone, 'policy'), this.originalPolicy); } catch { /* */ }
    try { if (this.control.method === 'disabled') this.w(join(this.zone, 'mode'), this.originalMode ?? 'enabled'); } catch { /* */ }
    this.taken = false;
  }

  get inControl() { return this.taken; }

  /** Imposta la ventola in percentuale (0–100). */
  setFan(percent: number) {
    const p = Math.max(0, Math.min(100, percent));
    const fh = this.fanHwmon;
    if (fh && existsSync(join(fh, 'pwm1'))) {
      this.w(join(fh, 'pwm1'), String(Math.round(p * 2.55)));
      return;
    }
    if (this.fanDev) {
      const max = num(join(this.fanDev, 'max_state')) ?? 4;
      this.w(join(this.fanDev, 'cur_state'), String(Math.round((p / 100) * max)));
    }
  }
}

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }
