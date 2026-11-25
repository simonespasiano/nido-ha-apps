/**
 * Automazioni di NIDO Clima: un solo punto che decide l'obiettivo di ogni stanza.
 *
 * obiettivo = livello del programma orario (comfort / eco / notte)
 *           → sostituito da Fuori o Vacanza secondo la modalità della casa (anche automatica dalle persone)
 *           → + piccolo aumento contro la condensa se le pareti rischiano la muffa
 *           → sostituito da "finestra aperta" quando la stanza si raffredda di colpo
 *           → sostituito da un intervento a mano (dal pannello o dalla ghiera della valvola) fino al prossimo cambio di programma
 */
import type { Store } from './db.js';
import type { DataSource, Room, RoomStatus, Sample } from './types.js';
import { absHumidity, surfaceRH } from './humidity.js';

export type Level = 'comfort' | 'eco' | 'notte';
export type HouseMode = 'auto' | 'casa' | 'fuori' | 'notte' | 'vacanza';
export type DayType = 'feriali' | 'sabato' | 'domenica';
export interface Block { at: string; level: Level }   // da quest'ora in poi vale questo livello
export interface Temps { comfort: number; eco: number; notte: number; fuori: number; vacanza: number }
export interface RoomAuto { enabled: boolean; temps: Temps; week: Record<DayType, Block[]> }

export interface AutoSettings {
  enabled: boolean;
  houseMode: HouseMode;
  vacationUntil: number | null;
  awayDelayMin: number;
  persons: string[];
  window: { enabled: boolean; dropC: number; minutes: number; temp: number };
  humidity: { enabled: boolean; high: number; antiMould: boolean; boost: number; notify: boolean; services: string[]; spike: number };
  rooms: Record<string, RoomAuto>;
}

export interface Override { value: number; until: number; source: 'pannello' | 'valvola' | 'boost' }
/** Presenza decisa a mano per una persona: vale al posto della posizione del telefono. */
export type PresenceState = 'casa' | 'fuori' | 'ignora';
export interface PresenceOverride { state: PresenceState; until: number | null; by: string | null; since: number }
export const PRESENCE_LABEL: Record<PresenceState, string> = { casa: 'in casa', fuori: 'fuori', ignora: 'non conta' };
export interface PersonView { id: string; name: string; home: boolean; state: string; trackers: number; userId?: string | null; gpsHome: boolean; manual: PresenceOverride | null }

const KEY = 'automazioni';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const fmt = (n: number) => n.toFixed(1).replace('.', ',');
const hm = (ts: number) => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

export const LEVEL_LABEL: Record<Level | 'fuori' | 'vacanza', string> = { comfort: 'Comfort', eco: 'Eco', notte: 'Notte', fuori: 'Fuori casa', vacanza: 'Vacanza' };
export const MODE_LABEL: Record<HouseMode, string> = { auto: 'Automatica', casa: 'Casa', fuori: 'Fuori', notte: 'Notte', vacanza: 'Vacanza' };

export function defaultRoom(name = ''): RoomAuto {
  const bath = /bagno/i.test(name), bed = /camera|letto/i.test(name);
  return {
    enabled: true,
    temps: { comfort: bath ? 21.5 : bed ? 19.5 : 20.5, eco: 18, notte: bed ? 17.5 : 17, fuori: 16, vacanza: 14 },
    week: {
      feriali: bath
        ? [{ at: '06:00', level: 'comfort' }, { at: '08:30', level: 'eco' }, { at: '19:00', level: 'comfort' }, { at: '22:30', level: 'notte' }]
        : [{ at: '06:30', level: 'comfort' }, { at: '08:30', level: 'eco' }, { at: '17:30', level: 'comfort' }, { at: '22:30', level: 'notte' }],
      sabato: [{ at: '08:00', level: 'comfort' }, { at: '23:00', level: 'notte' }],
      domenica: [{ at: '08:00', level: 'comfort' }, { at: '22:30', level: 'notte' }],
    },
  };
}

const DEFAULT: AutoSettings = {
  enabled: false, houseMode: 'auto', vacationUntil: null, awayDelayMin: 15, persons: [],
  window: { enabled: true, dropC: 0.6, minutes: 15, temp: 7 },
  humidity: { enabled: true, high: 65, antiMould: true, boost: 0.5, notify: true, services: [], spike: 10 },
  rooms: {},
};

const clampT = (v: any, d: number) => { const n = Math.round(Number(v) * 2) / 2; return Number.isFinite(n) && n >= 5 && n <= 28 ? n : d; };

export function sanitizeAuto(input: any, cur: AutoSettings): AutoSettings {
  const i = input ?? {};
  const rooms: Record<string, RoomAuto> = { ...cur.rooms };
  for (const [id, r] of Object.entries<any>(i.rooms ?? {})) {
    const base = cur.rooms[id] ?? defaultRoom();
    const week = { ...base.week };
    for (const d of ['feriali', 'sabato', 'domenica'] as DayType[]) {
      if (!Array.isArray(r?.week?.[d])) continue;
      const blocks = r.week[d].filter((b: any) => HHMM.test(b?.at) && ['comfort', 'eco', 'notte'].includes(b?.level))
        .map((b: any) => ({ at: b.at, level: b.level })).sort((a: Block, b: Block) => a.at.localeCompare(b.at)).slice(0, 12);
      week[d] = blocks.length ? blocks : base.week[d];
    }
    const t = r?.temps ?? {};
    rooms[id] = {
      enabled: r?.enabled ?? base.enabled, week,
      temps: { comfort: clampT(t.comfort, base.temps.comfort), eco: clampT(t.eco, base.temps.eco), notte: clampT(t.notte, base.temps.notte), fuori: clampT(t.fuori, base.temps.fuori), vacanza: clampT(t.vacanza, base.temps.vacanza) },
    };
  }
  const w = i.window ?? {}, h = i.humidity ?? {};
  const num = (v: any, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    enabled: i.enabled ?? cur.enabled,
    houseMode: ['auto', 'casa', 'fuori', 'notte', 'vacanza'].includes(i.houseMode) ? i.houseMode : cur.houseMode,
    vacationUntil: 'vacationUntil' in i ? (i.vacationUntil ? Number(i.vacationUntil) : null) : cur.vacationUntil,
    awayDelayMin: num(i.awayDelayMin, cur.awayDelayMin, 0, 240),
    persons: Array.isArray(i.persons) ? i.persons.map(String) : cur.persons,
    window: { enabled: w.enabled ?? cur.window.enabled, dropC: num(w.dropC, cur.window.dropC, 0.3, 3), minutes: num(w.minutes, cur.window.minutes, 5, 90), temp: clampT(w.temp, cur.window.temp) },
    humidity: {
      enabled: h.enabled ?? cur.humidity.enabled, high: num(h.high, cur.humidity.high, 50, 85), antiMould: h.antiMould ?? cur.humidity.antiMould,
      boost: num(h.boost, cur.humidity.boost, 0, 1.5), notify: h.notify ?? cur.humidity.notify,
      services: Array.isArray(h.services) ? h.services.map((s: any) => String(s).replace(/^notify\./, '')).filter(Boolean) : cur.humidity.services,
      spike: num(h.spike, cur.humidity.spike, 5, 30),
    },
    rooms,
  };
}

const dayType = (d: Date): DayType => d.getDay() === 0 ? 'domenica' : d.getDay() === 6 ? 'sabato' : 'feriali';
const minutes = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

/** Livello del programma in un istante e quando cambierà. */
export function scheduleAt(ra: RoomAuto, ts: number): { level: Level; next: number } {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  const today = ra.week[dayType(d)];
  let level: Level | null = null;
  for (const b of today) if (minutes(b.at) <= m) level = b.level;
  if (level == null) { // prima del primo blocco vale l'ultimo del giorno prima
    const y = new Date(ts - 86_400_000);
    const prev = ra.week[dayType(y)];
    level = prev[prev.length - 1]?.level ?? 'eco';
  }
  // prossimo cambio: il primo blocco dopo adesso, oggi o nei giorni seguenti
  let next = Number.MAX_SAFE_INTEGER;
  for (let k = 0; k < 8 && next === Number.MAX_SAFE_INTEGER; k++) {
    const day = new Date(ts + k * 86_400_000); day.setHours(0, 0, 0, 0);
    for (const b of ra.week[dayType(day)]) { const t = day.getTime() + minutes(b.at) * 60_000; if (t > ts) { next = t; break; } }
  }
  return { level, next };
}

export interface RoomDecision {
  room: string; name: string; managed: boolean; level: string; levelLabel: string;
  base: number | null; target: number | null; current: number | null; reasons: string[];
  window: { open: boolean; since: number | null; until: number | null };
  override: Override | null; mould: { surfaceRH: number | null; risk: boolean };
  next: { at: number; level: Level; temp: number } | null; skipped: string | null;
}

export class Automations {
  settings: AutoSettings;
  overrides: Record<string, Override>;
  /** Ultimo obiettivo mandato da NIDO: prev è il valore che la valvola aveva prima, finché non conferma il nuovo. */
  private applied = new Map<string, { value: number; ts: number; prev?: number | null; tries?: number }>();
  private windows = new Map<string, { since: number; until: number; tempAt: number }>();
  private emptySince: number | null = null;
  private lastNotify = new Map<string, number>();
  private highSince = new Map<string, number>();
  private mouldOn = new Set<string>();
  decisions: RoomDecision[] = [];
  presence: Record<string, PresenceOverride>;

  constructor(private src: DataSource, private store: Store, private log: (msg: string, room: string | null, kind?: 'automazione' | 'umidita') => void,
              private outdoor: () => { temp: number | null; hum: number | null }) {
    const saved = store.getSetting<AutoSettings>(KEY);
    this.settings = saved ? sanitizeAuto(saved, { ...DEFAULT, rooms: saved.rooms ?? {} }) : { ...DEFAULT };
    this.overrides = store.getSetting<Record<string, Override>>('override') ?? {};
    this.presence = store.getSetting<Record<string, PresenceOverride>>('presenza') ?? {};
  }

  private lastPerson = new Map<string, string>();
  /** Nel Diario ogni cambio di stato di una persona, con il dispositivo che l'ha deciso e la distanza da casa. */
  private trackPeople() {
    const det = this.src.presenceDetail?.();
    for (const p of this.src.people?.() ?? []) {
      const prev = this.lastPerson.get(p.id);
      this.lastPerson.set(p.id, p.state);
      if (prev == null || prev === p.state) continue;
      const d = det?.people.find(x => x.id === p.id);
      const t = d?.trackers.find(x => x.isSource);
      const where = p.state === 'home' ? 'in casa' : p.state === 'not_home' ? 'fuori' : ['unknown', 'unavailable'].includes(p.state) ? 'posizione sconosciuta' : p.state;
      const km = d?.distance != null ? (d.distance < 1000 ? `${d.distance} m` : `${(d.distance / 1000).toFixed(1).replace('.', ',')} km`) : null;
      const man = this.presence[p.id] ? ' — ignorato: presenza impostata a mano' : '';
      this.log(`${p.name}: ${where} secondo Home Assistant${t ? ` (da ${t.name}${km ? `, a ${km} da casa` : ''}${t.address ? `, ${t.address}` : ''})` : km ? ` (a ${km} da casa)` : ''}${man}`, null);
    }
  }

  private personName(id: string) { return (this.src.people?.() ?? []).find(p => p.id === id)?.name ?? id.replace(/^person\./, ''); }

  /** Presenza a mano di una persona (null = di nuovo dalla posizione del telefono). */
  setPresence(id: string, state: PresenceState | null, hours: number | null, user: string | null) {
    if (!(this.src.people?.() ?? []).some(p => p.id === id)) throw new Error('Persona non trovata');
    const name = this.personName(id), by = user ? ` — da ${user}` : '';
    if (state == null) {
      if (!this.presence[id]) return;
      delete this.presence[id];
      this.log(`Presenza di ${name}: di nuovo dalla posizione del telefono${by}`, null);
    } else {
      if (!['casa', 'fuori', 'ignora'].includes(state)) throw new Error('Stato non valido');
      const until = hours && hours > 0 ? Date.now() + Math.min(hours, 24 * 60) * 3_600_000 : null;
      this.presence[id] = { state, until, by: user, since: Date.now() };
      this.log(`Presenza di ${name} impostata a mano: ${PRESENCE_LABEL[state]}${until ? ` fino a ${new Date(until).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ', finché non la cambi'}${by}`, null);
    }
    this.store.setSetting('presenza', this.presence);
  }

  /** Modalità della casa, applicata subito (senza passare dal salvataggio delle automazioni). */
  setMode(mode: HouseMode, vacationUntil: number | null | undefined, user: string | null) {
    if (!['auto', 'casa', 'fuori', 'notte', 'vacanza'].includes(mode)) throw new Error('Modalità non valida');
    const changed = this.settings.houseMode !== mode;
    this.settings.houseMode = mode;
    if (vacationUntil !== undefined) this.settings.vacationUntil = vacationUntil ? Number(vacationUntil) : null;
    if (mode !== 'vacanza') this.settings.vacationUntil = null;
    this.store.setSetting(KEY, this.settings);
    if (changed) this.log(`Modalità della casa: ${MODE_LABEL[mode]}${mode === 'vacanza' && this.settings.vacationUntil ? ` fino al ${new Date(this.settings.vacationUntil).toLocaleDateString('it-IT')}` : ''}${user ? ` — da ${user}` : ''}`, null);
  }

  roomAuto(room: Room): RoomAuto {
    if (!this.settings.rooms[room.id]) { this.settings.rooms[room.id] = defaultRoom(room.name); this.store.setSetting(KEY, this.settings); }
    return this.settings.rooms[room.id];
  }

  save(input: any, user: string | null) {
    const before = this.settings;
    // la modalità della casa si cambia solo con setMode: un pannello aperto da tempo non deve riportarla indietro
    this.settings = { ...sanitizeAuto(input, this.settings), houseMode: before.houseMode, vacationUntil: before.vacationUntil };
    this.store.setSetting(KEY, this.settings);
    const parts: string[] = [];
    if (before.enabled !== this.settings.enabled) parts.push(this.settings.enabled ? 'NIDO gestisce gli obiettivi delle valvole' : 'automazioni sospese: gli obiettivi restano quelli attuali');
    this.log(`Automazioni aggiornate${parts.length ? `: ${parts.join(', ')}` : ''}${user ? ` — da ${user}` : ''}`, null);
  }

  setOverride(roomId: string, value: number | null, hours: number | null, user: string | null) {
    const room = this.src.rooms().find(r => r.id === roomId);
    if (!room) throw new Error('Stanza non trovata');
    // senza dimenticare l'ultimo valore applicato, il controllo "cambiato sulla valvola" rivedrebbe subito
    // l'obiettivo manuale ancora presente sulla valvola e ricreerebbe l'intervento appena annullato
    if (value == null) { delete this.overrides[roomId]; this.applied.delete(roomId); this.log(`Intervento manuale annullato: si torna al programma${user ? ` — da ${user}` : ''}`, roomId); }
    else {
      const until = hours ? Date.now() + hours * 3_600_000 : scheduleAt(this.roomAuto(room), Date.now()).next;
      this.overrides[roomId] = { value: clampT(value, 20), until, source: hours ? 'boost' : 'pannello' };
      this.log(`Obiettivo ${fmt(this.overrides[roomId].value)} °C fino alle ${hm(until)}${user ? ` — da ${user}` : ''}`, roomId);
    }
    this.store.setSetting('override', this.overrides);
  }

  /** Persone considerate e modalità effettiva della casa. */
  houseState(now = Date.now()) {
    const s = this.settings;
    // contano solo le persone con una posizione nota: una persona senza dispositivo collegato (stato "unknown")
    // o con il telefono non raggiungibile non deve far credere che la casa sia vuota
    this.trackPeople();
    // presenze a mano scadute
    let expired = false;
    for (const [id, m] of Object.entries(this.presence)) if (m.until && now > m.until) { delete this.presence[id]; expired = true; this.log(`Fine della presenza a mano di ${this.personName(id)}: di nuovo dalla posizione del telefono`, null); }
    if (expired) this.store.setSetting('presenza', this.presence);
    const all: PersonView[] = (this.src.people?.() ?? []).filter(p => !s.persons.length || s.persons.includes(p.id))
      .map(p => { const m = this.presence[p.id] ?? null; return { ...p, gpsHome: p.home, manual: m, home: m ? m.state === 'casa' : p.home }; });
    // una presenza a mano vale sempre, anche senza telefono collegato
    const ppl = all.filter(p => p.manual ? p.manual.state !== 'ignora' : p.state !== 'unknown' && p.state !== 'unavailable' && p.trackers > 0);
    const ignored = all.filter(p => !ppl.includes(p));
    const empty = ppl.length > 0 && ppl.every(p => !p.home);
    if (empty) this.emptySince ??= now; else this.emptySince = null;
    let mode: Exclude<HouseMode, 'auto'>;
    let why: string;
    if (s.houseMode === 'vacanza' && s.vacationUntil && now > s.vacationUntil) { this.settings.houseMode = 'auto'; this.settings.vacationUntil = null; this.store.setSetting(KEY, this.settings); this.log('Fine della vacanza: modalità automatica', null); }
    if (s.houseMode === 'auto') {
      const away = this.emptySince != null && now - this.emptySince >= s.awayDelayMin * 60_000;
      mode = away ? 'fuori' : 'casa';
      why = !ppl.length ? (all.length ? 'posizione delle persone sconosciuta: si segue il programma' : 'nessuna persona in Home Assistant: si segue il programma') : away ? `tutti fuori da ${Math.round((now - this.emptySince!) / 60_000)} min` : empty ? `tutti fuori, Fuori tra ${Math.max(0, Math.ceil((s.awayDelayMin * 60_000 - (now - this.emptySince!)) / 60_000))} min` : `in casa: ${ppl.filter(p => p.home).map(p => p.manual ? `${p.name} (a mano)` : p.name).join(', ')}`;
    } else { mode = s.houseMode; why = 'scelta a mano'; }
    if (ignored.length) why += ` · ignorate: ${ignored.map(p => `${p.name} (${p.manual ? 'a mano' : p.trackers ? 'posizione sconosciuta' : 'senza dispositivo'})`).join(', ')}`;
    return { mode, why, people: ppl, ignored, all, empty, emptySince: this.emptySince, houseMode: s.houseMode, vacationUntil: s.vacationUntil };
  }

  /** Calcola e applica l'obiettivo di ogni stanza. Chiamato a ogni ciclo, dopo la lettura. */
  async run(views: { room: Room; sample: Sample | null; status: RoomStatus | null }[], now = Date.now()) {
    const s = this.settings;
    const house = this.houseState(now);
    const out = this.outdoor();
    const prevMode = (this as any)._mode;
    if (prevMode && prevMode !== house.mode && s.enabled) this.log(`Casa: ${MODE_LABEL[house.mode]} (${house.why})`, null);
    (this as any)._mode = house.mode;
    const decisions: RoomDecision[] = [];
    for (const v of views) {
      const { room, sample } = v;
      const ra = this.roomAuto(room);
      const reasons: string[] = [];
      const sch = scheduleAt(ra, now);
      let level: Level | 'fuori' | 'vacanza' = sch.level;
      if (house.mode === 'fuori') level = 'fuori';
      else if (house.mode === 'vacanza') level = 'vacanza';
      else if (house.mode === 'notte') level = 'notte';
      const base = ra.temps[level];
      reasons.push(`${LEVEL_LABEL[level]} ${fmt(base)} °C${level === sch.level ? ' dal programma' : ` (casa: ${MODE_LABEL[house.mode].toLowerCase()})`}`);
      let target = base;

      // umidità: pareti fredde e aria umida → mezzo grado in più tiene le superfici sopra il punto critico
      const srh = sample?.tRoom != null && sample.hRoom != null && out.temp != null ? surfaceRH(sample.tRoom, sample.hRoom, out.temp) : null;
      const risk = srh != null && srh >= 80;
      if (s.humidity.enabled && s.humidity.antiMould && risk && level !== 'vacanza' && s.humidity.boost > 0) {
        target += s.humidity.boost;
        reasons.push(`+${fmt(s.humidity.boost)} °C contro la condensa (umidità sulle pareti ${Math.round(srh!)} %)`);
        if (!this.mouldOn.has(room.id)) { this.mouldOn.add(room.id); this.log(`Rischio di condensa sulle pareti (${Math.round(srh!)} %): obiettivo +${fmt(s.humidity.boost)} °C`, room.id, 'umidita'); }
      } else if (this.mouldOn.has(room.id) && (srh == null || srh < 75)) { this.mouldOn.delete(room.id); this.log('Rischio di condensa rientrato', room.id, 'umidita'); }

      // finestra aperta: calo rapido della temperatura della stanza
      const win = this.windowCheck(room, now);
      if (win) { target = s.window.temp; reasons.push(`finestra aperta: ${fmt(s.window.temp)} °C fino alle ${hm(win.until)} circa`); }

      // intervento a mano
      let ov: Override | null = this.overrides[room.id] ?? null;
      if (ov && now > ov.until) { delete this.overrides[room.id]; this.applied.delete(room.id); this.store.setSetting('override', this.overrides); this.log('Fine dell\'intervento manuale: si torna al programma', room.id); ov = null; }
      // cambio fatto sulla valvola (ghiera o app): lo si rispetta fino al prossimo cambio di programma
      const ap = this.applied.get(room.id);
      // la valvola ha confermato l'ultimo comando: da qui in poi un valore diverso è un cambio vero
      if (ap && sample?.setpoint != null && Math.abs(sample.setpoint - ap.value) < 0.25) { ap.prev = null; ap.tries = 0; }
      // la valvola è rimasta al valore di prima: il comando di NIDO non è arrivato, non è un cambio a mano
      const notTaken = !!ap && ap.prev != null && sample?.setpoint != null && Math.abs(sample.setpoint - ap.prev) < 0.25;
      if (s.enabled && ra.enabled && sample?.setpoint != null && ap && !notTaken && now - ap.ts > 3 * 60_000 && Math.abs(sample.setpoint - ap.value) >= 0.5 && !win
          && (!ov || Math.abs(sample.setpoint - ov.value) >= 0.5)) {
        ov = { value: sample.setpoint, until: sch.next, source: 'valvola' };
        this.overrides[room.id] = ov; this.store.setSetting('override', this.overrides);
        this.log(`Obiettivo cambiato sulla valvola a ${fmt(sample.setpoint)} °C: lo rispetto fino alle ${hm(sch.next)}`, room.id);
      }
      if (ov && !win) { target = ov.value; reasons.push(`a mano ${fmt(ov.value)} °C fino alle ${hm(ov.until)}`); }

      target = Math.round(target * 2) / 2;
      let skipped: string | null = null;
      const managed = s.enabled && ra.enabled;
      if (!managed) skipped = !s.enabled ? 'automazioni sospese' : 'stanza esclusa dalle automazioni';
      else if (sample?.mode === 'off') skipped = 'riscaldamento spento sulla valvola: non lo riaccendo';
      else if (sample?.setpoint == null) skipped = 'obiettivo della valvola non leggibile';
      if (managed && !skipped && Math.abs((sample!.setpoint as number) - target) >= 0.25 && this.src.act) {
        const last = this.applied.get(room.id);
        const retry = !!last && last.value === target && notTaken && now - last.ts > 3 * 60_000;
        if (!last || last.value !== target || now - last.ts > 10 * 60_000 || retry) {
          try {
            const before = sample!.setpoint as number;
            await this.src.act(room, { action: 'set_temperature', value: target });
            const tries = retry ? (last!.tries ?? 0) + 1 : 0;
            this.applied.set(room.id, { value: target, ts: now, prev: retry ? last!.prev : before, tries });
            // il valore della valvola resta quello letto: lo confermerà lei alla prossima lettura
            if (retry) {
              this.log(`La valvola è rimasta a ${fmt(before)} °C: il comando di NIDO non è arrivato, lo rimando (${fmt(target)} °C, tentativo ${tries + 1})`, room.id);
              if (tries === 3) this.log(`La valvola non accetta i comandi da 4 tentativi: controlla che sia raggiungibile in Zigbee2MQTT (batteria, segnale)`, room.id);
            } else this.log(`Obiettivo ${fmt(target)} °C · ${reasons[reasons.length - 1]}`, room.id);
          } catch (e) { skipped = `comando non riuscito: ${e instanceof Error ? e.message : e}`; }
        }
        if (notTaken && (last?.tries ?? 0) >= 3) reasons.push(`la valvola non ha ancora preso il comando (resta a ${fmt(last!.prev!)} °C)`);
      } else if (managed && !skipped && sample?.setpoint != null && !this.applied.has(room.id)) this.applied.set(room.id, { value: sample.setpoint, ts: now });

      this.humidityNotify(room, sample, out, now);
      const nxt = scheduleAt(ra, sch.next);
      decisions.push({
        room: room.id, name: room.name, managed, level, levelLabel: LEVEL_LABEL[level], base, target: managed ? target : null,
        current: sample?.setpoint ?? null, reasons, window: { open: !!win, since: win?.since ?? null, until: win?.until ?? null },
        override: ov, mould: { surfaceRH: srh != null ? Math.round(srh) : null, risk },
        next: sch.next < Number.MAX_SAFE_INTEGER ? { at: sch.next, level: nxt.level, temp: ra.temps[house.mode === 'casa' || house.mode === 'notte' ? nxt.level : (house.mode as 'fuori' | 'vacanza')] } : null,
        skipped,
      });
    }
    this.decisions = decisions;
    return { house, decisions };
  }

  /** Finestra aperta: la stanza perde almeno `dropC` gradi in 6 minuti. Si chiude dopo `minutes` se non scende più. */
  private windowCheck(room: Room, now: number) {
    const s = this.settings.window;
    const open = this.windows.get(room.id);
    if (!s.enabled) { this.windows.delete(room.id); return null; }
    const recent = this.store.history(room.id, now - 12 * 60_000, 100).filter(x => x.tRoom != null);
    const last = recent.at(-1)?.tRoom ?? null;
    if (!open) {
      const ref = recent.filter(x => x.ts >= now - 7 * 60_000)[0]?.tRoom ?? null;
      if (last != null && ref != null && ref - last >= s.dropC) {
        const w = { since: now, until: now + s.minutes * 60_000, tempAt: last };
        this.windows.set(room.id, w);
        this.log(`Finestra aperta? La stanza è scesa di ${fmt(ref - last)} °C in pochi minuti: valvola a ${fmt(s.temp)} °C`, room.id, 'automazione');
        return w;
      }
      return null;
    }
    if (now >= open.until) {
      const five = recent.filter(x => x.ts >= now - 5 * 60_000);
      const still = five.length >= 2 && (five[0].tRoom as number) - (five.at(-1)!.tRoom as number) >= 0.2;
      if (still && now - open.since < 45 * 60_000) { open.until = now + 5 * 60_000; return open; }
      this.windows.delete(room.id);
      this.log('Finestra chiusa (la temperatura non scende più): si torna all\'obiettivo', room.id, 'automazione');
      return null;
    }
    return open;
  }

  /** Avviso per arieggiare: umidità alta da 30 minuti o picco improvviso, e fuori l'aria è più secca. */
  private humidityNotify(room: Room, sample: Sample | null, out: { temp: number | null; hum: number | null }, now: number) {
    const h = this.settings.humidity;
    if (!h.enabled || !h.notify || !sample || sample.hRoom == null || sample.tRoom == null) return;
    const recent = this.store.history(room.id, now - 25 * 60_000, 50).filter(x => x.hRoom != null);
    const min = recent.length ? Math.min(...recent.map(x => x.hRoom as number)) : sample.hRoom;
    const spike = sample.hRoom - min >= h.spike;
    if (sample.hRoom >= h.high) this.highSince.set(room.id, this.highSince.get(room.id) ?? now); else this.highSince.delete(room.id);
    const long = (this.highSince.get(room.id) ?? now) <= now - 30 * 60_000;
    if (!spike && !long) return;
    if (now - (this.lastNotify.get(room.id) ?? 0) < 3 * 3_600_000) return;
    const ahIn = absHumidity(sample.tRoom, sample.hRoom);
    const ahOut = out.temp != null && out.hum != null ? absHumidity(out.temp, out.hum) : null;
    const useful = ahOut == null || ahOut < ahIn - 1.5;
    if (!useful) return;
    this.lastNotify.set(room.id, now);
    const msg = `${room.name}: umidità ${Math.round(sample.hRoom)} %${spike ? ` (+${Math.round(sample.hRoom - min)} in pochi minuti)` : ''}. ${ahOut != null ? `Fuori l'aria è più secca (${ahOut.toFixed(1).replace('.', ',')} contro ${ahIn.toFixed(1).replace('.', ',')} g/m³): ` : ''}apri la finestra per 5–10 minuti.`;
    this.log(`Consiglio: arieggiare — ${msg}`, room.id, 'umidita');
    for (const svc of h.services) this.src.service?.('notify', svc, null, { title: 'Arieggia', message: msg, data: { tag: `nido-clima-umidita-${room.id}` } }).catch(() => {});
  }
}
