import { existsSync, readFileSync } from 'node:fs';

export interface RoomOption {
  nome: string;
  valvola: string;
  sensore_temperatura: string;
  sensore_umidita?: string;
  termostato?: string;
  sensore_termosifone?: string;
}

export interface Options {
  stanze: RoomOption[];
  soglia_accensione: number;   // °C di differenza valvola-stanza oltre cui il calorifero è "caldo"
  soglia_spegnimento: number;  // °C sotto cui torna "freddo" (isteresi)
  intervallo_secondi: number;
  conserva_giorni: number;
  pubblica_sensori: boolean;
}

const DEFAULTS: Options = {
  stanze: [],
  soglia_accensione: 2.5,
  soglia_spegnimento: 1.2,
  intervallo_secondi: 60,
  conserva_giorni: 120,
  pubblica_sensori: true,
};

export const DEMO = process.env.DEMO === '1';
export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const PORT = Number(process.env.PORT ?? 8099);

export function loadOptions(): Options {
  const path = process.env.OPTIONS_PATH ?? `${DATA_DIR}/options.json`;
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { ...DEFAULTS, ...raw, stanze: Array.isArray(raw.stanze) ? raw.stanze : [] };
  } catch (err) {
    console.error('[config] options.json non leggibile, uso i valori predefiniti:', err);
    return { ...DEFAULTS };
  }
}
