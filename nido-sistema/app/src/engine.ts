import { EventEmitter } from 'node:events';
import type { Store } from './db.js';
import type { Hardware, Snapshot } from './sysfs.js';
import { CURVES, MODE_LABEL, Regulator, SAFETY_TEMP, curveAt, sanitizeCurve, type FanMode, type Point } from './fan.js';

export interface Options {
  notifiche: string[];
  avviso_temperatura: number;
  conserva_giorni: number;
  pubblica_in_home_assistant: boolean;
  debug: boolean;
}

export interface FanSettings { mode: FanMode; custom: Point[]; hyst: number; useHottest: boolean }
const DEFAULT: FanSettings = { mode: 'auto', custom: CURVES.bilanciata, hyst: 3, useHottest: false };

export interface HaApi {
  notify(service: string, title: string, message: string): Promise<void>;
}

export class Engine extends EventEmitter {
  settings: FanSettings;
  last: Snapshot;
  target: number | null = null;
  boostUntil: number | null = null;
  controlNote: string | null = null;
  private reg: Regulator;
  private lastSample = 0;
  private hotSince: number | null = null;
  private lastHotAlert = 0;
  private lastUv = false;
  private stallSince: number | null = null;
  private lastStallAlert = 0;

  constructor(public hw: Hardware, public store: Store, public opts: Options, private ha: HaApi | null, private log: (m: string) => void) {
    super();
    const s = store.getSetting<FanSettings>('fan') ?? DEFAULT;
    this.settings = { ...DEFAULT, ...s, custom: sanitizeCurve(s.custom) };
    this.reg = new Regulator(this.settings.hyst);
    this.last = hw.snapshot();
    setInterval(() => this.tick(), 5000);
    setInterval(() => store.prune(opts.conserva_giorni), 6 * 3600_000);
    this.tick();
  }

  curve(): Point[] {
    const m = this.settings.mode;
    if (m === 'personalizzata') return this.settings.custom;
    if (m === 'auto') return [[50, 29], [60, 49], [67.5, 69], [75, 98]]; // gradini del firmware, solo per il grafico
    return CURVES[m];
  }

  /** Temperatura che guida la ventola: la CPU, oppure la più alta fra CPU e chip RP1. */
  controlTemp(s: Snapshot): number | null {
    const t = s.temps;
    if (t.cpu == null) return null;
    return this.settings.useHottest && t.rp1 != null ? Math.max(t.cpu, t.rp1) : t.cpu;
  }

  setMode(mode: FanMode, user: string | null, custom?: Point[], hyst?: number, useHottest?: boolean) {
    if (!(mode in MODE_LABEL)) throw new Error('Modalità sconosciuta');
    this.settings = { mode, custom: custom ? sanitizeCurve(custom) : this.settings.custom, hyst: hyst != null ? Math.min(10, Math.max(1, Number(hyst))) : this.settings.hyst, useHottest: useHottest ?? this.settings.useHottest };
    this.reg = new Regulator(this.settings.hyst);
    this.store.setSetting('fan', this.settings);
    this.store.log('ventola', `Modalità ventola: ${MODE_LABEL[mode]}`, user);
    this.tick();
  }

  boost(minutes: number, user: string | null) {
    this.boostUntil = minutes > 0 ? Date.now() + minutes * 60_000 : null;
    this.store.log('ventola', minutes > 0 ? `Ventola al massimo per ${minutes} minuti` : 'Fine del massimo temporaneo', user);
    this.tick();
  }

  private tick() {
    const s = this.hw.snapshot();
    this.last = s;
    const now = Date.now();
    if (this.boostUntil && now > this.boostUntil) this.boostUntil = null;
    const wantControl = this.settings.mode !== 'auto' || !!this.boostUntil;
    const temp = this.controlTemp(s);
    try {
      if (!wantControl || temp == null) {
        if (this.hw.inControl) { this.hw.releaseControl(); this.log('Ventola restituita al firmware'); }
        this.target = null;
        this.controlNote = temp == null && wantControl ? 'Temperatura della CPU non leggibile: la ventola resta al firmware' : null;
      } else {
        if (!this.hw.inControl) {
          const c = this.hw.takeControl();
          if (!c.writable) {
            if (this.controlNote !== c.reason) this.log(`Controllo della ventola non possibile: ${c.reason}`);
            this.controlNote = c.reason; this.target = null;
          } else { this.log(`Controllo della ventola preso (${c.method === 'user_space' ? 'governatore user_space' : 'zona termica disattivata'})`); this.controlNote = null; }
        }
        if (this.hw.inControl) {
          const v = this.boostUntil ? 100 : this.reg.next(this.curve(), temp);
          this.target = temp >= SAFETY_TEMP ? 100 : v;
          this.hw.setFan(this.target);
        }
      }
    } catch (e) {
      this.log(`Errore nel comando della ventola: ${e instanceof Error ? e.message : e}`);
      try { this.hw.releaseControl(); } catch { /* */ }
      this.target = null;
    }
    if (now - this.lastSample >= 30_000) {
      this.lastSample = now;
      this.store.addSample({ ts: now, cpu: s.temps.cpu, rp1: s.temps.rp1, ssd: s.temps.ssd, rpm: s.fan.rpm, fan: s.fan.percent, load: s.cpu.usage ?? (s.cpu.load1 != null ? Math.min(100, (s.cpu.load1 / s.cpu.cores) * 100) : null), freq: s.cpu.freqMHz });
    }
    this.alerts(s, now);
    this.emit('tick', s);
  }

  private alerts(s: Snapshot, now: number) {
    const t = s.temps.cpu;
    if (t != null && t >= this.opts.avviso_temperatura) {
      this.hotSince ??= now;
      if (now - this.hotSince > 120_000 && now - this.lastHotAlert > 3600_000) {
        this.lastHotAlert = now;
        this.alert('Raspberry caldo', `CPU a ${t.toFixed(1)} °C da oltre 2 minuti (ventola ${s.fan.percent ?? '?'}%, ${s.fan.rpm ?? '?'} giri/min)`);
      }
    } else this.hotSince = null;
    const uv = !!s.power.undervoltage;
    if (uv && !this.lastUv) this.alert('Alimentazione insufficiente', 'Il Raspberry segnala sottotensione: controlla alimentatore e cavo (serve quello da 27 W per il Pi 5)');
    this.lastUv = uv;
    // ventola comandata ma ferma: forse staccata o bloccata
    if (s.fan.pwm != null && s.fan.pwm > 100 && s.fan.rpm === 0) {
      this.stallSince ??= now;
      if (now - this.stallSince > 30_000 && now - this.lastStallAlert > 6 * 3600_000) { this.lastStallAlert = now; this.alert('Ventola ferma', 'La ventola dovrebbe girare ma risulta a 0 giri/min: controlla che sia collegata'); }
    } else this.stallSince = null;
  }

  private alert(title: string, message: string) {
    this.store.log('avviso', `${title}: ${message}`);
    this.log(`Avviso: ${title} · ${message}`);
    this.emit('alert', title, message);
    for (const svc of this.opts.notifiche) this.ha?.notify(svc, title, message).catch(e => this.log(`Notifica a ${svc} non riuscita: ${e instanceof Error ? e.message : e}`));
  }

  async testNotify(user: string | null) {
    if (!this.opts.notifiche.length) throw new Error('Nessun servizio nell\'opzione notifiche');
    for (const svc of this.opts.notifiche) await this.ha?.notify(svc, 'NIDO Sistema · prova', `CPU a ${this.last.temps.cpu?.toFixed(1) ?? '?'} °C, ventola ${this.last.fan.percent ?? '?'}%`);
    this.store.log('avviso', 'Notifica di prova inviata', user);
  }

  expected(temp: number) { return this.settings.mode === 'auto' ? null : Math.round(curveAt(this.curve(), temp)); }

  shutdown() { if (this.hw.inControl) this.hw.releaseControl(); }
}
