import type { AreaDiagnosis, DataSource, Diagnosis, EntityInfo, PlantStatus, Room, RoomStatus, Sample } from './types.js';
import type { Options } from './config.js';

interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
  last_changed: string;
}

const VIRTUAL_THERMOSTATS = new Set(['versatile_thermostat', 'better_thermostat', 'generic_thermostat']);
const OWN_PREFIX = 'nido_clima_';

export const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'stanza';

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

/** Collegamento a Home Assistant via WebSocket (dentro l'app usa il proxy del Supervisor). */
export class HASource implements DataSource {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private states = new Map<string, HAState>();
  private areaNames = new Map<string, string>();
  private entityArea = new Map<string, string | null>();
  private entityPlatform = new Map<string, string>();
  private roomList: Room[] = [];
  private readonly wsUrl: string;
  private readonly restUrl: string;
  private readonly token: string;

  constructor(private opts: Options, private onLog: (msg: string) => void) {
    const base = process.env.HA_URL; // per sviluppo fuori da HA, es. http://homeassistant.local:8123
    this.token = process.env.HA_TOKEN ?? process.env.SUPERVISOR_TOKEN ?? '';
    this.wsUrl = base ? base.replace(/^http/, 'ws') + '/api/websocket' : 'ws://supervisor/core/websocket';
    this.restUrl = base ? base + '/api' : 'http://supervisor/core/api';
    if (!this.token) throw new Error('Token di Home Assistant mancante (SUPERVISOR_TOKEN o HA_TOKEN)');
  }

  async start() {
    await this.connect();
    await this.discover();
    // rilegge stanze e registri ogni 10 minuti (nuovi dispositivi, aree cambiate)
    // (ogni minuto finché non ci sono stanze, così le modifiche alle aree si vedono subito)
    let last = Date.now();
    setInterval(() => {
      if (this.roomList.length && Date.now() - last < 10 * 60_000) return;
      last = Date.now();
      this.discover().catch(e => this.onLog(`Errore aggiornamento stanze: ${e}`));
    }, 60_000);
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      let authed = false;
      ws.onmessage = async ev => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        else if (msg.type === 'auth_invalid') reject(new Error('Autenticazione Home Assistant fallita'));
        else if (msg.type === 'auth_ok') {
          authed = true;
          try {
            const states: HAState[] = await this.call({ type: 'get_states' });
            states.forEach(s => this.states.set(s.entity_id, s));
            await this.call({ type: 'subscribe_events', event_type: 'state_changed' });
            this.onLog('Collegato a Home Assistant');
            resolve();
          } catch (e) { reject(e); }
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.success ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? 'errore'));
          }
        } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
          const ns: HAState | null = msg.event.data.new_state;
          if (ns) this.states.set(ns.entity_id, ns);
          else this.states.delete(msg.event.data.entity_id);
        }
      };
      ws.onerror = () => { if (!authed) reject(new Error('Connessione a Home Assistant non riuscita')); };
      ws.onclose = () => {
        this.pending.forEach(p => p.reject(new Error('connessione chiusa')));
        this.pending.clear();
        if (authed) {
          this.onLog('Connessione a Home Assistant persa, ritento tra 10 secondi');
          setTimeout(() => this.reconnect(), 10_000);
        }
      };
    });
  }

  private async reconnect() {
    try { await this.connect(); await this.discover(); }
    catch { setTimeout(() => this.reconnect(), 30_000); }
  }

  private call(msg: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, ...msg }));
    });
  }

  private async discover() {
    const [areas, devices, entities] = await Promise.all([
      this.call({ type: 'config/area_registry/list' }),
      this.call({ type: 'config/device_registry/list' }),
      this.call({ type: 'config/entity_registry/list' }),
    ]);
    this.areaNames = new Map(areas.map((a: any) => [a.area_id, a.name]));
    const deviceArea = new Map<string, string | null>(devices.map((d: any) => [d.id, d.area_id]));
    const entityDevice = new Map<string, string | null>();
    for (const e of entities) {
      this.entityArea.set(e.entity_id, e.area_id ?? (e.device_id ? deviceArea.get(e.device_id) ?? null : null));
      this.entityPlatform.set(e.entity_id, e.platform);
      entityDevice.set(e.entity_id, e.device_id ?? null);
    }

    const manual = this.opts.stanze;
    if (manual.length) {
      this.roomList = manual.map(r => ({
        id: slugify(r.nome), name: r.nome, valve: r.valvola, thermostat: r.termostato,
        tempSensor: r.sensore_temperatura, humSensor: r.sensore_umidita, source: 'manuale' as const,
      }));
    } else {
      const active = entities.filter((e: any) => !e.disabled_by && !e.entity_id.includes(OWN_PREFIX));
      const rooms: Room[] = [];
      const diag: AreaDiagnosis[] = [];
      const isTemp = (id: string) => {
        const a = this.states.get(id)?.attributes ?? {};
        return a.device_class === 'temperature' || a.unit_of_measurement === '°C';
      };
      const isHum = (id: string) => {
        const a = this.states.get(id)?.attributes ?? {};
        return a.device_class === 'humidity' || (a.unit_of_measurement === '%' && /umid|humid/i.test(id));
      };
      for (const area of areas) {
        const inArea = active.filter((e: any) => this.entityArea.get(e.entity_id) === area.area_id);
        const climates = inArea.filter((e: any) => e.entity_id.startsWith('climate.'));
        const valve = climates.find((e: any) => !VIRTUAL_THERMOSTATS.has(e.platform));
        const thermostat = climates.find((e: any) => VIRTUAL_THERMOSTATS.has(e.platform));
        const valveDevice = valve ? entityDevice.get(valve.entity_id) : undefined;
        const pick = (test: (id: string) => boolean) => inArea.find((e: any) =>
          e.entity_id.startsWith('sensor.') &&
          (!valveDevice || entityDevice.get(e.entity_id) !== valveDevice) &&
          test(e.entity_id))?.entity_id as string | undefined;
        const temp: string | undefined = area.temperature_entity_id ?? pick(isTemp);
        const hum: string | undefined = area.humidity_entity_id ?? pick(isHum);
        const missing: string[] = [];
        if (!valve) missing.push(thermostat ? 'valvola reale (c\'è solo il termostato virtuale)' : 'valvola');
        if (!temp) missing.push('sensore di temperatura');
        diag.push({ area: area.name, valve: valve?.entity_id ?? null, thermostat: thermostat?.entity_id ?? null,
          temp: temp ?? null, hum: hum ?? null, entities: inArea.length, missing });
        if (!valve || !temp) continue;
        rooms.push({
          id: slugify(area.name), name: area.name, valve: valve.entity_id,
          thermostat: thermostat?.entity_id, tempSensor: temp, humSensor: hum, source: 'auto',
        });
      }
      // valvole e sensori senza area: la causa più frequente di "nessuna stanza"
      const unassigned = active.filter((e: any) => !this.entityArea.get(e.entity_id) && (
        (e.entity_id.startsWith('climate.') && !VIRTUAL_THERMOSTATS.has(e.platform)) ||
        (e.entity_id.startsWith('sensor.') && isTemp(e.entity_id) && this.states.get(e.entity_id)?.attributes.device_class === 'temperature')
      )).map((e: any) => e.entity_id as string);
      this.diagnosis = { areas: diag, unassigned, mode: 'auto' };
      for (const d of diag.filter(d => d.missing.length && (d.valve || d.thermostat || d.temp))) {
        this.onLog(`Area "${d.area}": manca ${d.missing.join(' e ')}`);
      }
      if (unassigned.length) this.onLog(`Senza area: ${unassigned.join(', ')}`);
      this.roomList = rooms;
    }
    if (manual.length) this.diagnosis = { areas: [], unassigned: [], mode: 'manuale' };
    this.onLog(`Stanze trovate: ${this.roomList.map(r => r.name).join(', ') || 'nessuna'}`);
  }

  diagnosis: Diagnosis = { areas: [], unassigned: [], mode: 'auto' };

  rooms() { return this.roomList; }

  read(room: Room): Sample {
    const valve = this.states.get(room.valve);
    const thermo = room.thermostat ? this.states.get(room.thermostat) : undefined;
    const target = thermo ?? valve;
    return {
      ts: Date.now(),
      tRoom: num(this.states.get(room.tempSensor)?.state),
      hRoom: room.humSensor ? num(this.states.get(room.humSensor)?.state) : null,
      tValve: num(valve?.attributes.current_temperature),
      setpoint: num(target?.attributes.temperature),
      mode: target?.state ?? null,
    };
  }

  private async setState(entityId: string, state: string, attributes: Record<string, unknown>) {
    const res = await fetch(`${this.restUrl}/states/${entityId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, attributes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} pubblicando ${entityId}`);
  }

  async publish(room: Room, s: RoomStatus) {
    await this.setState(`binary_sensor.${OWN_PREFIX}${room.id}_calorifero`, s.heating ? 'on' : 'off', {
      friendly_name: `Calorifero ${room.name}`,
      device_class: 'heat',
      icon: s.heating ? 'mdi:radiator' : 'mdi:radiator-off',
      differenza: s.delta != null ? Math.round(s.delta * 10) / 10 : null,
      pendenza_valvola: s.slopeValve != null ? Math.round(s.slopeValve * 10) / 10 : null,
      affidabilita: s.confidence,
      motivo: s.reason,
      finestra_sospetta: s.window,
      dal: new Date(s.since).toISOString(),
    });
  }

  async publishPlant(p: PlantStatus) {
    await this.setState(`sensor.${OWN_PREFIX}impianto`, p.state, {
      friendly_name: 'Impianto di riscaldamento',
      icon: p.state === 'acceso' ? 'mdi:fire' : 'mdi:fire-off',
      descrizione: p.label,
      dal: new Date(p.since).toISOString(),
    });
  }

  listEntities(): EntityInfo[] {
    const roles: Record<string, string> = {
      temperature: 'Sensore di temperatura', humidity: 'Sensore di umidità',
      battery: 'Livello batteria', window: 'Finestra', door: 'Porta', motion: 'Movimento',
    };
    const out: EntityInfo[] = [];
    for (const s of this.states.values()) {
      const domain = s.entity_id.split('.')[0];
      if (!['climate', 'sensor', 'binary_sensor', 'number', 'select', 'switch'].includes(domain)) continue;
      if (s.entity_id.includes(OWN_PREFIX)) continue;
      const platform = this.entityPlatform.get(s.entity_id);
      let role = '';
      if (domain === 'climate') role = platform && VIRTUAL_THERMOSTATS.has(platform) ? 'Termostato virtuale' : 'Valvola / termostato';
      else role = roles[s.attributes.device_class] ?? '';
      if (!role) continue; // mostriamo solo ciò che riguarda il clima
      const area = this.entityArea.get(s.entity_id);
      out.push({
        entity_id: s.entity_id,
        name: s.attributes.friendly_name ?? s.entity_id,
        domain, area: area ? this.areaNames.get(area) ?? null : null,
        state: s.state, unit: s.attributes.unit_of_measurement, role,
      });
    }
    return out.sort((a, b) => (a.area ?? 'zzz').localeCompare(b.area ?? 'zzz') || a.role.localeCompare(b.role));
  }
}
