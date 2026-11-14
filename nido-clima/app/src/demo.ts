import type { DataSource, EntityInfo, Room, Sample } from './types.js';
import { buildCall, type Action, type DeviceControl, type RoomControls } from './controls.js';

/**
 * Simulatore per provare l'app senza Home Assistant (DEMO=1).
 * Modello termico semplice: impianto centralizzato a orari, valvola che apre se la stanza
 * è sotto l'obiettivo, termosifone che si scalda/raffredda con inerzia, stanza che disperde verso l'esterno.
 */
interface SimRoom {
  room: Room;
  kRad: number; kLoss: number; radMax: number;
  comfort: number; eco: number; night: number;
  tRoom: number; tRad: number; open: boolean; lastTs: number;
  windowAt?: [number, number]; // minuti del giorno in cui la finestra resta aperta
  mode: 'heat' | 'off';
  preset: string;
  manual?: { value: number; scheduled: number }; // obiettivo manuale finché il programma non cambia
  device: Record<string, string>;
  hum: number;        // umidità simulata
}

const minuteOfDay = (ts: number) => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
const plantOn = (ts: number) => { const m = minuteOfDay(ts); return (m >= 360 && m < 570) || (m >= 990 && m < 1350); };
function setpoint(r: SimRoom, ts: number) {
  const sch = scheduled(r, ts);
  // un obiettivo impostato da un comando resta finché non ne arriva un altro (come una valvola vera)
  if (r.manual) return r.manual.value;
  return sch;
}

const outdoor = (ts: number) => 8 + 4 * Math.sin(((minuteOfDay(ts) - 540) / 1440) * 2 * Math.PI) + 1.5 * Math.sin(ts / 86_400_000 / 2.3);
/** "Verità" esterna simulata, usata anche per generare le previsioni dei modelli in demo. */
export const demoOutdoor = (ts: number) => ({ temp: outdoor(ts), hum: 78 - 12 * Math.sin(((minuteOfDay(ts) - 540) / 1440) * 2 * Math.PI) });

function scheduled(r: SimRoom, ts: number) {
  const m = minuteOfDay(ts);
  if (r.room.id === 'camera') return m >= 390 && m < 480 ? r.comfort : m >= 1290 || m < 390 ? r.night : r.eco;
  if (r.room.id === 'bagno') return (m >= 380 && m < 480) || (m >= 1200 && m < 1320) ? r.comfort : r.eco;
  return (m >= 390 && m < 540) || (m >= 1020 && m < 1350) ? r.comfort : r.eco;
}

export class DemoSource implements DataSource {
  private sims: SimRoom[];

  constructor(startTs: number) {
    const mk = (id: string, name: string, p: Partial<SimRoom>): SimRoom => ({
      room: { id, name, valve: `climate.valvola_${id}`, thermostat: `climate.clima_${id}`,
        tempSensor: `sensor.temperatura_${id}_temperature`, humSensor: `sensor.temperatura_${id}_humidity`, source: 'demo' },
      kRad: 0.0012, kLoss: 0.0007, radMax: 45, comfort: 20.5, eco: 18, night: 18,
      tRoom: 18.5, tRad: 18.5, open: false, lastTs: startTs, mode: 'heat', preset: 'none',
      device: { child_lock: 'off', window_detection: 'on', valve_detection: 'on', sensor: 'internal', external_temperature_input: '0', away_preset_temperature: '15', calibrated: 'on', battery: String(60 + Math.round(Math.random() * 35)), linkquality: String(90 + Math.round(Math.random() * 120)) },
      hum: 50,
      ...p,
    });
    for (const p of ['person.simone', 'person.giulia']) this.home.set(p, true);
    this.sims = [
      mk('soggiorno', 'Soggiorno', { kRad: 0.0011, kLoss: 0.0008 }),
      mk('camera', 'Camera', { comfort: 20, night: 17.5 }),
      mk('cameretta', 'Cameretta', { kRad: 0.0014, kLoss: 0.0006, comfort: 20 }),
      mk('bagno', 'Bagno', { kRad: 0.0018, kLoss: 0.0009, radMax: 50, comfort: 22, windowAt: [455, 467] }),
    ];
  }

  /** Persone simulate (in casa / fuori), comandabili dalla demo. */
  home = new Map<string, boolean>();
  setPerson(id: string, home: boolean) { if (this.home.has(id)) this.home.set(id, home); }
  people() { return [...this.home].map(([id, home]) => ({ id, name: id === 'person.simone' ? 'Simone' : 'Giulia', home })); }
  async notifyServices() { return ['mobile_app_iphone_di_simone']; }

  async service(domain: string, service: string, entityId: string | null, data: Record<string, unknown>) {
    if (domain === 'notify') return;
    const sim = this.sims.find(x => entityId?.includes(`valvola_${x.room.id}_`));
    if (!sim || !entityId) throw new Error(`Entità sconosciuta: ${entityId}`);
    const key = entityId.split('.')[1].replace(`valvola_${sim.room.id}_`, '');
    if (domain === 'select') sim.device[key] = String(data.option);
    else if (domain === 'number') sim.device[key] = String(data.value);
    else if (domain === 'switch') sim.device[key] = service === 'turn_on' ? 'on' : 'off';
  }

  valveLink(room: Room) {
    const sim = this.sim(room);
    const ext = sim.device.sensor === 'external';
    return {
      select: `select.valvola_${room.id}_sensor`, input: `number.valvola_${room.id}_external_temperature_input`,
      mode: sim.device.sensor, inputValue: Number(sim.device.external_temperature_input),
      local: ext ? Number(sim.device.external_temperature_input) : Math.round((sim.tRoom + (sim.tRad - sim.tRoom) * 0.55) * 10) / 10,
    };
  }

  async start() {}
  location() { return { lat: 45.5306, lon: 9.2789, name: 'Cologno Monzese (demo)' }; }
  rooms() { return this.sims.map(s => s.room); }

  private step(sim: SimRoom, to: number) {
    for (let t = sim.lastTs + 60_000; t <= to; t += 60_000) {
      const sp = setpoint(sim, t);
      if (sim.tRoom < sp - 0.2) sim.open = true;
      else if (sim.tRoom > sp + 0.2) sim.open = false;
      const target = plantOn(t) && sim.open && sim.mode === 'heat' ? sim.radMax : sim.tRoom;
      sim.tRad += (target - sim.tRad) / 12;
      const m = minuteOfDay(t);
      const loss = sim.windowAt && m >= sim.windowAt[0] && m < sim.windowAt[1] ? sim.kLoss * 18 : sim.kLoss;
      sim.tRoom += (sim.tRad - sim.tRoom) * sim.kRad - (sim.tRoom - outdoor(t)) * loss;
      // umidità: tende a una base, sale con le attività, scende arieggiando
      const d = new Date(t), dow = d.getDay(), weekend = dow === 0 || dow === 6;
      const base = { soggiorno: 50, camera: 55, cameretta: 52, bagno: 58 }[sim.room.id as 'bagno'] ?? 52;
      let src = 0;
      if (sim.room.id === 'bagno' && m >= (weekend ? 560 : 440) && m < (weekend ? 575 : 452)) src = 2.4;            // doccia
      if (sim.room.id === 'bagno' && dow % 2 === 0 && m >= 1290 && m < 1300) src = 2.0;                              // doccia serale a giorni alterni
      if (sim.room.id === 'soggiorno' && m >= 1170 && m < 1215) src = 0.35;                                           // cucina
      if (sim.room.id === 'camera' && (m >= 1380 || m < 400)) src = 0.03;                                             // due persone che dormono
      const vent = sim.windowAt && m >= sim.windowAt[0] && m < sim.windowAt[1] ? 0.12 : sim.room.id === 'bagno' ? 0.012 : 0.006;
      sim.hum += src + (base - sim.hum) * vent;
      sim.hum = Math.max(30, Math.min(95, sim.hum));
      sim.lastTs = t;
    }
  }

  read(room: Room, at = Date.now()): Sample {
    const sim = this.sims.find(s => s.room.id === room.id)!;
    this.step(sim, at);
    room.valveTempSource = 'valvola';
    room.valveExternal = sim.device.sensor === 'external';
    room.valveSensorMode = `select.valvola_${room.id}_sensor`;
    room.valveExtInput = `number.valvola_${room.id}_external_temperature_input`;
    const noise = () => (Math.random() - 0.5) * 0.1;
    const tValve = sim.tRoom + (sim.tRad - sim.tRoom) * 0.55 + noise();
    const local = room.valveExternal ? Number(sim.device.external_temperature_input) : Math.round(tValve * 10) / 10;
    return {
      ts: at,
      tRoom: Math.round((sim.tRoom + noise()) * 100) / 100,
      hRoom: Math.round(sim.hum + (Math.random() - 0.5)),
      tValve: room.valveExternal ? null : Math.round(tValve * 10) / 10,
      tValveLocal: local,
      setpoint: setpoint(sim, at),
      mode: sim.mode,
    };
  }

  private sim(room: Room) { return this.sims.find(s => s.room.id === room.id)!; }

  controls(room: Room): RoomControls {
    const sim = this.sim(room);
    const now = Date.now();
    const r = this.read(room, now);
    const id = room.id;
    const dev = (key: string, name: string, kind: DeviceControl['kind'], category: DeviceControl['category'], extra: Partial<DeviceControl> = {}): DeviceControl => ({
      entity_id: `${kind === 'info' ? 'sensor' : kind}.valvola_${id}_${key}`, key, name, kind, category,
      domain: kind === 'info' ? 'sensor' : kind, state: sim.device[key] ?? 'unknown', ...extra,
    });
    return {
      thermostat: {
        entity_id: room.thermostat!, name: `Clima ${room.name}`, setpoint: r.setpoint, current: r.tRoom,
        min: 7, max: 28, step: 0.5, mode: sim.mode, modes: ['heat', 'off'],
        preset: sim.preset, presets: ['none', 'eco', 'comfort', 'boost'], action: null,
      },
      valve: {
        entity_id: room.valve, name: `Valvola ${room.name}`, setpoint: r.setpoint, current: r.tValve,
        min: 5, max: 30, step: 0.5, mode: sim.mode, modes: ['heat', 'off'], preset: null, presets: [], action: null,
      },
      device: [
        dev('child_lock', 'Blocco bambini', 'switch', 'principale', { help: 'Disattiva la ghiera e il pulsante della valvola' }),
        dev('window_detection', 'Rilevamento finestra aperta', 'switch', 'principale', { help: 'La valvola si chiude da sola se la temperatura crolla' }),
        dev('sensor', 'Sensore usato dalla valvola', 'select', 'configurazione', { options: ['internal', 'external'], help: 'internal = il suo termometro, external = valore inviato da Home Assistant' }),
        dev('valve_detection', 'Controllo anomalie valvola', 'switch', 'configurazione', { help: 'Segnala se la valvola non riesce a muoversi' }),
        dev('calibrate', 'Calibrazione corsa', 'button', 'configurazione', { state: 'unknown', help: 'Fa aprire e chiudere la valvola per misurarne la corsa. Utile dopo il montaggio' }),
        dev('external_temperature_input', 'Temperatura esterna inviata', 'number', 'configurazione', { min: 0, max: 55, step: 0.1, unit: '°C' }),
        dev('away_preset_temperature', 'Temperatura in assenza', 'number', 'configurazione', { min: 5, max: 30, step: 0.5, unit: '°C' }),
        dev('calibrated', 'Calibrata', 'info', 'diagnostica'),
        dev('battery', 'Batteria', 'info', 'diagnostica', { unit: '%' }),
        dev('linkquality', 'Qualità del segnale', 'info', 'diagnostica', { unit: 'lqi' }),
      ],
      battery: Number(sim.device.battery),
      linkquality: Number(sim.device.linkquality),
      deviceName: `Valvola ${room.name}`,
    };
  }

  async act(room: Room, a: Action): Promise<string> {
    const sim = this.sim(room);
    const call = buildCall(this.controls(room), a);
    const now = Date.now();
    if (call.service === 'set_temperature') sim.manual = { value: call.data.temperature as number, scheduled: scheduled(sim, now) };
    else if (call.service === 'set_hvac_mode') sim.mode = call.data.hvac_mode as 'heat' | 'off';
    else if (call.service === 'set_preset_mode') {
      sim.preset = call.data.preset_mode as string;
      const v = { eco: sim.eco, comfort: sim.comfort, boost: sim.comfort + 1.5 }[sim.preset];
      if (v != null) sim.manual = { value: v, scheduled: scheduled(sim, now) };
    } else {
      const key = call.entity_id.split('.')[1].replace(`valvola_${room.id}_`, '');
      if (call.domain === 'switch') sim.device[key] = call.service === 'turn_on' ? 'on' : 'off';
      if (call.domain === 'select') sim.device[key] = String(call.data.option);
      if (call.domain === 'number') sim.device[key] = String(call.data.value);
    }
    return call.description;
  }

  listEntities(): EntityInfo[] {
    return this.sims.flatMap(s => {
      const r = this.read(s.room);
      return [
        { entity_id: s.room.thermostat!, name: `Clima ${s.room.name}`, domain: 'climate', area: s.room.name, state: 'heat', role: 'Termostato virtuale' },
        { entity_id: s.room.valve, name: `Valvola ${s.room.name}`, domain: 'climate', area: s.room.name, state: 'heat', role: 'Valvola / termostato' },
        { entity_id: s.room.tempSensor, name: `Temperatura ${s.room.name}`, domain: 'sensor', area: s.room.name, state: String(r.tRoom), unit: '°C', role: 'Sensore di temperatura' },
        { entity_id: s.room.humSensor!, name: `Umidità ${s.room.name}`, domain: 'sensor', area: s.room.name, state: String(r.hRoom), unit: '%', role: 'Sensore di umidità' },
      ];
    });
  }
}
