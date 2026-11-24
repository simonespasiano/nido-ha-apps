import { existsSync, readFileSync } from 'node:fs';

export interface Options {
  /** Tapparelle da gestire (cover.*). Vuoto = tutte quelle trovate in Home Assistant. */
  tapparelle: string[];
  /** Tapparelle da ignorare (ad esempio porte del garage o tende da sole gestite altrove). */
  escludi: string[];
  /** Persone da considerare per "casa vuota". Vuoto = tutte. */
  persone: string[];
  pubblica_in_home_assistant: boolean;
  conserva_giorni: number;
  /** crea la plancia di Home Assistant con l'app (predefinito: sì) */
  plancia?: boolean;
}

const DEFAULTS: Options = {
  tapparelle: [],
  escludi: [],
  persone: [],
  pubblica_in_home_assistant: true,
  conserva_giorni: 365,
};

export const DEMO = process.env.DEMO === '1';
export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const PORT = Number(process.env.PORT ?? 8099);

export function loadOptions(): Options {
  const path = process.env.OPTIONS_PATH ?? `${DATA_DIR}/options.json`;
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
    return { ...DEFAULTS, ...raw, tapparelle: arr(raw.tapparelle), escludi: arr(raw.escludi), persone: arr(raw.persone) };
  } catch (err) {
    console.error('[config] options.json non leggibile, uso i valori predefiniti:', err);
    return { ...DEFAULTS };
  }
}
