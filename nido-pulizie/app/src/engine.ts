import { EventEmitter } from 'node:events';
import type { Store, Session } from './db.js';
import type { Home } from './home.js';
import { NarwalClient, type CommandResult } from './narwal.js';
import {
  FAN, WATER, T, WORK_MODE, accepted, deriveActivity, sanitizeClean, startCleanPayload, toGrid,
  type Activity, type CleanSettings, type RobotMap, type Trajectory,
} from './protocol.js';
import { describeTrigger, dueByLeaving, dueByTime, nextRun, sanitizeProgram, type Program } from './programs.js';
import { pVarint1 } from './protocol.js';

const ACTIVE: Activity[] = ['pulizia', 'pausa', 'rientro', 'mappatura'];
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

interface LiveSession {
  id: number; start: number; rooms: number[]; visited: Set<number>; path: [number, number][];
  area: number; elapsed: number; batteryStart: number | null; programId?: string; source: string;
  dockedSince: number | null; idleSince: number | null; report?: { reason?: string; raw: unknown }; stopRequested: boolean;
}

interface Pending { source: string; rooms: number[]; mode: number | null; ts: number; programId?: string; user?: string | null }

export class CommandError extends Error {}

export class Engine extends EventEmitter {
  programs: Program[];
  roomAreas: Record<string, string | null>;
  defaults: CleanSettings;
  roomSettings: Record<string, Partial<CleanSettings>>;
  emptySince: number | null = null;
  private live?: LiveSession;
  private pending?: Pending;
  private lastActivity?: Activity;
  private lastSample = 0;

  constructor(public client: NarwalClient, public store: Store, public home: Home, private personFilter: string[], private log: (m: string) => void) {
    super();
    this.programs = (store.getSetting<any[]>('programs') ?? []).map(p => sanitizeProgram(p, p));
    this.roomAreas = store.getSetting('room_areas') ?? {};
    this.defaults = sanitizeClean(store.getSetting('default_clean') ?? undefined);
    this.roomSettings = store.getSetting('room_settings') ?? {};
    // una sessione rimasta aperta da un riavvio viene ripresa
    const open = store.openSessions().at(-1);
    if (open) this.live = { id: open.id, start: open.start, rooms: open.rooms, visited: new Set(open.visited), path: open.path, area: open.area ?? 0, elapsed: open.duration ?? 0, batteryStart: open.batteryStart, source: open.source, dockedSince: null, idleSince: null, stopRequested: false };

    client.on('state', () => this.onState());
    client.on('trajectory', (t: Trajectory) => this.onTrajectory(t));
    client.on('report', pb => this.onReport(pb));
    client.on('map', (m: RobotMap) => this.onMap(m));
    client.on('identified', ids => store.setSetting('robot_ids', ids));
    home.onPeopleChange(() => this.onPeople());
    setInterval(() => this.tickPrograms(), 20_000);
    setInterval(() => this.onState(), 30_000);
  }

  get state() { return this.client.state; }
  get map() { return this.client.map; }

  event(kind: string, message: string, user: string | null = null) {
    this.store.addEvent(kind, message, user);
    this.emit('event', { kind, message });
  }

  roomName(id: number) { return this.map?.rooms.find(r => r.id === id)?.name ?? `Stanza ${id}`; }

  // ── Stato e sessioni ─────────────────────────────────────────────────────────

  private onState() {
    const s = this.state;
    const now = Date.now();
    deriveActivity(s);
    if (s.activity !== this.lastActivity) {
      if (this.lastActivity && s.activity !== 'sconosciuto') this.store.addSample(now, s.battery ?? null, s.activity);
      this.lastActivity = s.activity;
    }
    if (now - this.lastSample > 5 * 60_000 && s.battery != null) { this.lastSample = now; this.store.addSample(now, s.battery, s.activity); }

    const active = ACTIVE.includes(s.activity) || (s.activity === 'errore' && !s.docked);
    if (active && !this.live) this.openSession();
    const L = this.live;
    if (!L) return;
    if (active) {
      L.dockedSince = null; L.idleSince = null;
      if (s.currentRoomId && this.map?.rooms.some(r => r.id === s.currentRoomId) && (s.activity === 'pulizia')) L.visited.add(s.currentRoomId);
      if (s.area != null && s.area > L.area) L.area = s.area;
      if (s.elapsed != null && s.elapsed > L.elapsed) L.elapsed = s.elapsed;
    } else if (s.docked) {
      L.dockedSince ??= now;
      if (now - L.dockedSince > 20_000 || L.report) this.closeSession();
    } else if (s.online) {
      L.idleSince ??= now;
      if (now - L.idleSince > 30 * 60_000) this.closeSession('Interrotta fuori dalla base');
    }
  }

  private openSession() {
    const s = this.state, now = Date.now();
    const p = this.pending && now - this.pending.ts < 3 * 60_000 ? this.pending : undefined;
    this.pending = undefined;
    const rooms = p?.rooms ?? [];
    const roomNames: Record<string, string> = {};
    for (const r of this.map?.rooms ?? []) roomNames[r.id] = r.name;
    const source = p?.source ?? 'App Narwal o pulsante del robot';
    const id = this.store.openSession({ start: now, source, rooms, roomNames, mode: p?.mode ?? null, batteryStart: s.battery ?? null, mapId: this.map?.id ?? null });
    this.live = { id, start: now, rooms, visited: new Set(), path: [], area: 0, elapsed: 0, batteryStart: s.battery ?? null, programId: p?.programId, source, dockedSince: null, idleSince: null, stopRequested: false };
    this.event('pulizia', `Pulizia iniziata · ${source}${rooms.length ? ` · ${rooms.map(r => this.roomName(r)).join(', ')}` : ''}`, p?.user ?? null);
    this.saveLive();
  }

  private saveLive() {
    const L = this.live;
    if (!L) return;
    this.store.updateSession(L.id, { visited: [...L.visited], area: L.area || null, duration: L.elapsed || null, path: L.path });
  }

  private closeSession(forced?: string) {
    const L = this.live;
    if (!L) return;
    const s = this.state, now = Date.now();
    const duration = L.elapsed || Math.round((now - L.start) / 1000);
    const requested = L.rooms.length ? L.rooms : [];
    const missing = requested.filter(r => !L.visited.has(r));
    const result = forced ?? L.report?.reason ?? (L.stopRequested ? 'Interrotta' : missing.length && L.visited.size ? `Completata in parte (mancano ${missing.map(r => this.roomName(r)).join(', ')})` : 'Completata');
    this.store.updateSession(L.id, { end: now, duration, area: L.area || null, batteryEnd: s.battery ?? null, result, visited: [...L.visited], path: L.path, report: L.report?.raw });
    this.event('pulizia', `Pulizia finita · ${result} · ${L.area ? `${L.area.toLocaleString('it-IT')} m² · ` : ''}${Math.round(duration / 60)} min`);
    this.live = undefined;
    s.progress = undefined; s.area = undefined; s.elapsed = undefined; s.remaining = undefined; s.currentRoomId = undefined;
    this.emit('session', L.id);
  }

  private onTrajectory(t: Trajectory) {
    const L = this.live, m = this.map;
    if (!L || !m) return;
    let changed = false;
    for (let i = 0; i < t.xs.length; i++) {
      const g = toGrid(m, t.xs[i], t.ys[i]);
      const last = L.path.at(-1);
      if (last && Math.abs(last[0] - g.x) < 0.8 && Math.abs(last[1] - g.y) < 0.8) continue;
      // la finestra di traiettoria si sovrappone alla precedente: si salta ciò che è già nel percorso recente
      if (L.path.slice(-60).some(p => Math.abs(p[0] - g.x) < 0.05 && Math.abs(p[1] - g.y) < 0.05)) continue;
      L.path.push([Math.round(g.x * 10) / 10, Math.round(g.y * 10) / 10]);
      changed = true;
    }
    if (L.path.length > 6000) L.path = L.path.filter((_, i) => i % 2 === 0);
    if (changed && L.path.length % 20 === 0) this.saveLive();
  }

  private onReport(pb: any) {
    const reason = pb.str?.(33);
    if (this.live) this.live.report = { reason: reason || undefined, raw: pb.toJSON() };
    else this.event('robot', `Resoconto dal robot${reason ? `: ${reason}` : ''}`);
  }

  private onMap(m: RobotMap) {
    // collega in automatico le stanze del robot alle aree di Home Assistant con lo stesso nome
    let changed = false;
    for (const r of m.rooms) {
      if (r.id in this.roomAreas) continue;
      const a = this.home.areas().find(a => norm(a.name) === norm(r.name)) ?? this.home.areas().find(a => norm(a.name).includes(norm(r.name)) || norm(r.name).includes(norm(a.name)));
      if (a) { this.roomAreas[r.id] = a.id; changed = true; }
    }
    if (changed) this.store.setSetting('room_areas', this.roomAreas);
  }

  liveSession() {
    const L = this.live;
    if (!L) return null;
    return { id: L.id, start: L.start, rooms: L.rooms, visited: [...L.visited], path: L.path, area: L.area, elapsed: L.elapsed, source: L.source };
  }

  // ── Comandi ──────────────────────────────────────────────────────────────────

  private requireOnline() {
    if (!this.state.online) throw new CommandError(this.client.lastError ?? 'Il robot non è collegato');
  }

  settingsFor(roomId: number, base?: Partial<CleanSettings>): CleanSettings {
    return sanitizeClean({ ...this.defaults, ...(this.roomSettings[roomId] ?? {}), ...(base ?? {}) });
  }

  async cleanRooms(roomIds: number[], settings: Partial<CleanSettings> | undefined, source: string, user: string | null = null, programId?: string, perRoom = false): Promise<CommandResult> {
    this.requireOnline();
    await this.client.ensureAwake();
    let map = this.map;
    if (!map?.id) map = await this.client.fetchMap().catch(() => null);
    if (!map?.id) throw new CommandError('Mappa non disponibile: il robot deve avere una mappa salvata');
    const known = new Set(map.rooms.map(r => r.id));
    const ids = (roomIds.length ? roomIds : map.rooms.map(r => r.id)).filter(id => known.has(id));
    if (!ids.length) throw new CommandError('Nessuna stanza valida da pulire');
    if (!this.state.docked && this.state.activity !== 'sconosciuto')
      throw new CommandError(`Il robot deve essere sulla base per iniziare una pulizia per stanze (ora: ${this.state.label.toLowerCase()})`);
    const items = ids.map(id => ({ id, settings: perRoom ? this.settingsFor(id, settings) : sanitizeClean({ ...this.defaults, ...(settings ?? {}) }) }));
    const payload = startCleanPayload(map.id, items);
    this.pending = { source, rooms: ids, mode: items[0].settings.mode, ts: Date.now(), programId, user };
    let r = await this.client.command(T.START_CLEAN, payload, 10_000);
    for (let i = 0; i < 3 && r.code === 4 && this.state.docked; i++) {
      await new Promise(res => setTimeout(res, 3000));
      r = await this.client.command(T.START_CLEAN, payload, 10_000);
    }
    const names = ids.map(id => this.roomName(id)).join(', ');
    if (r.ok) this.event('comando', `Avviata pulizia: ${names} · ${WORK_MODE[items[0].settings.mode]}`, user);
    else { this.pending = undefined; this.event('comando', `Pulizia non avviata (${r.message}): ${names}`, user); }
    return r;
  }

  async action(name: string, value: unknown, user: string | null = null): Promise<CommandResult> {
    this.requireOnline();
    await this.client.ensureAwake();
    const simple: Record<string, [string, string]> = {
      pausa: [T.PAUSE, 'Pausa'], riprendi: [T.RESUME, 'Ripresa'], stop: [T.FORCE_END, 'Stop'], base: [T.RECALL, 'Ritorno alla base'],
      trova: [T.YELL, 'Trova il robot'], lava_mop: [T.WASH_MOP, 'Lavaggio dei mop'], asciuga_mop: [T.DRY_MOP, 'Asciugatura dei mop'],
      svuota: [T.DUST_GATHERING, 'Svuotamento del contenitore'],
    };
    let r: CommandResult, label: string;
    if (name in simple) {
      const [topic, l] = simple[name];
      label = l;
      r = await this.client.command(topic, Buffer.alloc(0), name === 'stop' ? 15_000 : 5_000);
      if (r.ok && (name === 'stop' || name === 'base') && this.live) this.live.stopRequested = true;
    } else if (name === 'aspirazione' || name === 'acqua') {
      const table = name === 'aspirazione' ? FAN : WATER;
      const v = Number(value);
      if (!(v in table) || (name === 'aspirazione' && v > 4)) throw new CommandError('Valore non ammesso');
      label = `${name === 'aspirazione' ? 'Aspirazione' : 'Acqua'}: ${table[v]}`;
      r = await this.client.command(name === 'aspirazione' ? T.SET_FAN : T.SET_MOP, pVarint1(v));
    } else if (name === 'tutta_casa') {
      return this.cleanRooms([], value as any, 'NIDO', user);
    } else if (name === 'aggiorna_mappa') {
      const m = await this.client.fetchMap();
      return { code: m ? 1 : 2, ok: !!m, message: m ? 'Mappa aggiornata' : 'Mappa non ricevuta', data: undefined as any };
    } else throw new CommandError(`Comando sconosciuto: ${name}`);
    this.event('comando', `${label} · ${r.ok ? 'eseguito' : r.message}`, user);
    if (r.ok) setTimeout(() => this.client.refreshStatus().catch(() => undefined), 1500);
    return r;
  }

  // ── Programmi ────────────────────────────────────────────────────────────────

  savePrograms() { this.store.setSetting('programs', this.programs); this.emit('programs'); }

  upsertProgram(body: any, user: string | null) {
    const existing = body?.id ? this.programs.find(p => p.id === body.id) : undefined;
    const p = sanitizeProgram(body, existing);
    if (existing) this.programs[this.programs.indexOf(existing)] = p; else this.programs.push(p);
    this.savePrograms();
    this.event('programma', `${existing ? 'Modificato' : 'Creato'} il programma «${p.name}» (${describeTrigger(p.trigger)})`, user);
    return p;
  }

  deleteProgram(id: string, user: string | null) {
    const p = this.programs.find(x => x.id === id);
    if (!p) return false;
    this.programs = this.programs.filter(x => x.id !== id);
    this.savePrograms();
    this.event('programma', `Eliminato il programma «${p.name}»`, user);
    return true;
  }

  isHomeEmpty() {
    const ppl = this.home.people(this.personFilter);
    return ppl.length > 0 && ppl.every(p => !p.home);
  }

  /** Cosa farebbe il programma adesso: stanze scelte, stanze saltate e perché. */
  plan(p: Program) {
    const reasons: string[] = [];
    const skipped: { id: number; name: string; why: string }[] = [];
    const s = this.state;
    if (p.onlyIfEmpty && !this.isHomeEmpty()) reasons.push('c\'è qualcuno in casa');
    if (!s.online) reasons.push('robot non collegato');
    else if (!s.docked && s.activity !== 'sconosciuto') reasons.push(`robot non sulla base (${s.label.toLowerCase()})`);
    if (s.battery != null && s.battery < p.minBattery) reasons.push(`batteria al ${s.battery}% (minimo ${p.minBattery}%)`);
    const all = this.map?.rooms ?? [];
    if (!all.length) reasons.push('mappa non disponibile');
    const wanted = p.rooms.length ? all.filter(r => p.rooms.includes(r.id)) : all;
    const last = this.store.lastCleaned();
    const rooms: number[] = [];
    for (const r of wanted) {
      const area = this.roomAreas[r.id];
      if (p.skipOccupied && area) {
        const occ = this.home.occupancy(area);
        if (occ.occupied) { skipped.push({ id: r.id, name: r.name, why: `presenza: ${occ.sensors.filter(x => x.on).map(x => x.name).join(', ')}` }); continue; }
      }
      if (p.minHoursSinceLast > 0 && last[r.id] && Date.now() - last[r.id] < p.minHoursSinceLast * 3600_000) {
        skipped.push({ id: r.id, name: r.name, why: `pulita ${Math.round((Date.now() - last[r.id]) / 3600_000)} ore fa` }); continue;
      }
      rooms.push(r.id);
    }
    if (!rooms.length && wanted.length && !reasons.length) reasons.push('tutte le stanze sono state saltate');
    return { ok: !reasons.length && rooms.length > 0, reasons, rooms, roomNames: rooms.map(id => this.roomName(id)), skipped };
  }

  async runProgram(p: Program, why: string, user: string | null = null) {
    const pl = this.plan(p);
    p.lastRun = Date.now();
    if (!pl.ok) {
      p.lastResult = `Non partito: ${pl.reasons.join('; ')}`;
      this.event('programma', `«${p.name}» (${why}) non partito: ${pl.reasons.join('; ')}`, user);
    } else {
      try {
        const r = await this.cleanRooms(pl.rooms, p.settings, `Programma «${p.name}»`, user, p.id);
        p.lastResult = r.ok ? `Avviato: ${pl.roomNames.join(', ')}${pl.skipped.length ? ` · saltate ${pl.skipped.map(x => `${x.name} (${x.why})`).join(', ')}` : ''}` : `Rifiutato dal robot: ${r.message}`;
        if (pl.skipped.length) this.event('programma', `«${p.name}»: saltate ${pl.skipped.map(x => `${x.name} (${x.why})`).join(', ')}`);
      } catch (e) {
        p.lastResult = `Errore: ${e instanceof Error ? e.message : e}`;
        this.event('programma', `«${p.name}»: ${p.lastResult}`, user);
      }
    }
    this.savePrograms();
    return { plan: pl, result: p.lastResult };
  }

  private running = false;
  private async tickPrograms() {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const empty = this.isHomeEmpty();
      if (empty && this.emptySince == null) this.emptySince = Date.now();
      if (!empty) this.emptySince = null;
      for (const p of this.programs) {
        if (dueByTime(p, now)) await this.runProgram(p, 'orario');
        else if (dueByLeaving(p, now, this.emptySince)) await this.runProgram(p, 'casa vuota');
      }
    } finally { this.running = false; }
  }

  private onPeople() {
    const empty = this.isHomeEmpty();
    if (empty && this.emptySince == null) { this.emptySince = Date.now(); this.event('casa', 'Casa vuota'); }
    if (!empty && this.emptySince != null) {
      this.emptySince = null;
      const who = this.home.people(this.personFilter).filter(p => p.home).map(p => p.name).join(', ');
      this.event('casa', `Rientro: ${who}`);
      const L = this.live;
      const prog = L?.programId ? this.programs.find(p => p.id === L.programId) : undefined;
      if (prog && prog.onReturn !== 'continua' && this.state.activity === 'pulizia') {
        const act = prog.onReturn === 'base' ? 'base' : 'pausa';
        this.action(act, null, `Programma «${prog.name}»`).catch(e => this.log(`Azione al rientro non riuscita: ${e}`));
      }
    }
    void this.tickPrograms();
  }

  programsView() {
    return this.programs.map(p => ({ ...p, description: describeTrigger(p.trigger), next: nextRun(p), preview: this.plan(p) }));
  }

  setRoomArea(roomId: number, areaId: string | null) {
    this.roomAreas[roomId] = areaId;
    this.store.setSetting('room_areas', this.roomAreas);
  }
  setDefaults(s: Partial<CleanSettings>) { this.defaults = sanitizeClean(s); this.store.setSetting('default_clean', this.defaults); }
  setRoomSettings(id: number, s: Partial<CleanSettings> | null) {
    if (s) this.roomSettings[id] = sanitizeClean({ ...this.defaults, ...s }); else delete this.roomSettings[id];
    this.store.setSetting('room_settings', this.roomSettings);
  }
}

export function sessionView(s: Session, map: RobotMap | null) {
  const name = (id: number) => s.roomNames[id] ?? map?.rooms.find(r => r.id === id)?.name ?? `Stanza ${id}`;
  return { ...s, roomsLabel: s.rooms.map(name), visitedLabel: s.visited.map(name), modeLabel: s.mode ? WORK_MODE[s.mode] : null };
}

export { accepted };
