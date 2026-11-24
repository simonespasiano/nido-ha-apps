import type { CoverInfo, HAState, Home, SensorInfo } from './home.js';
import { num } from './home.js';
import type { Options } from './config.js';
import type { AppEvent, Origin, Store } from './db.js';
import {
  DEFAULT_GLOBAL, DEFAULT_SHUTTER, MODE_LABEL, SEASON_LABEL, defaultRules,
  type GlobalSettings, type Mode, type Rule, type Scene, type Season, type ShutterSettings,
} from './model.js';
import { onFacade, sunPosition, sunTimes } from './sun.js';

export interface Ctx { origin: Origin; who: string | null; reason: string | null }

interface Hold { until: number; by: string; since: number }
interface Protect { prevPos: number; setPos: number; since: number }
interface Pending { pos: number; reason: string; ts: number }
interface LastCmd { ts: number; pos: number | 'stop'; origin: Origin; who: string | null; reason: string | null }
interface Runtime { hold: Hold | null; protect: Protect | null; pending: Pending | null; winterDay: string | null }

interface Track {
  active: boolean; startPos: number | null; startTs: number; timer?: NodeJS.Timeout;
  origin: Origin; who: string | null; reason: string | null;
}

export interface Shutter {
  id: string; entity: string; cover: CoverInfo; settings: ShutterSettings; contact: string | null;
}

const EXCLUDED_CLASSES = new Set(['garage', 'gate', 'door']);
const MOVING = new Set(['opening', 'closing']);
const SUNNY = new Set(['sunny', 'partlycloudy', 'clear-night', 'exceptional']);
const OUTDOOR_AREA = /esterno|esterna|giardino|balcon|terrazz|fuori|cortile|outdoor|outside/i;
const DEVICE_TEMP = /cpu|soc|ssd|nvme|disk|disco|chip|processor|raspberry|\brpi|rp1|core|scheda|board|router|fritz|nas|nido_sistema|device_temperature|internal|interna|batter/i;

export const idOf = (entity: string) => entity.replace(/^cover\./, '');
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const hm = (ms: number) => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const minutesOf = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const atTime = (base: number, t: string) => { const d = new Date(base); d.setHours(0, 0, 0, 0); return d.getTime() + minutesOf(t) * 60_000; };
/** Spostamento pseudo-casuale ma stabile per giorno e regola (simulazione di presenza). */
function jitter(seed: string, max: number) {
  let h = 2166136261;
  for (const c of seed) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % (2 * max + 1)) - max;
}
const posOf = (s: HAState | undefined): number | null => {
  if (!s) return null;
  const p = num(s.attributes.current_position);
  if (p != null) return p;
  return s.state === 'open' ? 100 : s.state === 'closed' ? 0 : null;
};
export const posLabel = (p: number | null) => p == null ? '?' : p <= 0 ? 'chiusa' : p >= 100 ? 'aperta' : `al ${Math.round(p)}%`;
const posShort = (p: number | null) => p == null ? '?' : p <= 0 ? 'chiusa' : p >= 100 ? 'aperta' : `${Math.round(p)}%`;

export class Engine {
  global: GlobalSettings;
  shutterSettings: Record<string, ShutterSettings>;
  scenes: Scene[];
  rules: Rule[];
  private runtime: Record<string, Runtime>;
  private track = new Map<string, Track>();
  private lastCmd = new Map<string, LastCmd>();
  private sunCond = new Map<string, { value: boolean; since: number }>();
  private ruleState = new Map<string, { fired?: string; cond?: boolean; since?: number; done?: boolean }>();
  private prev: { presence?: 'casa' | 'fuori'; mode?: Mode; elevation?: number } = {};
  storm = { wind: false, rain: false, windSince: 0 };
  lastTick = 0;
  lastDecisions: { ts: number; text: string }[] = [];
  private listeners: Record<string, (() => void)[]> = {};

  constructor(public home: Home, private store: Store, private opts: Options, private logFn: (m: string) => void) {
    this.global = { ...DEFAULT_GLOBAL, ...(store.getSetting<GlobalSettings>('global') ?? {}) };
    this.global.sun = { ...DEFAULT_GLOBAL.sun, ...this.global.sun };
    this.global.outdoor = { ...DEFAULT_GLOBAL.outdoor, ...this.global.outdoor };
    this.global.weather = { ...DEFAULT_GLOBAL.weather, ...this.global.weather };
    this.global.notify = { ...DEFAULT_GLOBAL.notify, ...this.global.notify };
    this.global.simulate = { ...DEFAULT_GLOBAL.simulate, ...this.global.simulate };
    this.shutterSettings = store.getSetting('shutters') ?? {};
    this.scenes = store.getSetting('scenes') ?? [];
    this.rules = store.getSetting('rules') ?? defaultRules();
    this.runtime = store.getSetting('runtime') ?? {};
    // regole già scattate oggi: dopo un riavvio non devono ripartire
    for (const [id, fired] of Object.entries(store.getSetting<Record<string, string>>('fired') ?? {})) this.ruleState.set(id, { fired });
  }

  on(ev: string, cb: () => void) { (this.listeners[ev] ??= []).push(cb); }
  emit(ev: string) { this.listeners[ev]?.forEach(cb => { try { cb(); } catch { /* */ } }); }

  log(message: string, shutter: string | null = null, kind = 'sistema', origin: Origin | null = null, who: string | null = null) {
    const e: AppEvent = { ts: Date.now(), shutter, kind, message, origin, who };
    this.store.insertEvent(e);
    this.logFn(`${shutter ? `[${shutter}] ` : ''}${message}`);
  }

  private notify(title: string, message: string) {
    const svc = this.global.notify.service;
    if (!svc) return;
    this.home.notify(svc, title, message).catch(e => this.logFn(`Notifica non inviata: ${e instanceof Error ? e.message : e}`));
  }

  private saveRuntime = (() => { let t: NodeJS.Timeout | undefined; return () => { clearTimeout(t); t = setTimeout(() => this.store.setSetting('runtime', this.runtime), 1000); }; })();
  private rt(id: string): Runtime { return this.runtime[id] ??= { hold: null, protect: null, pending: null, winterDay: null }; }

  // ─────────── tapparelle e sensori ───────────

  shutters(): Shutter[] {
    const sensors = this.home.sensors();
    const covers = this.home.covers();
    return covers
      .filter(c => this.opts.tapparelle.length ? this.opts.tapparelle.includes(c.entity) : !EXCLUDED_CLASSES.has(c.deviceClass ?? ''))
      .filter(c => !this.opts.escludi.includes(c.entity))
      .map(c => {
        const id = idOf(c.entity);
        const settings = { ...DEFAULT_SHUTTER, ...(this.shutterSettings[id] ?? {}) };
        const contact = settings.contact === 'auto' ? this.autoContact(c, covers, sensors) : settings.contact;
        return { id, entity: c.entity, cover: c, settings, contact };
      })
      .sort((a, b) => (a.cover.areaName ?? 'zzz').localeCompare(b.cover.areaName ?? 'zzz', 'it') || this.nameOf(a).localeCompare(this.nameOf(b), 'it'));
  }

  /**
   * Contatto della stessa area. Con più tapparelle nella stanza ogni contatto va alla tapparella
   * col nome più simile (es. "Porta-finestra soggiorno" → tapparella "Porta-finestra soggiorno").
   */
  private autoContact(c: CoverInfo, covers: CoverInfo[], sensors: SensorInfo[]): string | null {
    if (!c.areaId) return null;
    const contacts = sensors.filter(s => s.role === 'contatto' && s.areaId === c.areaId)
      .sort((a, b) => Number(b.deviceClass === 'door') - Number(a.deviceClass === 'door'));
    if (!contacts.length) return null;
    const peers = covers.filter(x => x.areaId === c.areaId);
    if (peers.length === 1) return contacts[0].entity;
    const STOP = new Set(['tapparella', 'tapparelle', 'sensore', 'contatto', 'cover', 'binary', 'sensor', 'shutter', 'di', 'del', 'della', 'il', 'la']);
    const words = (t: string) => new Set(t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w)));
    const score = (a: string, b: string) => { const A = words(a), B = words(b); let n = 0; A.forEach(w => B.has(w) && n++); return n - Math.abs(A.size - B.size) * 0.1; };
    for (const k of contacts) {
      let best: CoverInfo | null = null, bestScore = -Infinity;
      for (const p of peers) { const sc = score(`${p.name} ${p.entity}`, `${k.name} ${k.entity}`); if (sc > bestScore) { bestScore = sc; best = p; } }
      if (best?.entity === c.entity && bestScore > 0) return k.entity;
    }
    return null;
  }

  nameOf(s: Shutter) { return s.settings.label || s.cover.name; }
  private find(id: string) { return this.shutters().find(s => s.id === id); }

  /** Sensori esterni: quelli scelti, altrimenti riconosciuti dall'area o dal nome. */
  outdoorEntities() {
    const all = this.home.sensors();
    // fuori = area o nome "esterno/giardino/balcone…"; mai le temperature di computer e dispositivi
    const named = (s: SensorInfo) => OUTDOOR_AREA.test(s.areaName ?? '') || OUTDOOR_AREA.test(s.entity) || OUTDOOR_AREA.test(s.name);
    const device = (s: SensorInfo) => DEVICE_TEMP.test(s.entity) || DEVICE_TEMP.test(s.name);
    const auto = (role: SensorInfo['role'], mode: 'nome' | 'senza_area' | 'tutti') => {
      const c = all.filter(s => s.role === role && !device(s) &&
        (mode === 'tutti' || named(s) || (mode === 'senza_area' && !s.areaId)));
      return (c.find(named) ?? c[0])?.entity ?? null;
    };
    const o = this.global.outdoor;
    return {
      temp: o.temp ?? auto('temperatura', 'nome'),
      lux: o.lux ?? auto('luce', 'senza_area'),
      wind: o.wind ?? auto('vento', 'tutti'),
      rain: o.rain ?? auto('pioggia', 'tutti'),
      weather: o.weather ?? auto('meteo', 'tutti'),
      auto: { temp: !o.temp, lux: !o.lux, wind: !o.wind, rain: !o.rain, weather: !o.weather },
    };
  }

  private value(entity: string | null) { return entity ? num(this.home.get(entity)?.state) : null; }

  outdoor() {
    const e = this.outdoorEntities();
    const w = e.weather ? this.home.get(e.weather) : undefined;
    const rainS = e.rain ? this.home.get(e.rain) : undefined;
    const rain = rainS ? (rainS.entity_id.startsWith('binary_sensor.') ? rainS.state === 'on' : (num(rainS.state) ?? 0) > 0)
      : w ? /rain|pour|lightning|snow|hail/.test(w.state) : false;
    return {
      temp: this.value(e.temp) ?? (w ? num(w.attributes.temperature) : null),
      lux: this.value(e.lux),
      wind: this.value(e.wind) ?? (w ? num(w.attributes.wind_speed) : null),
      rain, weather: w?.state ?? null, entities: e,
    };
  }

  /** Temperatura della stanza: un sensore nella stessa area della tapparella. */
  private indoorTemp(s: Shutter) {
    if (!s.cover.areaId) return null;
    const t = this.home.sensors().find(x => x.role === 'temperatura' && x.areaId === s.cover.areaId && x.domain === 'sensor');
    return t ? num(t.state) : null;
  }

  // ─────────── stato della casa ───────────

  presence(): { state: 'casa' | 'fuori'; people: { id: string; name: string; state: string; counted: boolean }[] } {
    const filter = this.global.people.length ? this.global.people : this.opts.persone;
    const people = this.home.people(filter).map(p => ({ id: p.id, name: p.name, state: p.state, home: p.home,
      counted: p.trackers > 0 && !['unknown', 'unavailable'].includes(p.state) }));
    const counted = people.filter(p => p.counted);
    const state = !counted.length || counted.some(p => p.home) ? 'casa' as const : 'fuori' as const;
    return { state, people: people.map(({ home: _h, ...p }) => p) };
  }

  effectiveMode(): Exclude<Mode, 'auto'> {
    const m = this.global.mode;
    if (m === 'auto') return this.presence().state;
    return m;
  }

  season(now = Date.now()): Season {
    if (this.global.season !== 'auto') return this.global.season;
    const t = this.outdoor().temp;
    const month = new Date(now).getMonth() + 1;
    const byMonth: Season = month >= 6 && month <= 8 ? 'estate' : month === 12 || month <= 2 ? 'inverno' : 'mezza';
    if (t != null && byMonth === 'mezza') { if (t >= 27) return 'estate'; if (t <= 8) return 'inverno'; }
    return byMonth;
  }

  sun(now = Date.now()) {
    const loc = this.home.location();
    if (!loc) return null;
    const p = sunPosition(now, loc.lat, loc.lon);
    const t = sunTimes(now, loc.lat, loc.lon);
    return { ...p, ...t, lat: loc.lat, lon: loc.lon };
  }

  // ─────────── comandi ───────────

  async command(id: string, target: number | 'open' | 'close' | 'stop', ctx: Ctx, opts: { force?: boolean; out?: { blocked: boolean } } = {}): Promise<string> {
    const s = this.find(id);
    if (!s) throw new Error('Tapparella non trovata');
    if (!s.cover.available) throw new Error(`${this.nameOf(s)} non è raggiungibile`);
    const name = this.nameOf(s);
    const cur = s.cover.position;
    if (target === 'stop') {
      this.lastCmd.set(id, { ts: Date.now(), pos: 'stop', ...ctx });
      await this.home.cover(s.entity, 'stop');
      return `${name}: fermata`;
    }
    let pos = target === 'open' ? 100 : target === 'close' ? 0 : Math.round(Math.max(0, Math.min(100, target)));
    const rt = this.rt(id);

    // finestra o porta aperta: le automazioni non chiudono
    if (ctx.origin === 'nido' && !opts.force && s.contact && s.settings.lockout !== 'nessuno' && this.home.get(s.contact)?.state === 'on') {
      const min = s.settings.lockout === 'limita' ? s.settings.lockoutPos : (cur ?? 100);
      if (pos < min) {
        rt.pending = { pos, reason: ctx.reason ?? 'automazione', ts: Date.now() };
        this.saveRuntime();
        const contactName = this.home.get(s.contact)?.attributes.friendly_name ?? s.contact;
        if (opts.out) opts.out.blocked = true;
        this.log(`Non chiusa perché ${contactName} è aperta: appena si chiude la porto ${posLabel(pos)} (${ctx.reason ?? 'automazione'})`, id, 'blocco', 'nido', 'NIDO');
        if (this.global.notify.lockout) this.notify('Tapparella bloccata', `${name}: ${contactName} è aperta, non la chiudo`);
        if (s.settings.lockout === 'limita' && cur != null && cur > min) pos = min; else return `${name}: bloccata (porta/finestra aperta)`;
      }
    }
    if (ctx.origin === 'nido') {
      const last = this.lastCmd.get(id);
      if (last && last.pos === pos && Date.now() - last.ts < 30_000) return `${name}: già comandata`;
      if (cur != null && Math.abs(cur - pos) < 1 && !MOVING.has(s.cover.state)) return `${name}: già ${posLabel(pos)}`;
    }
    this.lastCmd.set(id, { ts: Date.now(), pos, ...ctx });
    if (s.cover.supportsPosition) await this.home.cover(s.entity, 'position', pos);
    else if (pos >= 50) await this.home.cover(s.entity, 'open');
    else await this.home.cover(s.entity, 'close');
    if (ctx.origin === 'nido' && this.global.notify.failure && s.cover.supportsPosition) this.verify(id, pos);
    return `${name}: ${posLabel(pos)}`;
  }

  /** Dopo un comando controlla che la tapparella sia arrivata dove doveva. */
  private verify(id: string, pos: number) {
    const sent = Date.now();
    setTimeout(() => {
      const s = this.find(id);
      const last = this.lastCmd.get(id);
      if (!s || !last || last.ts > sent) return;
      const cur = s.cover.position;
      if (cur == null || MOVING.has(s.cover.state) || Math.abs(cur - pos) <= 8) return;
      if (s.contact && this.home.get(s.contact)?.state === 'on') return;
      this.log(`Non ha raggiunto la posizione: doveva andare ${posLabel(pos)}, è ${posLabel(cur)}`, id, 'errore', 'nido', 'NIDO');
      this.notify('Tapparella ferma', `${this.nameOf(s)} doveva andare ${posLabel(pos)} ma è ${posLabel(cur)}`);
    }, 150_000);
  }

  resolveTargets(targets: string[]): Shutter[] {
    const all = this.shutters();
    const out = new Map<string, Shutter>();
    for (const t of targets) {
      if (t === 'all') all.forEach(s => out.set(s.id, s));
      else if (t.startsWith('area:')) all.filter(s => s.cover.areaId === t.slice(5)).forEach(s => out.set(s.id, s));
      else if (t.startsWith('gruppo:')) all.filter(s => s.settings.group === t.slice(7)).forEach(s => out.set(s.id, s));
      else { const s = all.find(x => x.id === t); if (s) out.set(s.id, s); }
    }
    return [...out.values()];
  }

  async runScene(sceneId: string, ctx: Ctx) {
    const sc = this.scenes.find(s => s.id === sceneId);
    if (!sc) throw new Error('Scenario non trovato');
    const res: string[] = [];
    for (const [id, pos] of Object.entries(sc.positions)) {
      try { res.push(await this.command(id, pos, { ...ctx, reason: `scenario ${sc.name}` })); }
      catch (e) { res.push(e instanceof Error ? e.message : String(e)); }
    }
    this.log(`Scenario "${sc.name}"${ctx.who ? ` — da ${ctx.who}` : ''}: ${Object.keys(sc.positions).length} tapparelle`, null, 'scenario', ctx.origin, ctx.who);
    return res;
  }

  // ─────────── pausa dopo un comando a mano ───────────

  private setHold(s: Shutter, by: string, now = Date.now()) {
    if (this.global.holdMode === 'mai' || !s.settings.enabled) return;
    let until: number;
    if (this.global.holdMode === 'minuti') until = now + this.global.holdMinutes * 60_000;
    else {
      const next = this.nextEvents(now, 36).find(e => e.shutters.includes(s.id));
      until = next ? next.ts : now + 12 * 3_600_000;
    }
    const rt = this.rt(s.id);
    rt.hold = { until, by, since: now };
    rt.pending = null;
    if (rt.protect) rt.protect = null;
    this.saveRuntime();
  }

  resume(id: string, who: string | null) {
    const rt = this.rt(id);
    if (!rt.hold) return;
    rt.hold = null;
    this.saveRuntime();
    const s = this.find(id);
    this.log(`Automazioni riprese${who ? ` — da ${who}` : ''}`, id, 'comando', 'utente', who);
    if (s) this.sunCond.delete(id);
  }

  private onHold(id: string, now = Date.now()) {
    const h = this.rt(id).hold;
    if (!h) return false;
    if (h.until <= now + 60_000) { this.rt(id).hold = null; this.saveRuntime(); return false; }
    return true;
  }

  // ─────────── movimenti: chi è stato ───────────

  onStateChange(entity: string, old: HAState | undefined, now: HAState | undefined) {
    if (entity.startsWith('cover.')) return this.onCover(entity, old, now);
    for (const s of this.shutters()) if (s.contact === entity && old?.state !== now?.state) this.onContact(s, now?.state === 'on');
  }

  private onCover(entity: string, old: HAState | undefined, cur: HAState | undefined) {
    const id = idOf(entity);
    const s = this.find(id);
    if (!s || !cur || !old) return;
    const oldPos = posOf(old), pos = posOf(cur);
    const moving = MOVING.has(cur.state);
    if (!moving && pos === oldPos && old.state === cur.state) return;
    if (['unavailable', 'unknown'].includes(cur.state) || ['unavailable', 'unknown'].includes(old.state)) return;
    let tr = this.track.get(id);
    if (!tr?.active) {
      const ts = Date.now();
      const last = this.lastCmd.get(id);
      let origin: Origin, who: string | null, reason: string | null = null;
      if (last && ts - last.ts < 90_000) { origin = last.origin; who = last.who; reason = last.reason; }
      else {
        const call = this.home.lastCall(entity, 90_000, ts);
        if (call?.own) { origin = 'nido'; who = 'NIDO'; }
        else if (call?.userId) { origin = 'utente'; who = call.userName; reason = 'da Home Assistant'; }
        else if (call) { origin = 'automazione'; who = call.automation ? 'automazione di Home Assistant' : 'Home Assistant'; }
        else { origin = 'muro'; who = 'pulsante a muro'; }
      }
      tr = { active: true, startPos: oldPos, startTs: ts, origin, who, reason };
      this.track.set(id, tr);
    }
    clearTimeout(tr.timer);
    tr.timer = setTimeout(() => this.settle(id), moving ? 180_000 : 6_000);
    this.emit('state');
  }

  private settle(id: string) {
    const tr = this.track.get(id);
    const s = this.find(id);
    if (!tr || !s) return;
    if (MOVING.has(s.cover.state)) { tr.timer = setTimeout(() => this.settle(id), 6_000); return; }
    tr.active = false;
    const to = s.cover.position;
    if (to == null || tr.startPos == null || Math.abs(to - tr.startPos) < 1) return;
    this.store.insertMove({ ts: tr.startTs, shutter: id, from: tr.startPos, to, origin: tr.origin, who: tr.who, reason: tr.reason });
    const dir = to > tr.startPos ? '▲' : '▼';
    const by = tr.origin === 'nido' ? (tr.reason ? ` — ${tr.reason}` : '') : ` — ${tr.who ?? ''}${tr.reason && tr.origin !== 'utente' ? ` (${tr.reason})` : ''}`;
    this.log(`${dir} da ${posShort(tr.startPos)} a ${posShort(to)}${by}`, id, 'movimento', tr.origin, tr.who);
    if (tr.origin !== 'nido') {
      this.setHold(s, tr.who ?? 'a mano');
      const h = this.rt(id).hold;
      if (h) this.log(`Comandata a mano: automazioni in pausa fino alle ${hm(h.until)}${h.until - Date.now() > 20 * 3_600_000 ? ' di domani' : ''}`, id, 'pausa', tr.origin, tr.who);
    }
    this.emit('state');
  }

  private async onContact(s: Shutter, open: boolean) {
    const rt = this.rt(s.id);
    if (open) {
      const last = this.lastCmd.get(s.id);
      if (s.settings.lockout !== 'nessuno' && s.cover.state === 'closing' && last?.origin === 'nido' && Date.now() - last.ts < 180_000) {
        await this.home.cover(s.entity, 'stop').catch(() => undefined);
        this.log('Fermata: si è aperta la porta/finestra mentre scendeva', s.id, 'blocco', 'nido', 'NIDO');
        if (typeof last.pos === 'number') { rt.pending = { pos: last.pos, reason: last.reason ?? 'automazione', ts: Date.now() }; this.saveRuntime(); }
        if (s.settings.lockout === 'limita') setTimeout(() => this.command(s.id, s.settings.lockoutPos, { origin: 'nido', who: 'NIDO', reason: 'porta aperta' }, { force: true }).catch(() => undefined), 1500);
      }
    } else if (rt.pending) {
      const p = rt.pending;
      rt.pending = null; this.saveRuntime();
      if (Date.now() - p.ts > 3 * 3_600_000 || this.onHold(s.id)) return;
      setTimeout(() => this.command(s.id, p.pos, { origin: 'nido', who: 'NIDO', reason: `${p.reason} (dopo la chiusura della porta)` })
        .catch(e => this.log(`Comando rimandato non eseguito: ${e instanceof Error ? e.message : e}`, s.id, 'errore')), 20_000);
      const cn = s.contact ? this.home.get(s.contact)?.attributes.friendly_name ?? s.contact : 'Porta/finestra';
      this.log(`${cn} chiusa: tra 20 secondi la porto ${posLabel(p.pos)} (${p.reason})`, s.id, 'blocco', 'nido', 'NIDO');
    }
  }

  // ─────────── ciclo principale ───────────

  async tick(now = Date.now()) {
    this.lastTick = now;
    const g = this.global;
    if (g.mode === 'vacanza' && g.vacationUntil && now > g.vacationUntil) {
      g.mode = 'auto'; g.vacationUntil = null; this.store.setSetting('global', g);
      this.log('Vacanza finita: modalità tornata su Automatica', null, 'modalita', 'nido', 'NIDO');
    }
    const mode = this.effectiveMode();
    const presence = this.presence().state;
    const sun = this.sun(now);
    const decisions: string[] = [];

    if (this.prev.mode && this.prev.mode !== mode) this.log(`Modalità: ${MODE_LABEL[mode]}`, null, 'modalita', 'nido', 'NIDO');
    const presenceEdge = this.prev.presence && this.prev.presence !== presence ? presence : null;
    const modeEdge = this.prev.mode && this.prev.mode !== mode ? mode : null;
    this.prev.presence = presence; this.prev.mode = mode;

    if (mode !== 'pausa') {
      await this.weatherGuard(now, decisions);
      if (!this.storm.wind && !this.storm.rain) {
        await this.runRules(now, { presenceEdge, modeEdge, elevation: sun?.elevation ?? null }, decisions);
        await this.sunGuard(now, sun, mode, decisions);
      }
    }
    if (sun) this.prev.elevation = sun.elevation;
    if (decisions.length) {
      this.lastDecisions.unshift(...decisions.map(text => ({ ts: now, text })));
      this.lastDecisions.splice(30);
    }
    this.emit('tick');
  }

  // regole

  private ruleConditions(r: Rule, now: number, presence: 'casa' | 'fuori'): string | null {
    const d = new Date(now);
    if (r.days.length && !r.days.includes(d.getDay())) return 'giorno';
    const c = r.conditions;
    const m = d.getHours() * 60 + d.getMinutes();
    if (c.after && c.before) {
      const a = minutesOf(c.after), b = minutesOf(c.before);
      if (a <= b ? (m < a || m > b) : (m < a && m > b)) return 'orario';
    } else if (c.after && m < minutesOf(c.after)) return 'orario';
    else if (c.before && m > minutesOf(c.before)) return 'orario';
    if (c.modes.length && !c.modes.includes(this.effectiveMode())) return 'modalità';
    if (c.seasons.length && !c.seasons.includes(this.season(now))) return 'stagione';
    if (c.presence && c.presence !== presence) return 'presenza';
    if (c.entity && c.entityState != null && this.home.get(c.entity)?.state !== c.entityState) return 'condizione';
    return null;
  }

  /** Orario di oggi (o di `base`) in cui scatta una regola a orario o col sole. */
  scheduledAt(r: Rule, base: number): number | null {
    const t = r.trigger;
    let ts: number | null = null;
    if (t.type === 'orario') ts = atTime(base, t.time);
    else if (t.type === 'sole') {
      const s = this.sun(base);
      const ev = t.event === 'alba' ? s?.sunrise : s?.sunset;
      ts = ev != null ? ev + t.offset * 60_000 : null;
    }
    if (ts == null) return null;
    if (this.effectiveMode() === 'vacanza' && this.global.simulate.enabled && this.global.simulate.jitter > 0)
      ts += jitter(`${r.id}-${dayKey(base)}`, this.global.simulate.jitter) * 60_000;
    return ts;
  }

  private async runRules(now: number, edges: { presenceEdge: string | null; modeEdge: Mode | null; elevation: number | null }, decisions: string[]) {
    const presence = this.presence().state;
    for (const r of this.rules) {
      if (!r.enabled) continue;
      const st = this.ruleState.get(r.id) ?? {};
      this.ruleState.set(r.id, st);
      const t = r.trigger;
      let fire = false;
      switch (t.type) {
        case 'orario': case 'sole': {
          const at = this.scheduledAt(r, now);
          const key = dayKey(now);
          if (at != null && now >= at && now - at < 10 * 60_000 && st.fired !== key) {
            st.fired = key; fire = true;
            this.store.setSetting('fired', Object.fromEntries([...this.ruleState].filter(([, v]) => v.fired).map(([k, v]) => [k, v.fired])));
          }
          break;
        }
        case 'elevazione': {
          const prev = this.prev.elevation, cur = edges.elevation;
          if (prev != null && cur != null) fire = t.op === 'sopra' ? prev < t.value && cur >= t.value : prev > t.value && cur <= t.value;
          break;
        }
        case 'presenza':
          fire = !!edges.presenceEdge && (t.event === 'tutti_fuori' ? edges.presenceEdge === 'fuori' : edges.presenceEdge === 'casa');
          break;
        case 'modalita': fire = edges.modeEdge === t.to; break;
        case 'sensore': case 'stato': {
          const s = this.home.get(t.entity);
          let cond = false;
          if (t.type === 'sensore') { const v = num(s?.state); cond = v != null && (t.op === 'sopra' ? v > t.value : v < t.value); }
          else cond = s?.state === t.to;
          if (!cond) { st.cond = false; st.since = undefined; st.done = false; break; }
          if (!st.cond) { st.cond = true; st.since = now; st.done = false; }
          if (!st.done && now - (st.since ?? now) >= t.forMin * 60_000) { st.done = true; fire = true; }
          break;
        }
      }
      if (!fire) continue;
      const blocked = this.ruleConditions(r, now, presence);
      if (blocked) { decisions.push(`"${r.name}" non eseguita: condizione ${blocked} non soddisfatta`); continue; }
      await this.execRule(r, decisions);
    }
  }

  async execRule(r: Rule, decisions: string[] = [], manualWho: string | null = null) {
    const ctx: Ctx = { origin: 'nido', who: 'NIDO', reason: manualWho ? `${r.name} (avviata da ${manualWho})` : r.name };
    const plan: { s: Shutter; pos: number }[] = [];
    if (r.action.type === 'scenario') {
      const sc = this.scenes.find(x => x.id === (r.action as any).scene);
      if (!sc) { this.log(`"${r.name}": lo scenario non esiste più`, null, 'errore'); return; }
      for (const [id, pos] of Object.entries(sc.positions)) { const s = this.find(id); if (s) plan.push({ s, pos }); }
    } else {
      const a = r.action;
      for (const s of this.resolveTargets(a.targets)) plan.push({ s, pos: a.type === 'preferita' ? s.settings.favorite : a.position });
    }
    const done: string[] = [], skipped: string[] = [];
    const now = Date.now();
    for (const { s, pos: want } of plan) {
      const name = this.nameOf(s);
      if (!manualWho) {
        if (!s.settings.enabled) { skipped.push(`${name} (automazioni spente)`); continue; }
        if (this.onHold(s.id, now)) {
          if (!r.overrideManual) { skipped.push(`${name} (comandata a mano)`); continue; }
          this.rt(s.id).hold = null;
        }
      }
      const cur = s.cover.position;
      if (cur != null && r.onlyDirection === 'solo_apri' && want <= cur) continue;
      if (cur != null && r.onlyDirection === 'solo_chiudi' && want >= cur) continue;
      let pos = want;
      // se il sole batte su quella finestra, non aprire oltre la posizione d'ombra
      const sc = this.sunCond.get(s.id);
      if (!manualWho && sc?.value && pos > this.shadeFor(s)) {
        this.rt(s.id).protect = { prevPos: pos, setPos: this.shadeFor(s), since: now };
        pos = this.shadeFor(s);
      } else if (this.rt(s.id).protect) this.rt(s.id).protect = null;
      const out = { blocked: false };
      try { await this.command(s.id, pos, ctx, { out }); out.blocked ? skipped.push(`${name} (porta aperta: dopo)`) : done.push(name); }
      catch (e) { skipped.push(`${name} (${e instanceof Error ? e.message : e})`); }
    }
    this.saveRuntime();
    const msg = `${r.name}: ${done.length ? done.length === 1 ? done[0] : `${done.length} tapparelle` : 'nessuna da muovere'}${skipped.length ? ` · saltate: ${skipped.join(', ')}` : ''}`;
    this.log(msg + (manualWho ? ` — avviata a mano da ${manualWho}` : ''), null, 'regola', manualWho ? 'utente' : 'nido', manualWho ?? 'NIDO');
    decisions.push(msg);
    if (r.notify || this.global.notify.rules) this.notify('Tapparelle', msg);
  }

  // protezione dal sole e guadagno invernale

  private shadeFor(s: Shutter) {
    const away = ['fuori', 'vacanza'].includes(this.effectiveMode());
    return away && this.global.sun.awayPos != null ? Math.min(this.global.sun.awayPos, s.settings.shadePos) : s.settings.shadePos;
  }

  /** Perché il sole va (o non va) schermato su questa tapparella. */
  sunCheck(s: Shutter, sun: ReturnType<Engine['sun']>, now = Date.now()) {
    const g = this.global.sun;
    if (!sun) return { want: false, hit: false, diff: null as number | null, why: 'posizione della casa non impostata in Home Assistant' };
    if (s.settings.orientation == null) return { want: false, hit: false, diff: null, why: 'orientamento della finestra non impostato' };
    const f = onFacade(sun.azimuth, sun.elevation, s.settings.orientation, s.settings.sunHalfWidth, g.minElevation);
    const base = { hit: f.hit, diff: f.diff };
    if (!g.enabled) return { ...base, want: false, why: 'protezione dal sole spenta' };
    if (!s.settings.enabled) return { ...base, want: false, why: 'automazioni spente per questa tapparella' };
    if (!f.hit) return { ...base, want: false, why: sun.elevation < g.minElevation ? 'sole troppo basso' : 'il sole non batte su questa facciata' };
    const season = this.season(now);
    const o = this.outdoor();
    if (g.onlySummer && season === 'inverno') return { ...base, want: false, why: 'inverno: il sole scalda la casa' };
    if (o.temp != null) { if (o.temp < g.minOutdoorTemp) return { ...base, want: false, why: `fuori ${o.temp.toFixed(1)} °C, sotto ${g.minOutdoorTemp} °C` }; }
    else if (g.onlySummer && season !== 'estate') return { ...base, want: false, why: 'senza sensore esterno agisce solo d\'estate' };
    const lux = s.settings.lux ? this.value(s.settings.lux) : o.lux;
    if (lux != null) { if (lux < g.minLux) return { ...base, want: false, why: `luce ${Math.round(lux)} lx, sotto ${g.minLux} lx` }; }
    else if (o.weather && !SUNNY.has(o.weather)) return { ...base, want: false, why: `cielo: ${o.weather}` };
    if (g.minIndoorTemp != null) {
      const ti = this.indoorTemp(s);
      if (ti != null && ti < g.minIndoorTemp) return { ...base, want: false, why: `in casa ${ti.toFixed(1)} °C, sotto ${g.minIndoorTemp} °C` };
    }
    return { ...base, want: true, why: `sole sulla facciata (scarto ${f.diff}°)` };
  }

  private async sunGuard(now: number, sun: ReturnType<Engine['sun']>, mode: string, decisions: string[]) {
    const g = this.global;
    const delay = g.sun.delayMin * 60_000;
    for (const s of this.shutters()) {
      const rt = this.rt(s.id);
      const chk = this.sunCheck(s, sun, now);
      let sc = this.sunCond.get(s.id);
      if (!sc) { sc = { value: chk.want, since: now }; this.sunCond.set(s.id, sc); }
      else if (sc.value !== chk.want) { sc.value = chk.want; sc.since = now; }
      const stable = now - sc.since >= delay;
      const cur = s.cover.position;
      if (!s.cover.available || cur == null) continue;

      // protezione
      const contactOpen = !!s.contact && s.settings.lockout !== 'nessuno' && this.home.get(s.contact)?.state === 'on';
      if (chk.want && stable && !rt.protect && !rt.pending && !contactOpen && !this.onHold(s.id, now)) {
        const shade = this.shadeFor(s);
        if (cur > shade + 2) {
          rt.protect = { prevPos: cur, setPos: shade, since: now };
          this.saveRuntime();
          try {
            await this.command(s.id, shade, { origin: 'nido', who: 'NIDO', reason: 'protezione dal sole' });
            this.log(`Sole sulla finestra: abbassata ${posLabel(shade)} (era ${posLabel(cur)})`, s.id, 'sole', 'nido', 'NIDO');
            decisions.push(`${this.nameOf(s)}: protezione dal sole`);
          } catch { rt.protect = null; }
        }
      } else if (!chk.want && stable && rt.protect) {
        const p = rt.protect;
        rt.protect = null; this.saveRuntime();
        const daytime = sun ? sun.elevation > 0 : true;
        if (g.sun.restore && daytime && !this.onHold(s.id, now) && Math.abs(cur - p.setPos) <= 3 && p.prevPos > cur) {
          await this.command(s.id, p.prevPos, { origin: 'nido', who: 'NIDO', reason: 'fine sole sulla finestra' }).catch(() => undefined);
          this.log(`Il sole ha lasciato la finestra: riportata ${posLabel(p.prevPos)}`, s.id, 'sole', 'nido', 'NIDO');
          decisions.push(`${this.nameOf(s)}: fine protezione dal sole`);
        }
      }

      // guadagno invernale: apre del tutto le tapparelle già socchiuse quando il sole batte
      if (g.winter.enabled && s.settings.winterGain && this.season(now) === 'inverno' && chk.hit && stable === true
        && mode !== 'pausa' && rt.winterDay !== dayKey(now) && cur > 0 && cur < 95 && !this.onHold(s.id, now)) {
        rt.winterDay = dayKey(now); this.saveRuntime();
        await this.command(s.id, 100, { origin: 'nido', who: 'NIDO', reason: 'sole d\'inverno' }).catch(() => undefined);
        this.log('Sole d\'inverno sulla facciata: aperta per scaldare la stanza', s.id, 'sole', 'nido', 'NIDO');
      }
    }
  }

  // vento e pioggia

  private async weatherGuard(now: number, decisions: string[]) {
    const w = this.global.weather;
    const o = this.outdoor();
    const act = async (action: 'apri' | 'chiudi', why: string) => {
      const pos = action === 'apri' ? 100 : 0;
      for (const s of this.shutters().filter(x => x.settings.enabled && x.cover.available))
        await this.command(s.id, pos, { origin: 'nido', who: 'NIDO', reason: why }, { force: false }).catch(() => undefined);
      this.log(`${why[0].toUpperCase()}${why.slice(1)}: tapparelle ${action === 'apri' ? 'aperte' : 'chiuse'}. Le automazioni restano ferme finché non passa`, null, 'meteo', 'nido', 'NIDO');
      decisions.push(why);
      if (this.global.notify.weather) this.notify('Tapparelle', `${why}: ${action === 'apri' ? 'aperte' : 'chiuse'}`);
    };
    if (w.windAbove != null && w.windAction !== 'nessuna' && o.wind != null) {
      if (!this.storm.wind && o.wind >= w.windAbove) { this.storm.wind = true; this.storm.windSince = now; await act(w.windAction, `vento forte (${Math.round(o.wind)})`); }
      else if (this.storm.wind) {
        if (o.wind >= w.windAbove * 0.8) this.storm.windSince = now;
        else if (now - this.storm.windSince > 15 * 60_000) { this.storm.wind = false; this.log('Il vento è calato: automazioni riprese', null, 'meteo', 'nido', 'NIDO'); }
      }
    } else this.storm.wind = false;
    if (w.rainAction !== 'nessuna') {
      if (!this.storm.rain && o.rain) { this.storm.rain = true; await act(w.rainAction, 'pioggia'); }
      else if (this.storm.rain && !o.rain) { this.storm.rain = false; this.log('Ha smesso di piovere: automazioni riprese', null, 'meteo', 'nido', 'NIDO'); }
    } else this.storm.rain = false;
  }

  // ─────────── cosa succederà ───────────

  nextEvents(now = Date.now(), hours = 30) {
    const out: { ts: number; rule: string; name: string; shutters: string[]; text: string }[] = [];
    const presence = this.presence().state;
    for (const r of this.rules) {
      if (!r.enabled || (r.trigger.type !== 'orario' && r.trigger.type !== 'sole')) continue;
      for (let d = 0; d < 3; d++) {
        const base = now + d * 86_400_000;
        const ts = this.scheduledAt(r, base);
        if (ts == null || ts < now || ts > now + hours * 3_600_000) continue;
        if (this.ruleConditions(r, ts, presence) === 'giorno') continue;
        const shutters = r.action.type === 'scenario'
          ? Object.keys(this.scenes.find(s => s.id === (r.action as any).scene)?.positions ?? {})
          : this.resolveTargets(r.action.targets).map(s => s.id);
        const what = r.action.type === 'scenario' ? `scenario ${this.scenes.find(s => s.id === (r.action as any).scene)?.name ?? '?'}`
          : r.action.type === 'preferita' ? 'posizione preferita' : posLabel(r.action.position);
        out.push({ ts, rule: r.id, name: r.name, shutters, text: what });
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  // ─────────── viste per l'interfaccia ───────────

  views(now = Date.now()) {
    const sun = this.sun(now);
    return this.shutters().map(s => {
      const rt = this.rt(s.id);
      const hold = rt.hold && rt.hold.until > now ? rt.hold : null;
      const c = s.contact ? this.home.get(s.contact) : undefined;
      const chk = this.sunCheck(s, sun, now);
      const sc = this.sunCond.get(s.id);
      return {
        id: s.id, entity: s.entity, name: this.nameOf(s), haName: s.cover.name,
        area: s.cover.areaName, areaId: s.cover.areaId, group: s.settings.group,
        position: s.cover.position, state: s.cover.state, available: s.cover.available,
        moving: MOVING.has(s.cover.state), supportsPosition: s.cover.supportsPosition, supportsStop: s.cover.supportsStop,
        settings: s.settings,
        contact: s.contact ? { entity: s.contact, name: c?.attributes.friendly_name ?? s.contact, open: c?.state === 'on', auto: s.settings.contact === 'auto' } : null,
        hold, protect: rt.protect, pending: rt.pending,
        sun: { ...chk, pendingSince: sc && sc.value !== !!rt.protect ? sc.since : null },
        indoorTemp: this.indoorTemp(s),
        lastMove: this.store.moves(now - 30 * 86_400_000, now + 1, s.id).at(-1) ?? null,
      };
    });
  }

  overview(now = Date.now()) {
    const sun = this.sun(now);
    const o = this.outdoor();
    return {
      mode: this.global.mode, effective: this.effectiveMode(), modeLabel: MODE_LABEL, vacationUntil: this.global.vacationUntil,
      presence: this.presence(), season: this.season(now), seasonLabel: SEASON_LABEL[this.season(now)],
      sun, outdoor: { temp: o.temp, lux: o.lux, wind: o.wind, rain: o.rain, weather: o.weather },
      storm: this.storm, next: this.nextEvents(now, 30).slice(0, 8), decisions: this.lastDecisions.slice(0, 10),
      sunEnabled: this.global.sun.enabled,
    };
  }

  // ─────────── nuovi dispositivi ───────────

  checkNewDevices(first = false) {
    const known = new Set(this.store.getSetting<string[]>('known') ?? []);
    const shutters = this.shutters();
    const sensors = this.home.sensors().filter(s => s.role !== 'altro' && s.role !== 'umidita');
    const all = [...shutters.map(s => s.entity), ...sensors.map(s => s.entity)];
    if (!first && known.size) {
      for (const s of shutters) if (!known.has(s.entity)) this.log(`Nuova tapparella: ${this.nameOf(s)}${s.cover.areaName ? ` (${s.cover.areaName})` : ''}`, s.id, 'dispositivi');
      for (const x of sensors) if (!known.has(x.entity)) {
        const linked = x.role === 'contatto' ? shutters.filter(s => s.contact === x.entity).map(s => this.nameOf(s)) : [];
        this.log(`Nuovo sensore (${x.role}): ${x.name}${x.areaName ? ` in ${x.areaName}` : ''}${linked.length ? ` — collegato a ${linked.join(', ')}` : ''}`, null, 'dispositivi');
      }
    }
    if (all.some(e => !known.has(e)) || all.length !== known.size) this.store.setSetting('known', all);
  }

  // ─────────── salvataggi ───────────

  saveGlobal(g: GlobalSettings) { this.global = g; this.store.setSetting('global', g); this.emit('settings'); }
  saveShutter(id: string, s: ShutterSettings) { this.shutterSettings[id] = s; this.store.setSetting('shutters', this.shutterSettings); this.sunCond.delete(id); this.emit('settings'); }
  saveScenes(list: Scene[]) { this.scenes = list; this.store.setSetting('scenes', list); this.emit('scenes'); }
  saveRules(list: Rule[]) { this.rules = list; this.store.setSetting('rules', list); this.emit('settings'); }
}
