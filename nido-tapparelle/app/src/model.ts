/** Impostazioni salvate: tapparelle, scenari, automazioni e comportamento della casa. */

export type Mode = 'auto' | 'casa' | 'fuori' | 'vacanza' | 'pausa';
export type Season = 'estate' | 'inverno' | 'mezza';
export type Lockout = 'nessuno' | 'non_chiudere' | 'limita';

export interface ShutterSettings {
  /** Le automazioni di NIDO possono muoverla. */
  enabled: boolean;
  /** Nome scelto nell'app (vuoto = quello di Home Assistant). */
  label: string;
  /** Gruppo libero, ad esempio "Piano terra" o "Zona notte". */
  group: string;
  /** Verso dove guarda la finestra, in gradi (0 nord, 90 est, 180 sud, 270 ovest). */
  orientation: number | null;
  /** Ampiezza del cono di sole, in gradi per lato. */
  sunHalfWidth: number;
  /** Posizione di ombra quando il sole batte (0 chiusa, 100 aperta). */
  shadePos: number;
  /** Apri d'inverno quando c'è sole sulla facciata. */
  winterGain: boolean;
  /** Contatto porta/finestra: "auto" = quello nella stessa area, null = nessuno. */
  contact: string | null | 'auto';
  lockout: Lockout;
  /** Con "limita": posizione minima con la finestra aperta. */
  lockoutPos: number;
  /** Posizione preferita (pulsante ★). */
  favorite: number;
  /** Sensore di luce proprio della facciata (facoltativo). */
  lux: string | null;
}

export interface GlobalSettings {
  mode: Mode;
  vacationUntil: number | null;
  /** Dopo un comando a mano: per quanto le automazioni lasciano stare quella tapparella. */
  holdMode: 'minuti' | 'prossimo' | 'mai';
  holdMinutes: number;
  season: 'auto' | Season;
  outdoor: { temp: string | null; lux: string | null; wind: string | null; rain: string | null; weather: string | null };
  sun: {
    enabled: boolean; minElevation: number; minOutdoorTemp: number; minLux: number; minIndoorTemp: number | null;
    delayMin: number; restore: boolean; onlySummer: boolean; awayPos: number | null;
  };
  winter: { enabled: boolean };
  weather: { windAbove: number | null; windAction: 'nessuna' | 'apri' | 'chiudi'; rainAction: 'nessuna' | 'apri' | 'chiudi' };
  simulate: { enabled: boolean; jitter: number };
  notify: { service: string | null; lockout: boolean; weather: boolean; failure: boolean; rules: boolean };
  people: string[];
}

export interface Scene { id: string; name: string; icon: string; positions: Record<string, number> }

export type Trigger =
  | { type: 'orario'; time: string }
  | { type: 'sole'; event: 'alba' | 'tramonto'; offset: number }
  | { type: 'elevazione'; op: 'sopra' | 'sotto'; value: number }
  | { type: 'presenza'; event: 'tutti_fuori' | 'primo_rientro' }
  | { type: 'sensore'; entity: string; op: 'sopra' | 'sotto'; value: number; forMin: number }
  | { type: 'stato'; entity: string; to: string; forMin: number }
  | { type: 'modalita'; to: Mode };

export type RuleAction =
  | { type: 'posizione'; targets: string[]; position: number }
  | { type: 'scenario'; scene: string }
  | { type: 'preferita'; targets: string[] };

export interface Rule {
  id: string; name: string; enabled: boolean;
  trigger: Trigger;
  /** 0 = domenica … 6 = sabato; vuoto = tutti i giorni. */
  days: number[];
  conditions: {
    after: string | null; before: string | null;
    modes: Mode[]; seasons: Season[];
    presence: 'casa' | 'fuori' | null;
    entity: string | null; entityState: string | null;
  };
  action: RuleAction;
  /** Muove anche le tapparelle appena comandate a mano. */
  overrideManual: boolean;
  /** Solo se la tapparella deve aprirsi (o chiudersi) rispetto a ora: non "riapre" chi è già più aperta. */
  onlyDirection: 'tutte' | 'solo_apri' | 'solo_chiudi';
  notify: boolean;
}

export const DEFAULT_GLOBAL: GlobalSettings = {
  mode: 'auto', vacationUntil: null,
  holdMode: 'prossimo', holdMinutes: 120,
  season: 'auto',
  outdoor: { temp: null, lux: null, wind: null, rain: null, weather: null },
  sun: { enabled: false, minElevation: 8, minOutdoorTemp: 24, minLux: 20000, minIndoorTemp: null, delayMin: 10, restore: true, onlySummer: true, awayPos: null },
  winter: { enabled: false },
  weather: { windAbove: null, windAction: 'nessuna', rainAction: 'nessuna' },
  simulate: { enabled: true, jitter: 20 },
  notify: { service: null, lockout: true, weather: true, failure: true, rules: false },
  people: [],
};

export const DEFAULT_SHUTTER: ShutterSettings = {
  enabled: true, label: '', group: '', orientation: null, sunHalfWidth: 70, shadePos: 30, winterGain: false,
  contact: 'auto', lockout: 'non_chiudere', lockoutPos: 100, favorite: 50, lux: null,
};

export const MODE_LABEL: Record<Mode, string> = { auto: 'Automatica', casa: 'In casa', fuori: 'Fuori casa', vacanza: 'Vacanza', pausa: 'In pausa' };
export const SEASON_LABEL: Record<Season, string> = { estate: 'Estate', inverno: 'Inverno', mezza: 'Mezza stagione' };

const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const str = (v: unknown, max = 80) => String(v ?? '').trim().slice(0, max);
const ent = (v: unknown) => (typeof v === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(v) ? v : null);
const time = (v: unknown) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
export const MODES = ['auto', 'casa', 'fuori', 'vacanza', 'pausa'] as const;
export const SEASONS = ['estate', 'inverno', 'mezza'] as const;

export function sanitizeGlobal(b: any, cur: GlobalSettings): GlobalSettings {
  const o = b?.outdoor ?? {}, s = b?.sun ?? {}, w = b?.weather ?? {}, sim = b?.simulate ?? {}, n = b?.notify ?? {};
  return {
    mode: pick(b?.mode, MODES, cur.mode),
    vacationUntil: b?.vacationUntil == null ? null : clamp(b.vacationUntil, 0, 8.64e15, 0) || null,
    holdMode: pick(b?.holdMode, ['minuti', 'prossimo', 'mai'] as const, cur.holdMode),
    holdMinutes: clamp(b?.holdMinutes, 5, 24 * 60, cur.holdMinutes),
    season: pick(b?.season, ['auto', ...SEASONS] as const, cur.season),
    outdoor: { temp: ent(o.temp), lux: ent(o.lux), wind: ent(o.wind), rain: ent(o.rain), weather: ent(o.weather) },
    sun: {
      enabled: !!s.enabled, minElevation: clamp(s.minElevation, 0, 60, 8), minOutdoorTemp: clamp(s.minOutdoorTemp, -20, 45, 24),
      minLux: clamp(s.minLux, 0, 150000, 20000), minIndoorTemp: s.minIndoorTemp == null || s.minIndoorTemp === '' ? null : clamp(s.minIndoorTemp, 10, 40, 25),
      delayMin: clamp(s.delayMin, 0, 60, 10), restore: s.restore !== false, onlySummer: s.onlySummer !== false,
      awayPos: s.awayPos == null || s.awayPos === '' ? null : clamp(s.awayPos, 0, 100, 0),
    },
    winter: { enabled: !!b?.winter?.enabled },
    weather: {
      windAbove: w.windAbove == null || w.windAbove === '' ? null : clamp(w.windAbove, 5, 200, 50),
      windAction: pick(w.windAction, ['nessuna', 'apri', 'chiudi'] as const, 'nessuna'),
      rainAction: pick(w.rainAction, ['nessuna', 'apri', 'chiudi'] as const, 'nessuna'),
    },
    simulate: { enabled: sim.enabled !== false, jitter: clamp(sim.jitter, 0, 90, 20) },
    notify: {
      service: typeof n.service === 'string' && /^[a-z0-9_]+$/.test(n.service) ? n.service : null,
      lockout: n.lockout !== false, weather: n.weather !== false, failure: n.failure !== false, rules: !!n.rules,
    },
    people: Array.isArray(b?.people) ? b.people.map(ent).filter(Boolean) as string[] : cur.people,
  };
}

export function sanitizeShutter(b: any, cur: ShutterSettings): ShutterSettings {
  const contact = b?.contact === 'auto' ? 'auto' : b?.contact == null || b?.contact === '' ? null : ent(b.contact);
  return {
    enabled: b?.enabled == null ? cur.enabled : !!b.enabled,
    label: b?.label == null ? cur.label : str(b.label, 60),
    group: b?.group == null ? cur.group : str(b.group, 40),
    orientation: b?.orientation === undefined ? cur.orientation : b.orientation == null || b.orientation === '' ? null : clamp(b.orientation, 0, 359, 180),
    sunHalfWidth: b?.sunHalfWidth == null ? cur.sunHalfWidth : clamp(b.sunHalfWidth, 20, 90, 70),
    shadePos: b?.shadePos == null ? cur.shadePos : clamp(b.shadePos, 0, 100, 30),
    winterGain: b?.winterGain == null ? cur.winterGain : !!b.winterGain,
    contact: b?.contact === undefined ? cur.contact : contact,
    lockout: pick(b?.lockout, ['nessuno', 'non_chiudere', 'limita'] as const, cur.lockout),
    lockoutPos: b?.lockoutPos == null ? cur.lockoutPos : clamp(b.lockoutPos, 0, 100, 100),
    favorite: b?.favorite == null ? cur.favorite : clamp(b.favorite, 0, 100, 50),
    lux: b?.lux === undefined ? cur.lux : ent(b.lux),
  };
}

export function sanitizeScene(b: any, id: string): Scene {
  const positions: Record<string, number> = {};
  for (const [k, v] of Object.entries(b?.positions ?? {})) if (/^[a-z0-9_]+$/.test(k)) positions[k] = clamp(v, 0, 100, 0);
  const name = str(b?.name, 40);
  if (!name) throw new Error('Il nome dello scenario è obbligatorio');
  return { id, name, icon: str(b?.icon, 4) || '🪟', positions };
}

function sanitizeTrigger(t: any): Trigger {
  switch (t?.type) {
    case 'orario': { const tm = time(t.time); if (!tm) throw new Error('Orario non valido'); return { type: 'orario', time: tm }; }
    case 'sole': return { type: 'sole', event: pick(t.event, ['alba', 'tramonto'] as const, 'tramonto'), offset: clamp(t.offset, -240, 240, 0) };
    case 'elevazione': return { type: 'elevazione', op: pick(t.op, ['sopra', 'sotto'] as const, 'sopra'), value: clamp(t.value, -10, 70, 10) };
    case 'presenza': return { type: 'presenza', event: pick(t.event, ['tutti_fuori', 'primo_rientro'] as const, 'tutti_fuori') };
    case 'sensore': { const e = ent(t.entity); if (!e) throw new Error('Scegli il sensore'); return { type: 'sensore', entity: e, op: pick(t.op, ['sopra', 'sotto'] as const, 'sopra'), value: clamp(t.value, -1e6, 1e6, 0), forMin: clamp(t.forMin, 0, 240, 0) }; }
    case 'stato': { const e = ent(t.entity); if (!e) throw new Error('Scegli l\'entità'); return { type: 'stato', entity: e, to: str(t.to, 40) || 'on', forMin: clamp(t.forMin, 0, 240, 0) }; }
    case 'modalita': return { type: 'modalita', to: pick(t.to, MODES, 'fuori') };
    default: throw new Error('Tipo di avvio non valido');
  }
}

const targets = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x)).filter(x => /^(all|area:[a-z0-9_]+|gruppo:.{1,40}|[a-z0-9_]+)$/.test(x)) : []);

export function sanitizeRule(b: any, id: string): Rule {
  const name = str(b?.name, 60);
  if (!name) throw new Error('Il nome dell\'automazione è obbligatorio');
  const a = b?.action ?? {};
  let action: RuleAction;
  if (a.type === 'scenario') { if (!a.scene) throw new Error('Scegli lo scenario'); action = { type: 'scenario', scene: str(a.scene, 40) }; }
  else if (a.type === 'preferita') action = { type: 'preferita', targets: targets(a.targets) };
  else action = { type: 'posizione', targets: targets(a.targets), position: clamp(a.position, 0, 100, 0) };
  if (action.type !== 'scenario' && !action.targets.length) throw new Error('Scegli almeno una tapparella');
  const c = b?.conditions ?? {};
  return {
    id, name, enabled: b?.enabled !== false,
    trigger: sanitizeTrigger(b?.trigger),
    days: Array.isArray(b?.days) ? [...new Set(b.days.map(Number).filter((d: number) => d >= 0 && d <= 6))] as number[] : [],
    conditions: {
      after: time(c.after), before: time(c.before),
      modes: Array.isArray(c.modes) ? c.modes.filter((m: any) => MODES.includes(m)) : [],
      seasons: Array.isArray(c.seasons) ? c.seasons.filter((s: any) => SEASONS.includes(s)) : [],
      presence: c.presence === 'casa' || c.presence === 'fuori' ? c.presence : null,
      entity: ent(c.entity), entityState: c.entity ? str(c.entityState, 40) || null : null,
    },
    action,
    overrideManual: !!b?.overrideManual,
    onlyDirection: pick(b?.onlyDirection, ['tutte', 'solo_apri', 'solo_chiudi'] as const, 'tutte'),
    notify: !!b?.notify,
  };
}

export function defaultRules(): Rule[] {
  const base = { conditions: { after: null, before: null, modes: [], seasons: [], presence: null, entity: null, entityState: null },
    overrideManual: false, notify: false, enabled: false };
  return [
    { ...base, id: 'apri_feriali', name: 'Apri al mattino (feriali)', trigger: { type: 'orario', time: '07:30' }, days: [1, 2, 3, 4, 5],
      action: { type: 'posizione', targets: ['all'], position: 100 }, onlyDirection: 'solo_apri' },
    { ...base, id: 'apri_festivi', name: 'Apri al mattino (weekend)', trigger: { type: 'orario', time: '09:00' }, days: [0, 6],
      action: { type: 'posizione', targets: ['all'], position: 100 }, onlyDirection: 'solo_apri' },
    { ...base, id: 'chiudi_tramonto', name: 'Chiudi al tramonto', trigger: { type: 'sole', event: 'tramonto', offset: 20 }, days: [],
      action: { type: 'posizione', targets: ['all'], position: 0 }, onlyDirection: 'solo_chiudi' },
  ];
}
