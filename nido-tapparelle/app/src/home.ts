/** Collegamento a Home Assistant: tapparelle, sensori, persone, aree e comandi. */

export interface HAState { entity_id: string; state: string; attributes: Record<string, any>; last_changed: string; last_updated?: string }

export interface CoverInfo {
  entity: string;
  name: string;
  areaId: string | null;
  areaName: string | null;
  /** 0 = chiusa, 100 = aperta (convenzione di Home Assistant). */
  position: number | null;
  state: string;
  supportsPosition: boolean;
  supportsStop: boolean;
  available: boolean;
  deviceClass: string | null;
}

export interface SensorInfo {
  entity: string; name: string; domain: string; deviceClass: string | null;
  areaId: string | null; areaName: string | null; state: string; unit: string | null; role: SensorRole;
}

export type SensorRole = 'contatto' | 'luce' | 'temperatura' | 'vento' | 'pioggia' | 'presenza' | 'meteo' | 'umidita' | 'altro';

export interface Person { id: string; name: string; home: boolean; state: string; trackers: number }
export interface Area { id: string; name: string }

/** Chi ha dato l'ultimo comando a un'entità. */
export interface CallInfo { ts: number; userId: string | null; userName: string | null; automation: boolean; own: boolean; service: string }

export interface Home {
  readonly kind: 'ha' | 'demo';
  connected: boolean;
  start(): Promise<void>;
  covers(): CoverInfo[];
  sensors(): SensorInfo[];
  areas(): Area[];
  people(filter: string[]): Person[];
  get(entity: string): HAState | undefined;
  location(): { lat: number; lon: number; name: string } | null;
  cover(entity: string, action: 'open' | 'close' | 'stop' | 'position', position?: number): Promise<void>;
  lastCall(entity: string, withinMs: number, now?: number): CallInfo | null;
  onChange(cb: (entity: string, old: HAState | undefined, now: HAState | undefined) => void): void;
  onRegistry(cb: () => void): void;
  notifyServices(): Promise<string[]>;
  notify(service: string, title: string, message: string): Promise<void>;
  setState?(entity: string, state: string, attributes: Record<string, unknown>): Promise<void>;
  mqttService?(): Promise<{ host: string; port: number; username?: string; password?: string; ssl?: boolean } | null>;
}

const SUPPORT_SET_POSITION = 4;
const SUPPORT_STOP = 8;

export const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};

/** Il ruolo di un sensore per le tapparelle, dalla sua classe. */
export function sensorRole(entity: string, a: Record<string, any>): SensorRole | null {
  const d = entity.split('.')[0];
  const dc = a.device_class;
  if (d === 'weather') return 'meteo';
  if (d === 'binary_sensor') {
    if (['door', 'window', 'opening', 'garage_door'].includes(dc)) return 'contatto';
    if (['occupancy', 'presence', 'motion'].includes(dc)) return 'presenza';
    if (dc === 'moisture' || /pioggia|rain/i.test(entity)) return 'pioggia';
    return null;
  }
  if (d === 'sensor') {
    if (dc === 'illuminance' || a.unit_of_measurement === 'lx') return 'luce';
    if (dc === 'temperature') return 'temperatura';
    if (dc === 'humidity') return 'umidita';
    if (dc === 'wind_speed' || /vento|wind/i.test(entity) && /km\/h|m\/s/.test(a.unit_of_measurement ?? '')) return 'vento';
    if (dc === 'precipitation' || dc === 'precipitation_intensity') return 'pioggia';
    if (dc === 'irradiance') return 'luce';
    return null;
  }
  return null;
}

export class HAHome implements Home {
  readonly kind = 'ha' as const;
  connected = false;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private states = new Map<string, HAState>();
  private areaList: Area[] = [];
  private entityArea = new Map<string, string>();
  private disabled = new Set<string>();
  private changeCbs: ((e: string, o: HAState | undefined, n: HAState | undefined) => void)[] = [];
  private registryCbs: (() => void)[] = [];
  private loc: { lat: number; lon: number; name: string } | null = null;
  private calls: { entities: string[]; info: CallInfo }[] = [];
  private ownUser: string | null = null;
  private ownCmds: { entity: string; ts: number }[] = [];
  private readonly wsUrl: string;
  private readonly restUrl: string;
  private readonly token: string;
  private readonly supervised: boolean;

  constructor(private log: (m: string) => void) {
    const base = process.env.HA_URL;
    this.token = process.env.HA_TOKEN ?? process.env.SUPERVISOR_TOKEN ?? '';
    this.supervised = !base && !!process.env.SUPERVISOR_TOKEN;
    this.wsUrl = base ? base.replace(/^http/, 'ws') + '/api/websocket' : 'ws://supervisor/core/websocket';
    this.restUrl = base ? base + '/api' : 'http://supervisor/core/api';
    if (!this.token) throw new Error('Token di Home Assistant mancante (SUPERVISOR_TOKEN o HA_TOKEN)');
  }

  async start() {
    await this.connect();
    setInterval(() => { if (this.connected) this.loadRegistries().catch(() => undefined); }, 10 * 60_000);
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
            try {
              const cfg = await this.call({ type: 'get_config' });
              if (typeof cfg.latitude === 'number' && typeof cfg.longitude === 'number')
                this.loc = { lat: cfg.latitude, lon: cfg.longitude, name: cfg.location_name ?? 'Casa' };
            } catch { /* posizione sconosciuta */ }
            await this.call({ type: 'subscribe_events', event_type: 'state_changed' });
            await this.call({ type: 'subscribe_events', event_type: 'call_service' }).catch(() => undefined);
            for (const t of ['entity_registry_updated', 'area_registry_updated', 'device_registry_updated'])
              await this.call({ type: 'subscribe_events', event_type: t }).catch(() => undefined);
            await this.loadRegistries();
            this.connected = true;
            this.log('Collegato a Home Assistant');
            resolve();
          } catch (e) { reject(e); }
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); msg.success ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? 'errore')); }
        } else if (msg.type === 'event') {
          const et = msg.event?.event_type;
          if (et === 'state_changed') {
            const id: string = msg.event.data.entity_id;
            const ns: HAState | null = msg.event.data.new_state;
            const old = this.states.get(id);
            if (ns) this.states.set(id, ns); else this.states.delete(id);
            this.changeCbs.forEach(cb => cb(id, old, ns ?? undefined));
          } else if (et === 'call_service') this.onServiceCall(msg.event);
          else if (et?.endsWith('_registry_updated')) this.scheduleRegistry();
        }
      };
      ws.onerror = () => { if (!authed) reject(new Error('Connessione a Home Assistant non riuscita')); };
      ws.onclose = () => {
        this.pending.forEach(p => p.reject(new Error('connessione chiusa')));
        this.pending.clear();
        if (authed) { this.connected = false; this.log('Connessione a Home Assistant persa, ritento tra 10 secondi'); setTimeout(() => this.reconnect(), 10_000); }
      };
    });
  }

  private async reconnect() {
    try { await this.connect(); } catch { setTimeout(() => this.reconnect(), 30_000); }
  }

  private call(msg: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws!.send(JSON.stringify({ id, ...msg })); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  private regTimer?: NodeJS.Timeout;
  private scheduleRegistry() {
    clearTimeout(this.regTimer);
    this.regTimer = setTimeout(() => this.loadRegistries().then(() => this.registryCbs.forEach(cb => cb())).catch(() => undefined), 3000);
  }

  private async loadRegistries() {
    const [areas, devices, entities] = await Promise.all([
      this.call({ type: 'config/area_registry/list' }),
      this.call({ type: 'config/device_registry/list' }),
      this.call({ type: 'config/entity_registry/list' }),
    ]);
    this.areaList = (areas as any[]).map(a => ({ id: a.area_id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name, 'it'));
    const devArea = new Map<string, string>((devices as any[]).filter(d => d.area_id).map(d => [d.id, d.area_id]));
    this.entityArea.clear();
    this.disabled.clear();
    for (const e of entities as any[]) {
      const a = e.area_id ?? (e.device_id ? devArea.get(e.device_id) : undefined);
      if (a) this.entityArea.set(e.entity_id, a);
      if (e.disabled_by || e.hidden_by === 'integration') this.disabled.add(e.entity_id);
    }
  }

  onChange(cb: (e: string, o: HAState | undefined, n: HAState | undefined) => void) { this.changeCbs.push(cb); }
  onRegistry(cb: () => void) { this.registryCbs.push(cb); }
  get(entity: string) { return this.states.get(entity); }
  areas() { return this.areaList; }
  location() { return this.loc; }
  private areaName(id: string | null) { return id ? this.areaList.find(a => a.id === id)?.name ?? null : null; }

  covers(): CoverInfo[] {
    const out: CoverInfo[] = [];
    for (const s of this.states.values()) {
      if (!s.entity_id.startsWith('cover.') || this.disabled.has(s.entity_id)) continue;
      const f = Number(s.attributes.supported_features ?? 0);
      const areaId = this.entityArea.get(s.entity_id) ?? null;
      out.push({
        entity: s.entity_id, name: s.attributes.friendly_name ?? s.entity_id, areaId, areaName: this.areaName(areaId),
        position: num(s.attributes.current_position), state: s.state,
        supportsPosition: (f & SUPPORT_SET_POSITION) !== 0, supportsStop: (f & SUPPORT_STOP) !== 0,
        available: s.state !== 'unavailable' && s.state !== 'unknown', deviceClass: s.attributes.device_class ?? null,
      });
    }
    return out;
  }

  sensors(): SensorInfo[] {
    const out: SensorInfo[] = [];
    for (const s of this.states.values()) {
      if (this.disabled.has(s.entity_id) || s.entity_id.includes('nido_tapparelle')) continue;
      const role = sensorRole(s.entity_id, s.attributes);
      if (!role) continue;
      const areaId = this.entityArea.get(s.entity_id) ?? null;
      out.push({
        entity: s.entity_id, name: s.attributes.friendly_name ?? s.entity_id, domain: s.entity_id.split('.')[0],
        deviceClass: s.attributes.device_class ?? null, areaId, areaName: this.areaName(areaId),
        state: s.state, unit: s.attributes.unit_of_measurement ?? null, role,
      });
    }
    return out;
  }

  people(filter: string[]): Person[] {
    return [...this.states.values()]
      .filter(s => s.entity_id.startsWith('person.') && (!filter.length || filter.includes(s.entity_id)))
      .map(s => ({ id: s.entity_id, name: s.attributes.friendly_name ?? s.entity_id, state: s.state, home: s.state === 'home',
        trackers: Array.isArray(s.attributes.device_trackers) ? s.attributes.device_trackers.length : 0 }));
  }

  async cover(entity: string, action: 'open' | 'close' | 'stop' | 'position', position?: number) {
    const service = action === 'position' ? 'set_cover_position' : action === 'stop' ? 'stop_cover' : `${action}_cover`;
    this.ownCmds.push({ entity, ts: Date.now() });
    if (this.ownCmds.length > 200) this.ownCmds.splice(0, 100);
    const res = await this.call({
      type: 'call_service', domain: 'cover', service,
      service_data: action === 'position' ? { position: Math.round(position ?? 0) } : {}, target: { entity_id: entity },
    });
    const u = res?.context?.user_id; if (u) this.ownUser = u;
  }

  private onServiceCall(ev: any) {
    const d = ev.data ?? {};
    if (d.domain !== 'cover') return;
    const sd = d.service_data ?? {};
    const raw = sd.entity_id ?? d.target?.entity_id;
    let entities = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const areaRaw = sd.area_id ?? d.target?.area_id;
    if (areaRaw) {
      const areas = Array.isArray(areaRaw) ? areaRaw : [areaRaw];
      entities = entities.concat(this.covers().filter(c => c.areaId && areas.includes(c.areaId)).map(c => c.entity));
    }
    if (raw === 'all') entities = this.covers().map(c => c.entity);
    const ctx = ev.context ?? {};
    const own = !!this.ownUser && ctx.user_id === this.ownUser;
    const userId = ctx.user_id ?? null;
    this.calls.push({ entities, info: {
      ts: Date.now(), userId, userName: userId ? this.userName(userId) : null,
      automation: !userId && !!ctx.parent_id, own, service: d.service,
    } });
    if (this.calls.length > 300) this.calls.splice(0, 150);
  }

  private userName(userId: string) {
    const p = [...this.states.values()].find(s => s.entity_id.startsWith('person.') && s.attributes.user_id === userId);
    return p?.attributes.friendly_name ?? 'un utente di Home Assistant';
  }

  lastCall(entity: string, withinMs: number, now = Date.now()): CallInfo | null {
    const own = [...this.ownCmds].reverse().find(c => c.entity === entity && now - c.ts < withinMs);
    const c = [...this.calls].reverse().find(x => now - x.info.ts < withinMs && x.entities.includes(entity));
    if (own && (!c || c.info.own || own.ts >= c.info.ts - 2000)) return { ts: own.ts, userId: null, userName: null, automation: false, own: true, service: '' };
    return c?.info ?? null;
  }

  async notifyServices(): Promise<string[]> {
    try { const s = await this.call({ type: 'get_services' }); return Object.keys(s.notify ?? {}).filter(n => !['persistent_notification', 'send_message'].includes(n)).sort(); }
    catch { return []; }
  }

  async notify(service: string, title: string, message: string) {
    await this.call({ type: 'call_service', domain: 'notify', service, service_data: { title, message } });
  }

  async setState(entity: string, state: string, attributes: Record<string, unknown>) {
    await fetch(`${this.restUrl}/states/${entity}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, attributes }),
    }).catch(() => undefined);
  }

  async mqttService() {
    if (process.env.MQTT_HOST) return { host: process.env.MQTT_HOST, port: Number(process.env.MQTT_PORT ?? 1883), username: process.env.MQTT_USER, password: process.env.MQTT_PASSWORD };
    if (!this.supervised) return null;
    try {
      const r = await fetch('http://supervisor/services/mqtt', { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
      if (!r.ok) return null;
      const j: any = await r.json();
      const d = j.data ?? j;
      return d?.host ? { host: d.host, port: Number(d.port ?? 1883), username: d.username, password: d.password, ssl: !!d.ssl } : null;
    } catch { return null; }
  }
}
