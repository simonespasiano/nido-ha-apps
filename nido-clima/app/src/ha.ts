import type { Attribution, AreaDiagnosis, DataSource, Diagnosis, EntityInfo, PlantStatus, PresenceDetail, Room, TrackerInfo, RoomStatus, Sample } from './types.js';
import type { Options } from './config.js';
import { buildCall, describeClimate, describeControl, type Action, type DeviceControl, type RoomControls } from './controls.js';

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6_371_000, r = (d: number) => d * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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
  private registry: any[] = [];
  private deviceInfo = new Map<string, { name: string | null }>();
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
            try {
              const cfg = await this.call({ type: 'get_config' });
              if (typeof cfg.latitude === 'number' && typeof cfg.longitude === 'number')
                this.loc = { lat: cfg.latitude, lon: cfg.longitude, name: cfg.location_name ?? 'Casa' };
            } catch { /* la posizione resta sconosciuta */ }
            states.forEach(s => this.states.set(s.entity_id, s));
            await this.call({ type: 'subscribe_events', event_type: 'state_changed' });
            await this.call({ type: 'subscribe_events', event_type: 'call_service' }).catch(() => undefined);
            this.onLog('Collegato a Home Assistant');
            resolve();
          } catch (e) { reject(e); }
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            msg.success ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? 'errore'));
          }
        } else if (msg.type === 'event' && msg.event?.event_type === 'call_service') {
          this.onServiceCall(msg.event);
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
    this.registry = entities;
    this.deviceInfo = new Map(devices.map((d: any) => [d.id, { name: d.name_by_user ?? d.name ?? null }]));
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
        valveTempSensor: r.sensore_termosifone,
        ...this.valveExtras(r.valvola, entities, entityDevice),
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
          ...this.valveExtras(valve.entity_id, entities, entityDevice),
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

  /** Entità utili dello stesso dispositivo della valvola: il selettore del sensore (interno/esterno). */
  private valveExtras(valveId: string, entities: any[], entityDevice: Map<string, string | null>) {
    const dev = entityDevice.get(valveId);
    if (!dev) return {};
    const own = entities.filter((e: any) => entityDevice.get(e.entity_id) === dev && !e.disabled_by);
    const mode = own.find((e: any) => e.entity_id.startsWith('select.') && /_sensor$/.test(e.entity_id))?.entity_id;
    const input = own.find((e: any) => e.entity_id.startsWith('number.') && /external_temperature(_input)?$/.test(e.entity_id))?.entity_id;
    return { valveSensorMode: mode as string | undefined, valveExtInput: input as string | undefined };
  }

  /**
   * Temperatura "del termosifone": una sonda indicata a mano, altrimenti quella misurata dalla valvola.
   * Con la valvola sul sensore esterno quella temperatura è la stanza stessa: non serve al rilevamento.
   */
  private valveTemperature(room: Room): number | null {
    room.valveExternal = room.valveSensorMode ? this.states.get(room.valveSensorMode)?.state === 'external' : false;
    if (room.valveTempSensor) { room.valveTempSource = 'manuale'; return num(this.states.get(room.valveTempSensor)?.state); }
    room.valveTempSource = 'valvola';
    if (room.valveExternal) return null;
    return num(this.states.get(room.valve)?.attributes.current_temperature);
  }

  rooms() { return this.roomList; }

  private loc: { lat: number; lon: number; name: string } | null = null;
  location() { return this.loc; }

  outdoorSensor() {
    if (!this.opts.sensore_esterno) return null;
    return {
      temp: num(this.states.get(this.opts.sensore_esterno)?.state),
      hum: this.opts.sensore_esterno_umidita ? num(this.states.get(this.opts.sensore_esterno_umidita)?.state) : null,
    };
  }

  controls(room: Room): RoomControls {
    const st = (id?: string) => (id ? this.states.get(id) : undefined);
    const valveState = st(room.valve);
    const thermoState = st(room.thermostat);
    const valveEntry = this.registry.find(e => e.entity_id === room.valve);
    const deviceId: string | null = valveEntry?.device_id ?? null;
    const deviceName = deviceId ? this.deviceInfo.get(deviceId)?.name ?? null : null;
    const deviceSlug = deviceName ? slugify(deviceName) : (room.valve.split('.')[1] ?? null);
    const device: DeviceControl[] = [];
    if (deviceId) {
      for (const e of this.registry) {
        if (e.device_id !== deviceId || e.disabled_by || e.entity_id === room.valve) continue;
        const s = this.states.get(e.entity_id);
        if (!s) continue;
        if (/device_temperature$|internal_temperature$/.test(e.entity_id)) continue; // temperatura del chip: fuorviante
        const c = describeControl(e.entity_id, s.attributes.friendly_name ?? e.entity_id, deviceName, deviceSlug,
          s.state, s.attributes, e.entity_category ?? null);
        if (c) device.push(c);
      }
    }
    const order = { principale: 0, configurazione: 1, diagnostica: 2 } as const;
    device.sort((a, b) => order[a.category] - order[b.category] || a.name.localeCompare(b.name));
    const val = (k: string) => num(device.find(d => d.key === k)?.state);
    return {
      thermostat: thermoState && room.thermostat ? describeClimate(room.thermostat, thermoState.attributes, thermoState.state) : null,
      valve: valveState ? describeClimate(room.valve, valveState.attributes, valveState.state) : null,
      device,
      battery: val('battery'),
      linkquality: val('linkquality'),
      deviceName,
    };
  }

  async act(room: Room, a: Action): Promise<string> {
    const call = buildCall(this.controls(room), a);
    this.ownCmds.push({ entity: call.entity_id, ts: Date.now() });
    if (this.ownCmds.length > 100) this.ownCmds.shift();
    this.learnOwn(await this.call({
      type: 'call_service', domain: call.domain, service: call.service,
      service_data: call.data, target: { entity_id: call.entity_id },
    }));
    return call.description;
  }

  /** Comandi mandati da NIDO (per non attribuirli ad altri) e comandi climate fatti da utenti o automazioni. */
  private ownUser: string | null = null;
  private learnOwn(res: any) { const u = res?.context?.user_id; if (u) this.ownUser = u; }
  private ownCmds: { entity: string; ts: number }[] = [];
  private calls: { entities: string[]; ts: number; value: number | string | null; userId: string | null; automation: boolean; own: boolean }[] = [];

  private onServiceCall(ev: any) {
    const d = ev.data ?? {};
    if (d.domain !== 'climate' || !['set_temperature', 'set_hvac_mode', 'set_preset_mode', 'turn_on', 'turn_off'].includes(d.service)) return;
    const sd = d.service_data ?? {};
    const ent = sd.entity_id;
    const entities = (Array.isArray(ent) ? ent : ent ? [ent] : []).map(String);
    const ctx = ev.context ?? {};
    const own = !!this.ownUser && ctx.user_id === this.ownUser;
    this.calls.push({ entities, ts: Date.now(), value: sd.temperature ?? sd.hvac_mode ?? null, userId: ctx.user_id ?? null, automation: !ctx.user_id && !!ctx.parent_id, own: !!own });
    if (this.calls.length > 200) this.calls.splice(0, this.calls.length - 200);
  }

  private userName(userId: string): string {
    const p = [...this.states.values()].find(s => s.entity_id.startsWith('person.') && s.attributes.user_id === userId);
    return p?.attributes.friendly_name ?? 'un utente di Home Assistant';
  }

  attribute(room: Room, _value: number | string | null, now: number): Attribution {
    const ents = [room.valve, room.thermostat].filter(Boolean) as string[];
    const recent = (ts: number) => now - ts < 6 * 60_000 && ts <= now + 5_000;
    const c = [...this.calls].reverse().find(x => recent(x.ts) && x.entities.some(e => ents.includes(e)));
    const own = [...this.ownCmds].reverse().find(x => recent(x.ts) && ents.includes(x.entity));
    // il comando più recente vince; quello di NIDO si riconosce perché parte un attimo prima del suo evento
    if (own && (!c || c.own || Math.abs(c.ts - own.ts) < 5_000 || own.ts > c.ts)) return { origin: 'nido' as const, who: 'NIDO' };
    if (c) {
      if (c.own) return { origin: 'nido' as const, who: 'NIDO' };
      if (c.userId) return { origin: 'utente' as const, who: this.userName(c.userId) };
      return { origin: 'automazione' as const, who: c.automation ? 'automazione di Home Assistant' : 'Home Assistant' };
    }
    return { origin: 'valvola' as const, who: 'sulla valvola' };
  }

  async service(domain: string, service: string, entityId: string | null, data: Record<string, unknown>) {
    if (entityId) { this.ownCmds.push({ entity: entityId, ts: Date.now() }); if (this.ownCmds.length > 100) this.ownCmds.shift(); }
    this.learnOwn(await this.call({ type: 'call_service', domain, service, service_data: data, ...(entityId ? { target: { entity_id: entityId } } : {}) }));
  }

  valveLink(room: Room) {
    const sel = room.valveSensorMode ? this.states.get(room.valveSensorMode) : undefined;
    const inp = room.valveExtInput ? this.states.get(room.valveExtInput) : undefined;
    return {
      select: room.valveSensorMode ?? null, input: room.valveExtInput ?? null,
      mode: sel?.state ?? null, inputValue: num(inp?.state),
      local: num(this.states.get(room.valve)?.attributes.current_temperature),
    };
  }

  people() {
    return [...this.states.values()].filter(s => s.entity_id.startsWith('person.'))
      .map(s => ({ id: s.entity_id, name: s.attributes.friendly_name ?? s.entity_id, home: s.state === 'home', state: s.state, trackers: Array.isArray(s.attributes.device_trackers) ? s.attributes.device_trackers.length : 0, userId: s.attributes.user_id ?? null }));
  }

  /** Dettaglio della presenza: per ogni persona i dispositivi collegati, quello che decide lo stato, distanza e indirizzo. */
  presenceDetail(): PresenceDetail {
    const z = this.states.get('zone.home');
    const home = z && typeof z.attributes.latitude === 'number'
      ? { lat: z.attributes.latitude, lon: z.attributes.longitude, radius: Number(z.attributes.radius ?? 100), name: z.attributes.friendly_name ?? 'Casa' }
      : this.loc ? { lat: this.loc.lat, lon: this.loc.lon, radius: 100, name: this.loc.name } : null;
    const dist = (lat: any, lon: any) => home && typeof lat === 'number' && typeof lon === 'number' ? Math.round(haversine(home.lat, home.lon, lat, lon)) : null;
    const people = [...this.states.values()].filter(s => s.entity_id.startsWith('person.')).map(p => {
      const ids: string[] = Array.isArray(p.attributes.device_trackers) ? p.attributes.device_trackers : [];
      const trackers: TrackerInfo[] = ids.map(id => {
        const t = this.states.get(id);
        const a = t?.attributes ?? {};
        // l'app Companion crea anche sensor.<telefono>_geocoded_location con l'indirizzo calcolato dal telefono
        const geo = this.states.get(`sensor.${id.split('.')[1]}_geocoded_location`);
        return {
          id, name: a.friendly_name ?? id, state: t?.state ?? 'non trovato', sourceType: a.source_type ?? null,
          lat: typeof a.latitude === 'number' ? a.latitude : null, lon: typeof a.longitude === 'number' ? a.longitude : null,
          accuracy: typeof a.gps_accuracy === 'number' ? a.gps_accuracy : null, distance: dist(a.latitude, a.longitude),
          updated: (t as any)?.last_updated ?? t?.last_changed ?? null,
          address: geo && !['unknown', 'unavailable'].includes(geo.state) ? geo.state : null,
          isSource: p.attributes.source === id,
        };
      });
      return {
        id: p.entity_id, name: p.attributes.friendly_name ?? p.entity_id, state: p.state, source: p.attributes.source ?? null,
        updated: (p as any).last_updated ?? p.last_changed ?? null,
        lat: typeof p.attributes.latitude === 'number' ? p.attributes.latitude : null, lon: typeof p.attributes.longitude === 'number' ? p.attributes.longitude : null,
        distance: dist(p.attributes.latitude, p.attributes.longitude), trackers,
      };
    });
    return { home, people };
  }

  async notifyServices(): Promise<string[]> {
    try { const s = await this.call({ type: 'get_services' }); return Object.keys(s.notify ?? {}).filter(n => !['persistent_notification', 'send_message'].includes(n)).sort(); }
    catch { return []; }
  }

  read(room: Room): Sample {
    const valve = this.states.get(room.valve);
    const thermo = room.thermostat ? this.states.get(room.thermostat) : undefined;
    const target = thermo ?? valve;
    return {
      ts: Date.now(),
      tRoom: num(this.states.get(room.tempSensor)?.state),
      hRoom: room.humSensor ? num(this.states.get(room.humSensor)?.state) : null,
      tValve: this.valveTemperature(room),
      tValveLocal: num(valve?.attributes.current_temperature),
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
      valvola_chiusa_in_temperatura: s.supplyHot ?? false,
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
