/** Comandi su termostati e valvole: modello comune a Home Assistant e alla demo. */

export interface ClimateControl {
  entity_id: string;
  name: string;
  setpoint: number | null;
  current: number | null;
  min: number;
  max: number;
  step: number;
  mode: string | null;
  modes: string[];
  preset: string | null;
  presets: string[];
  action: string | null; // hvac_action se la valvola lo riporta
}

export type ControlKind = 'switch' | 'lock' | 'select' | 'number' | 'button' | 'info';

export interface DeviceControl {
  entity_id: string;
  key: string;          // nome tecnico ricavato dall'entità (child_lock, battery…)
  name: string;         // nome in italiano
  help?: string;        // spiegazione breve
  domain: string;
  kind: ControlKind;
  state: string;
  unit?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  category: 'principale' | 'configurazione' | 'diagnostica';
}

export interface RoomControls {
  thermostat: ClimateControl | null; // termostato virtuale (Versatile/Better Thermostat)
  valve: ClimateControl | null;      // valvola reale
  device: DeviceControl[];           // altre entità del dispositivo valvola
  battery: number | null;
  linkquality: number | null;
  deviceName: string | null;
}

export type Action =
  | { action: 'set_temperature'; value: number; target?: 'thermostat' | 'valve' }
  | { action: 'set_mode'; value: string; target?: 'thermostat' | 'valve' }
  | { action: 'set_preset'; value: string; target?: 'thermostat' | 'valve' }
  | { action: 'entity'; entity_id: string; value?: string | number | boolean };

export interface ServiceCall {
  domain: string;
  service: string;
  entity_id: string;
  data: Record<string, unknown>;
  description: string; // per il diario
}

/** Nomi e spiegazioni in italiano delle funzioni più comuni (Zigbee2MQTT, Aqara E1 e simili). */
const KNOWN: Record<string, { name: string; help?: string; category?: DeviceControl['category'] }> = {
  child_lock: { name: 'Blocco bambini', help: 'Disattiva la ghiera e il pulsante della valvola', category: 'principale' },
  window_detection: { name: 'Rilevamento finestra aperta', help: 'La valvola si chiude da sola se la temperatura crolla', category: 'principale' },
  window_open: { name: 'Finestra aperta (rilevata)', category: 'diagnostica' },
  valve_detection: { name: 'Controllo anomalie valvola', help: 'Segnala se la valvola non riesce a muoversi', category: 'configurazione' },
  valve_alarm: { name: 'Allarme valvola', category: 'diagnostica' },
  calibrate: { name: 'Calibrazione corsa', help: 'Fa aprire e chiudere la valvola per misurarne la corsa. Utile dopo il montaggio', category: 'configurazione' },
  calibrated: { name: 'Calibrata', category: 'diagnostica' },
  calibration: { name: 'Calibrazione', category: 'configurazione' },
  motor_calibration: { name: 'Calibrazione motore', category: 'configurazione' },
  sensor: { name: 'Sensore usato dalla valvola', help: 'internal = il suo termometro, external = valore inviato da Home Assistant', category: 'configurazione' },
  external_temperature_input: { name: 'Temperatura esterna inviata', category: 'configurazione' },
  away_preset_temperature: { name: 'Temperatura in assenza', category: 'configurazione' },
  preset: { name: 'Preset della valvola', category: 'configurazione' },
  schedule: { name: 'Programma interno della valvola', help: 'Meglio lasciarlo spento: i programmi li gestisce Home Assistant', category: 'configurazione' },
  schedule_settings: { name: 'Impostazioni programma interno', category: 'configurazione' },
  local_temperature_calibration: { name: 'Correzione temperatura', help: 'Aggiunge o toglie gradi alla misura della valvola', category: 'configurazione' },
  position: { name: 'Apertura valvola', category: 'diagnostica' },
  battery: { name: 'Batteria', category: 'diagnostica' },
  voltage: { name: 'Tensione batteria', category: 'diagnostica' },
  linkquality: { name: 'Qualità del segnale', category: 'diagnostica' },
  identify: { name: 'Identifica', help: 'Fa lampeggiare la valvola per riconoscerla', category: 'configurazione' },
  update: { name: 'Aggiornamento firmware', category: 'diagnostica' },
};

const DOMAIN_KIND: Record<string, ControlKind> = {
  switch: 'switch', lock: 'lock', select: 'select', number: 'number', button: 'button',
  sensor: 'info', binary_sensor: 'info',
};

/** Ricava il nome tecnico dall'ID: "switch.valvola_camera_child_lock" con dispositivo "valvola_camera" → "child_lock". */
export function controlKey(entityId: string, deviceSlug: string | null): string {
  const obj = entityId.split('.')[1] ?? entityId;
  if (deviceSlug && obj.startsWith(deviceSlug + '_')) return obj.slice(deviceSlug.length + 1);
  const known = Object.keys(KNOWN).sort((a, b) => b.length - a.length).find(k => obj.endsWith('_' + k) || obj === k);
  return known ?? obj;
}

export function describeControl(
  entityId: string, friendly: string, deviceName: string | null, deviceSlug: string | null,
  state: string, attrs: Record<string, any>, entityCategory: string | null,
): DeviceControl | null {
  const domain = entityId.split('.')[0];
  const kind = DOMAIN_KIND[domain];
  if (!kind) return null;
  const key = controlKey(entityId, deviceSlug);
  const known = KNOWN[key];
  let name = known?.name ?? friendly;
  if (!known && deviceName && name.toLowerCase().startsWith(deviceName.toLowerCase())) {
    name = name.slice(deviceName.length).trim() || friendly;
    name = name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
  }
  const category = known?.category ?? (entityCategory === 'diagnostic' || kind === 'info' ? 'diagnostica'
    : entityCategory === 'config' ? 'configurazione' : 'principale');
  return {
    entity_id: entityId, key, name, help: known?.help, domain, kind, state,
    unit: attrs.unit_of_measurement,
    options: Array.isArray(attrs.options) ? attrs.options : undefined,
    min: typeof attrs.min === 'number' ? attrs.min : undefined,
    max: typeof attrs.max === 'number' ? attrs.max : undefined,
    step: typeof attrs.step === 'number' ? attrs.step : undefined,
    category,
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

export function describeClimate(entityId: string, attrs: Record<string, any>, state: string): ClimateControl {
  return {
    entity_id: entityId,
    name: attrs.friendly_name ?? entityId,
    setpoint: num(attrs.temperature),
    current: num(attrs.current_temperature),
    min: num(attrs.min_temp) ?? 5,
    max: num(attrs.max_temp) ?? 30,
    step: num(attrs.target_temp_step) ?? 0.5,
    mode: state ?? null,
    modes: Array.isArray(attrs.hvac_modes) ? attrs.hvac_modes : ['heat', 'off'],
    preset: attrs.preset_mode ?? null,
    presets: Array.isArray(attrs.preset_modes) ? attrs.preset_modes : [],
    action: attrs.hvac_action ?? null,
  };
}

const MODE_IT: Record<string, string> = { heat: 'Riscaldamento', off: 'Spento', auto: 'Automatico', cool: 'Raffrescamento', heat_cool: 'Caldo/freddo' };
export const modeLabel = (m: string) => MODE_IT[m] ?? m;
const PRESET_IT: Record<string, string> = { none: 'nessuno', eco: 'Eco', comfort: 'Comfort', boost: 'Boost', away: 'Fuori casa', frost: 'Antigelo', sleep: 'Notte', home: 'A casa', activity: 'Attività' };
const fmt = (n: number) => n.toFixed(1).replace('.', ',');

/**
 * Traduce un'azione dell'interfaccia in una chiamata di servizio, controllando che
 * l'entità appartenga alla stanza e che il valore sia ammesso. Lancia un errore leggibile altrimenti.
 */
export function buildCall(c: RoomControls, a: Action): ServiceCall {
  if (a.action === 'entity') {
    const d = c.device.find(x => x.entity_id === a.entity_id);
    if (!d) throw new Error('Entità non appartenente a questa valvola');
    switch (d.kind) {
      case 'switch': {
        const on = a.value === true || a.value === 'on';
        return { domain: 'switch', service: on ? 'turn_on' : 'turn_off', entity_id: d.entity_id, data: {}, description: `${d.name}: ${on ? 'attivato' : 'disattivato'}` };
      }
      case 'lock': {
        const lock = a.value === true || a.value === 'locked';
        return { domain: 'lock', service: lock ? 'lock' : 'unlock', entity_id: d.entity_id, data: {}, description: `${d.name}: ${lock ? 'attivato' : 'disattivato'}` };
      }
      case 'select': {
        const option = String(a.value);
        if (d.options && !d.options.includes(option)) throw new Error('Opzione non valida');
        return { domain: 'select', service: 'select_option', entity_id: d.entity_id, data: { option }, description: `${d.name}: ${option}` };
      }
      case 'number': {
        const value = Number(a.value);
        if (!Number.isFinite(value) || (d.min != null && value < d.min) || (d.max != null && value > d.max)) throw new Error('Valore fuori dai limiti');
        return { domain: 'number', service: 'set_value', entity_id: d.entity_id, data: { value }, description: `${d.name}: ${value}${d.unit ? ' ' + d.unit : ''}` };
      }
      case 'button':
        return { domain: 'button', service: 'press', entity_id: d.entity_id, data: {}, description: `${d.name}: avviato` };
      default:
        throw new Error('Questa voce è solo informativa');
    }
  }
  const target = a.target === 'valve' ? c.valve : (c.thermostat ?? c.valve);
  if (!target) throw new Error('Nessun termostato disponibile');
  if (a.action === 'set_temperature') {
    const v = Math.round(Number(a.value) / target.step) * target.step;
    if (!Number.isFinite(v) || v < target.min || v > target.max) throw new Error(`L'obiettivo deve stare tra ${fmt(target.min)} e ${fmt(target.max)} °C`);
    return { domain: 'climate', service: 'set_temperature', entity_id: target.entity_id, data: { temperature: v }, description: `Obiettivo impostato a ${fmt(v)} °C` };
  }
  if (a.action === 'set_mode') {
    if (!target.modes.includes(a.value)) throw new Error('Modalità non disponibile');
    return { domain: 'climate', service: 'set_hvac_mode', entity_id: target.entity_id, data: { hvac_mode: a.value }, description: `Modalità: ${modeLabel(a.value)}` };
  }
  if (a.action === 'set_preset') {
    if (!target.presets.includes(a.value)) throw new Error('Preset non disponibile');
    return { domain: 'climate', service: 'set_preset_mode', entity_id: target.entity_id, data: { preset_mode: a.value }, description: `Preset: ${PRESET_IT[a.value] ?? a.value}` };
  }
  throw new Error('Azione sconosciuta');
}
