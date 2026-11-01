import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, statSync, writeFileSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Options } from './config.js';
import type { Store, CamEvent } from './db.js';
import type { Home, HKCamera } from './ha.js';
import type { Backend } from './backend.js';
import { Recorder } from './recorder.js';

export type Mode = 'sempre' | 'casa_vuota' | 'mai';
export interface Quiet { days: number[]; from: string; to: string; noRecord: boolean }
export interface Rules {
  record: Mode;
  notify: Mode;
  quiet: Quiet[];                // fasce senza notifiche (ed eventualmente senza registrazione)
  ignoreWhileVacuum: boolean;    // il movimento del robot aspirapolvere non conta
  liveWhenHome: boolean;         // diretta permessa anche con qualcuno in casa
  cooldownMin: number;           // minuti minimi fra due notifiche
  pausedUntil: number | null;    // pausa manuale di registrazioni e notifiche
}

export const DEFAULT_RULES: Rules = { record: 'sempre', notify: 'casa_vuota', quiet: [], ignoreWhileVacuum: true, liveWhenHome: true, cooldownMin: 5, pausedUntil: null };
export const MODE_LABEL: Record<Mode, string> = { sempre: 'Sempre', casa_vuota: 'Solo a casa vuota', mai: 'Mai' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeRules(r: any, cur: Rules = DEFAULT_RULES): Rules {
  const mode = (v: any, d: Mode): Mode => (['sempre', 'casa_vuota', 'mai'].includes(v) ? v : d);
  return {
    record: mode(r?.record, cur.record), notify: mode(r?.notify, cur.notify),
    quiet: Array.isArray(r?.quiet) ? r.quiet.slice(0, 10).map((q: any) => ({
      days: Array.isArray(q.days) ? [...new Set(q.days.map(Number).filter((d: number) => d >= 0 && d <= 6))] as number[] : [0, 1, 2, 3, 4, 5, 6],
      from: HHMM.test(q.from) ? q.from : '23:00', to: HHMM.test(q.to) ? q.to : '07:00', noRecord: !!q.noRecord,
    })) : cur.quiet,
    ignoreWhileVacuum: r?.ignoreWhileVacuum ?? cur.ignoreWhileVacuum,
    liveWhenHome: r?.liveWhenHome ?? cur.liveWhenHome,
    cooldownMin: Math.min(120, Math.max(0, Number(r?.cooldownMin ?? cur.cooldownMin))),
    pausedUntil: r && 'pausedUntil' in r ? (r.pausedUntil ? Number(r.pausedUntil) : null) : cur.pausedUntil,
  };
}

const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function inQuiet(q: Quiet, d: Date) {
  const m = d.getHours() * 60 + d.getMinutes(), a = mins(q.from), b = mins(q.to);
  // per una fascia che passa la mezzanotte conta il giorno in cui è iniziata
  if (a <= b) return q.days.includes(d.getDay()) && m >= a && m < b;
  if (m >= a) return q.days.includes(d.getDay());
  if (m < b) return q.days.includes((d.getDay() + 6) % 7);
  return false;
}

const ON = new Set(['on', 'open', 'detected', 'home']);

export class Engine extends EventEmitter {
  rules: Rules;
  camera: HKCamera | null = null;
  cameras: HKCamera[] = [];
  recorder: Recorder;
  private activeEvent: number | null = null;
  private lastNotify = 0;
  lastSnapshot: { ts: number; rel: string } | null = null;
  panelUrl: string | null = null;

  constructor(public opts: Options, public store: Store, public home: Home, public backend: Backend, public mediaDir: string, private log: (m: string) => void) {
    super();
    this.rules = sanitizeRules(store.getSetting('rules') ?? DEFAULT_RULES);
    this.recorder = new Recorder(backend, mediaDir, log);
    mkdirSync(mediaDir, { recursive: true });
    home.on('state', (id: string, ns: any) => this.onState(id, ns?.state));
    // finché un sensore resta attivo la clip continua (fino alla durata massima)
    setInterval(() => { if (this.recorder.busy && this.anyTriggerOn()) this.recorder.extend(this.opts.clip_dopo_movimento_secondi); }, 1000);
    setInterval(() => this.prune(), 3600_000);
    setTimeout(() => this.prune(), 60_000);
  }

  async discover() {
    this.cameras = await this.home.homekitCameras().catch(() => []);
    const want = this.opts.camera;
    const cam = (want ? this.cameras.find(c => c.title === want || c.deviceName === want || c.cameraEntity === want) : undefined) ?? this.cameras[0] ?? null;
    if (want && !cam) this.log(`Camera «${want}» non trovata fra gli abbinamenti HomeKit di Home Assistant`);
    if (cam?.title !== this.camera?.title) {
      this.camera = cam;
      this.backend.setSource(cam?.title ?? null);
      if (cam) this.log(`Camera: ${cam.deviceName ?? cam.title} (${cam.title})${cam.motionSensors.length ? ` · movimento da ${cam.motionSensors.join(', ')}` : ''}`);
    }
    this.panelUrl = await this.home.ingressPanel();
  }

  triggers(): string[] { return this.opts.sensori_movimento.length ? this.opts.sensori_movimento : this.camera?.motionSensors ?? []; }

  people() {
    return this.home.all('person.').filter(p => !this.opts.persone.length || this.opts.persone.includes(p.entity_id))
      .map(p => ({ id: p.entity_id, name: p.attributes.friendly_name ?? p.entity_id, home: p.state === 'home' }));
  }
  homeEmpty() { const p = this.people(); return p.length > 0 && p.every(x => !x.home); }
  vacuumBusy() { return this.home.all('vacuum.').some(v => ['cleaning', 'returning'].includes(v.state)); }

  saveRules(r: any, user: string | null) {
    this.rules = sanitizeRules(r, this.rules);
    this.store.setSetting('rules', this.rules);
    this.store.log('regole', `Regole aggiornate: registra ${MODE_LABEL[this.rules.record].toLowerCase()}, notifica ${MODE_LABEL[this.rules.notify].toLowerCase()}${this.rules.pausedUntil && this.rules.pausedUntil > Date.now() ? `, in pausa fino alle ${new Date(this.rules.pausedUntil).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : ''}`, user);
    this.emit('changed');
  }

  /** Cosa farebbe adesso un movimento, e perché. */
  decision(now = new Date()) {
    const r = this.rules, empty = this.homeEmpty();
    const why: string[] = [];
    let record = true, notify = this.opts.notifiche.length > 0;
    if (!this.opts.notifiche.length) why.push('nessun servizio di notifica configurato');
    if (r.pausedUntil && r.pausedUntil > now.getTime()) { record = false; notify = false; why.push('in pausa'); }
    if (r.ignoreWhileVacuum && this.vacuumBusy()) { record = false; notify = false; why.push('aspirapolvere in pulizia'); }
    if (r.record === 'mai' || (r.record === 'casa_vuota' && !empty)) { record = false; why.push(r.record === 'mai' ? 'registrazione disattivata' : 'registra solo a casa vuota'); }
    if (r.notify === 'mai' || (r.notify === 'casa_vuota' && !empty)) { notify = false; why.push(r.notify === 'mai' ? 'notifiche disattivate' : 'notifica solo a casa vuota'); }
    const q = r.quiet.find(x => inQuiet(x, now));
    if (q) { notify = false; why.push(`fascia silenziosa ${q.from}–${q.to}`); if (q.noRecord) record = false; }
    return { record, notify, homeEmpty: empty, why: [...new Set(why)] };
  }

  liveAllowed() { return this.rules.liveWhenHome || this.homeEmpty(); }

  private onState(id: string, state: string | undefined) {
    if (!this.triggers().includes(id)) return;
    if (ON.has(state ?? '')) void this.motion(id);
    else if (this.recorder.busy) this.recorder.extend(this.opts.clip_dopo_movimento_secondi);
  }

  anyTriggerOn() { return this.triggers().some(t => ON.has(this.home.state(t)?.state ?? '')); }

  async motion(trigger: string, kind: CamEvent['kind'] = 'movimento', user: string | null = null) {
    const now = Date.now();
    if (this.recorder.busy && kind === 'movimento') { this.recorder.extend(this.opts.clip_dopo_movimento_secondi); return; }
    const d = kind === 'manuale' ? { record: true, notify: false, homeEmpty: this.homeEmpty(), why: [] as string[] } : this.decision();
    const id = this.store.addEvent({ ts: now, kind, trigger, note: d.why.length ? d.why.join(' · ') : null });
    this.activeEvent = id;
    const name = this.home.state(trigger)?.attributes.friendly_name ?? trigger;
    if (kind === 'movimento') this.store.log('movimento', `${name}${d.record ? ' · registro' : ''}${d.notify ? ' · notifica' : ''}${d.why.length && (!d.record || !d.notify) ? ` (${d.why.join(', ')})` : ''}`);
    else this.store.log('registrazione', 'Registrazione avviata a mano', user);
    if (d.record) {
      this.recorder.start(id, kind === 'manuale' ? 30 : this.opts.clip_dopo_movimento_secondi, kind === 'manuale' ? 30 : this.opts.clip_massima_secondi, (rec, bytes, err) => {
        this.store.updateEvent(rec.id, { end: Date.now(), clip: bytes ? rec.rel : null, recorded: bytes > 0, bytes: bytes + (this.store.event(rec.id)?.bytes ?? 0), note: err ? `registrazione non riuscita: ${err}` : this.store.event(rec.id)?.note ?? null });
        this.emit('changed');
        // movimento ancora in corso a fine clip (durata massima raggiunta): si riparte con una nuova clip
        if (!err && kind === 'movimento' && this.anyTriggerOn() && this.decision().record) void this.motion(trigger);
      });
      this.emit('changed');
    }
    // la foto serve per l'anteprima e per la notifica; con HomeKit la prima immagine arriva in qualche secondo
    const snap = await this.snapshot(id).catch(e => { this.log(`Foto non riuscita: ${e instanceof Error ? e.message : e}`); return null; });
    if (!d.record) this.store.updateEvent(id, { end: Date.now() });
    if (d.notify && now - this.lastNotify > this.rules.cooldownMin * 60_000) {
      this.lastNotify = now;
      await this.notify(`Movimento: ${name}`, `${new Date(now).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}${d.homeEmpty ? ' · casa vuota' : ''}${d.record ? ' · registrazione in corso' : ''}`, snap?.rel ?? null);
      this.store.updateEvent(id, { notified: true });
    } else if (d.notify) this.store.updateEvent(id, { note: [this.store.event(id)?.note, `notifica saltata: già inviata da meno di ${this.rules.cooldownMin} min`].filter(Boolean).join(' · ') });
    this.emit('changed');
  }

  async snapshot(eventId?: number, user: string | null = null): Promise<{ rel: string; jpg: Buffer }> {
    let jpg: Buffer | null = null, err: unknown;
    try { jpg = await this.backend.snapshot(); } catch (e) { err = e; }
    if (!jpg && this.camera?.cameraEntity) jpg = await this.home.cameraSnapshot(this.camera.cameraEntity); // foto via HomeKit di Home Assistant
    if (!jpg) throw err ?? new Error('nessuna immagine');
    const d = new Date();
    const rel = `foto/${d.toISOString().slice(0, 10)}/${d.getTime()}${eventId ? `-${eventId}` : ''}.jpg`;
    mkdirSync(dirname(join(this.mediaDir, rel)), { recursive: true });
    writeFileSync(join(this.mediaDir, rel), jpg);
    this.lastSnapshot = { ts: d.getTime(), rel };
    if (eventId) {
      const e = this.store.event(eventId);
      this.store.updateEvent(eventId, { thumb: rel, bytes: (e?.bytes ?? 0) + jpg.length });
    } else {
      this.store.addEvent({ ts: d.getTime(), end: d.getTime(), kind: 'foto', thumb: rel, bytes: jpg.length, trigger: user ? `da ${user}` : null });
      this.store.log('foto', 'Foto scattata', user);
    }
    this.emit('snapshot', jpg);
    this.emit('changed');
    return { rel, jpg };
  }

  async notify(title: string, message: string, rel: string | null) {
    const data: Record<string, unknown> = { tag: 'nido-camera', group: 'nido-camera' };
    // nell'app di Home Assistant l'immagine si indica con il percorso della cartella media
    if (rel) data.image = `/media/local/nido-camera/${rel}`;
    if (this.panelUrl) { data.url = this.panelUrl; data.clickAction = this.panelUrl; }
    for (const svc of this.opts.notifiche) {
      try { await this.home.callService('notify', svc, { title, message, data }); }
      catch (e) { this.log(`Notifica a ${svc} non riuscita: ${e instanceof Error ? e.message : e}`); }
    }
  }

  async testNotify(user: string | null) {
    if (!this.opts.notifiche.length) throw new Error('Nessun servizio di notifica nella configurazione (opzione notifiche)');
    const s = await this.snapshot(undefined, user).catch(() => null);
    await this.notify('NIDO Camera · prova', 'Le notifiche funzionano', s?.rel ?? null);
    this.store.log('notifica', `Notifica di prova a ${this.opts.notifiche.join(', ')}`, user);
  }

  deleteEvent(id: number) {
    const e = this.store.event(id);
    if (!e) return false;
    for (const rel of [e.clip, e.thumb]) if (rel) rmSync(join(this.mediaDir, rel), { force: true });
    this.store.deleteEvent(id);
    return true;
  }

  /** Cancella le clip più vecchie dei giorni di conservazione e, se serve, le più vecchie oltre lo spazio massimo. */
  prune() {
    const cut = Date.now() - this.opts.conserva_giorni * 86400_000;
    let removed = 0;
    for (const e of this.store.events(0, cut, 5000)) { if (e.id !== this.activeEvent || !this.recorder.busy) { this.deleteEvent(e.id); removed++; } }
    const max = this.opts.spazio_massimo_gb * 1024 ** 3;
    let total = this.store.totalBytes();
    while (total > max) {
      const batch = this.store.oldestWithFiles(20).filter(e => !(this.recorder.busy && e.id === this.recorder.current?.id));
      if (!batch.length) break;
      for (const e of batch) { total -= e.bytes; this.deleteEvent(e.id); removed++; if (total <= max) break; }
    }
    // cartelle dei giorni rimaste vuote
    for (const sub of ['clip', 'foto']) {
      try { for (const d of readdirSync(join(this.mediaDir, sub))) { const p = join(this.mediaDir, sub, d); try { if (!readdirSync(p).length) rmdirSync(p); } catch { /* */ } } } catch { /* cartella assente */ }
    }
    if (removed) this.store.log('spazio', `Eliminati ${removed} eventi vecchi`);
    this.store.pruneLog(90);
  }

  fileSize(rel: string) { try { return statSync(join(this.mediaDir, rel)).size; } catch { return 0; } }
}
