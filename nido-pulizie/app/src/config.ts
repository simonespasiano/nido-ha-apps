import { existsSync, readFileSync } from 'node:fs';

export interface Options {
  indirizzo_ip: string;
  porta: number;
  persone: string[];
  pubblica_in_home_assistant: boolean;
  conserva_giorni: number;
  debug: boolean;
}

const DEFAULTS: Options = { indirizzo_ip: '', porta: 9002, persone: [], pubblica_in_home_assistant: true, conserva_giorni: 365, debug: false };

export const DEMO = process.env.DEMO === '1';
export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const PORT = Number(process.env.PORT ?? 8099);

export function loadOptions(): Options {
  const path = process.env.OPTIONS_PATH ?? `${DATA_DIR}/options.json`;
  let raw: any = {};
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) { console.error('[config] options.json non leggibile, uso i valori predefiniti:', err); }
  }
  const o: Options = { ...DEFAULTS, ...raw, persone: Array.isArray(raw.persone) ? raw.persone : [] };
  if (process.env.NARWAL_IP) o.indirizzo_ip = process.env.NARWAL_IP;
  o.indirizzo_ip = String(o.indirizzo_ip ?? '').trim().replace(/^wss?:\/\//, '').replace(/[:/].*$/, '');
  return o;
}
