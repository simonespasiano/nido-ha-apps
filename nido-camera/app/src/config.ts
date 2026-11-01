import { existsSync, readFileSync } from 'node:fs';

export interface Options {
  camera: string;                  // nome dell'abbinamento HomeKit in Home Assistant (vuoto = la prima camera trovata)
  sensori_movimento: string[];     // binary_sensor che fanno partire la registrazione (vuoto = quelli della camera)
  notifiche: string[];             // servizi notify, es. notify.mobile_app_iphone_di_simone
  persone: string[];               // person.* per "casa vuota" (vuoto = tutte)
  clip_dopo_movimento_secondi: number;
  clip_massima_secondi: number;
  conserva_giorni: number;
  spazio_massimo_gb: number;
  pubblica_in_home_assistant: boolean;
  debug: boolean;
}

const DEFAULTS: Options = {
  camera: '', sensori_movimento: [], notifiche: [], persone: [],
  clip_dopo_movimento_secondi: 20, clip_massima_secondi: 180, conserva_giorni: 14, spazio_massimo_gb: 20,
  pubblica_in_home_assistant: true, debug: false,
};

export const DEMO = process.env.DEMO === '1';
export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const MEDIA_DIR = process.env.MEDIA_DIR ?? (DEMO ? `${DATA_DIR}/media` : '/media/nido-camera');
export const HA_CONFIG_DIR = process.env.HA_CONFIG_DIR ?? '/homeassistant';
export const GO2RTC_BIN = process.env.GO2RTC_BIN ?? '/usr/local/bin/go2rtc';
export const PORT = Number(process.env.PORT ?? 8099);

export function loadOptions(): Options {
  const path = process.env.OPTIONS_PATH ?? `${DATA_DIR}/options.json`;
  let raw: any = {};
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) { console.error('[config] options.json non leggibile, uso i valori predefiniti:', err); }
  }
  const list = (v: any) => (Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : []);
  return {
    ...DEFAULTS, ...raw,
    camera: String(raw.camera ?? '').trim(),
    sensori_movimento: list(raw.sensori_movimento), notifiche: list(raw.notifiche).map(s => s.replace(/^notify\./, '')), persone: list(raw.persone),
  };
}
