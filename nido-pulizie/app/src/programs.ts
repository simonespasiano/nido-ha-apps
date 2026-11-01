import { randomUUID } from 'node:crypto';
import { sanitizeClean, type CleanSettings } from './protocol.js';

export type Trigger =
  | { kind: 'orario'; days: number[]; time: string }                                      // giorni 0=domenica … 6=sabato
  | { kind: 'uscita'; days: number[]; delayMin: number; from: string; to: string };       // quando la casa resta vuota

export interface Program {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  rooms: number[];                 // vuoto = tutte le stanze
  settings: CleanSettings;
  onlyIfEmpty: boolean;            // solo se non c'è nessuno in casa
  skipOccupied: boolean;           // salta le stanze con presenza rilevata
  minHoursSinceLast: number;       // salta le stanze pulite da meno di N ore (0 = mai)
  minBattery: number;              // %
  onReturn: 'continua' | 'base' | 'pausa'; // se qualcuno rientra durante la pulizia
  oncePerDay: boolean;             // per l'uscita: al massimo una volta al giorno
  lastRun?: number;
  lastResult?: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function sanitizeProgram(p: any, existing?: Program): Program {
  const days = (v: any) => Array.isArray(v) ? [...new Set(v.map(Number).filter(d => d >= 0 && d <= 6))].sort() : [0, 1, 2, 3, 4, 5, 6];
  const t = p?.trigger ?? {};
  const trigger: Trigger = t.kind === 'uscita'
    ? { kind: 'uscita', days: days(t.days), delayMin: Math.min(240, Math.max(0, Math.round(Number(t.delayMin) || 0))), from: HHMM.test(t.from) ? t.from : '08:00', to: HHMM.test(t.to) ? t.to : '20:00' }
    : { kind: 'orario', days: days(t.days), time: HHMM.test(t.time) ? t.time : '10:00' };
  const name = String(p?.name ?? '').trim().slice(0, 60);
  return {
    id: existing?.id ?? randomUUID(),
    name: name || (trigger.kind === 'uscita' ? 'Quando esco' : `Alle ${trigger.time}`),
    enabled: p?.enabled !== false,
    trigger,
    rooms: Array.isArray(p?.rooms) ? p.rooms.map(Number).filter((n: number) => Number.isInteger(n) && n > 0) : [],
    settings: sanitizeClean(p?.settings),
    onlyIfEmpty: !!p?.onlyIfEmpty,
    skipOccupied: p?.skipOccupied !== false,
    minHoursSinceLast: Math.min(720, Math.max(0, Number(p?.minHoursSinceLast) || 0)),
    minBattery: Math.min(90, Math.max(0, Math.round(Number(p?.minBattery ?? 30)))),
    onReturn: ['continua', 'base', 'pausa'].includes(p?.onReturn) ? p.onReturn : 'continua',
    oncePerDay: p?.oncePerDay !== false,
    lastRun: existing?.lastRun, lastResult: existing?.lastResult,
  };
}

const minutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function inWindow(now: Date, from: string, to: string) {
  const m = now.getHours() * 60 + now.getMinutes(), a = minutes(from), b = minutes(to);
  return a <= b ? m >= a && m <= b : m >= a || m <= b;
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Il programma a orario deve partire in questo minuto? */
export function dueByTime(p: Program, now: Date): boolean {
  if (!p.enabled || p.trigger.kind !== 'orario') return false;
  if (!p.trigger.days.includes(now.getDay())) return false;
  if (now.getHours() * 60 + now.getMinutes() !== minutes(p.trigger.time)) return false;
  return !p.lastRun || now.getTime() - p.lastRun > 50 * 60_000;
}

/** Il programma "quando esco" può partire adesso (casa vuota da abbastanza tempo)? */
export function dueByLeaving(p: Program, now: Date, emptySince: number | null): boolean {
  if (!p.enabled || p.trigger.kind !== 'uscita' || emptySince == null) return false;
  if (!p.trigger.days.includes(now.getDay()) || !inWindow(now, p.trigger.from, p.trigger.to)) return false;
  if (now.getTime() - emptySince < p.trigger.delayMin * 60_000) return false;
  if (p.lastRun && p.lastRun >= emptySince) return false;                // già partito per questa uscita
  if (p.oncePerDay && p.lastRun && sameDay(p.lastRun, now.getTime())) return false;
  return true;
}

/** Prossima esecuzione prevista di un programma a orario (per l'interfaccia). */
export function nextRun(p: Program, from = new Date()): number | null {
  if (!p.enabled || p.trigger.kind !== 'orario' || !p.trigger.days.length) return null;
  const m = minutes(p.trigger.time);
  for (let d = 0; d < 8; d++) {
    const c = new Date(from); c.setDate(c.getDate() + d); c.setHours(Math.floor(m / 60), m % 60, 0, 0);
    if (c.getTime() > from.getTime() && p.trigger.days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

export const DAY_NAMES = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

export function describeTrigger(t: Trigger): string {
  const d = t.days.length === 7 ? 'tutti i giorni' : t.days.length === 5 && [1, 2, 3, 4, 5].every(x => t.days.includes(x)) ? 'dal lunedì al venerdì' : t.days.map(x => DAY_NAMES[x]).join(', ');
  if (t.kind === 'orario') return `${d} alle ${t.time}`;
  return `${d}, quando la casa resta vuota${t.delayMin ? ` da ${t.delayMin} min` : ''}, tra le ${t.from} e le ${t.to}`;
}
