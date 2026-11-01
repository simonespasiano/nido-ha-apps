/** Quello che serve sapere della casa: chi c'è, le aree, i sensori di presenza. */

interface HAState { entity_id: string; state: string; attributes: Record<string, any>; last_changed: string }

export interface Person { id: string; name: string; home: boolean; state: string }
export interface Area { id: string; name: string }
export interface Occupancy { occupied: boolean; sensors: { id: string; name: string; on: boolean }[] }

export interface Home {
  readonly kind: 'ha' | 'demo' | 'none';
  connected: boolean;
  start(): Promise<void>;
  people(filter: string[]): Person[];
  areas(): Area[];
  occupancy(areaId: string): Occupancy;
  onPeopleChange(cb: () => void): void;
  /** Pubblica uno stato via REST (solo se MQTT non è disponibile). */
  setState?(entityId: string, state: string, attributes: Record<string, unknown>): Promise<void>;
  /** Credenziali del broker MQTT fornite dal Supervisor. */
  mqttService?(): Promise<{ host: string; port: number; username?: string; password?: string; ssl?: boolean } | null>;
}

const PRESENCE_CLASSES = new Set(['occupancy', 'presence', 'motion']);

export class HAHome implements Home {
  readonly kind = 'ha' as const;
  connected = false;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private states = new Map<string, HAState>();
  private areaList: Area[] = [];
  private entityArea = new Map<string, string>();
  private listeners: (() => void)[] = [];
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
  }

  async start() {
    if (!this.token) { this.log('Nessun token di Home Assistant: presenza e aree non disponibili'); return; }
    await this.connect().catch(e => { this.log(`Home Assistant: ${e.message}`); setTimeout(() => this.reconnect(), 30_000); });
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
        else if (msg.type === 'auth_invalid') reject(new Error('autenticazione fallita'));
        else if (msg.type === 'auth_ok') {
          authed = true;
          try {
            const states: HAState[] = await this.call({ type: 'get_states' });
            states.forEach(s => this.states.set(s.entity_id, s));
            await this.call({ type: 'subscribe_events', event_type: 'state_changed' });
            await this.loadRegistries();
            this.connected = true;
            this.log('Collegato a Home Assistant');
            resolve();
          } catch (e) { reject(e); }
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); msg.success ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? 'errore')); }
        } else if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
          const id: string = msg.event.data.entity_id;
          const ns: HAState | null = msg.event.data.new_state;
          const old = this.states.get(id);
          if (ns) this.states.set(id, ns); else this.states.delete(id);
          if (id.startsWith('person.') && old?.state !== ns?.state) this.listeners.forEach(l => l());
        }
      };
      ws.onerror = () => { if (!authed) reject(new Error('connessione non riuscita')); };
      ws.onclose = () => {
        this.pending.forEach(p => p.reject(new Error('connessione chiusa')));
        this.pending.clear();
        if (authed) { this.connected = false; this.log('Connessione a Home Assistant persa, ritento'); setTimeout(() => this.reconnect(), 10_000); }
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

  private async loadRegistries() {
    const [areas, devices, entities] = await Promise.all([
      this.call({ type: 'config/area_registry/list' }),
      this.call({ type: 'config/device_registry/list' }),
      this.call({ type: 'config/entity_registry/list' }),
    ]);
    this.areaList = (areas as any[]).map(a => ({ id: a.area_id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name, 'it'));
    const devArea = new Map<string, string>((devices as any[]).filter(d => d.area_id).map(d => [d.id, d.area_id]));
    this.entityArea.clear();
    for (const e of entities as any[]) {
      const a = e.area_id ?? (e.device_id ? devArea.get(e.device_id) : undefined);
      if (a) this.entityArea.set(e.entity_id, a);
    }
  }

  onPeopleChange(cb: () => void) { this.listeners.push(cb); }

  people(filter: string[]): Person[] {
    return [...this.states.values()]
      .filter(s => s.entity_id.startsWith('person.') && (!filter.length || filter.includes(s.entity_id)))
      .map(s => ({ id: s.entity_id, name: s.attributes.friendly_name ?? s.entity_id, state: s.state, home: s.state === 'home' }));
  }

  areas() { return this.areaList; }

  occupancy(areaId: string): Occupancy {
    const sensors = [...this.states.values()]
      .filter(s => s.entity_id.startsWith('binary_sensor.') && PRESENCE_CLASSES.has(s.attributes.device_class) && this.entityArea.get(s.entity_id) === areaId)
      .map(s => ({ id: s.entity_id, name: s.attributes.friendly_name ?? s.entity_id, on: s.state === 'on' }));
    return { occupied: sensors.some(s => s.on), sensors };
  }

  async setState(entityId: string, state: string, attributes: Record<string, unknown>) {
    await fetch(`${this.restUrl}/states/${entityId}`, {
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

/** Casa finta per la demo: due persone e qualche sensore di presenza, comandabili dall'interfaccia. */
export class DemoHome implements Home {
  readonly kind = 'demo' as const;
  connected = true;
  private listeners: (() => void)[] = [];
  peopleList: Person[] = [
    { id: 'person.simone', name: 'Simone', home: true, state: 'home' },
    { id: 'person.giulia', name: 'Giulia', home: true, state: 'home' },
  ];
  private areaList: Area[] = [
    { id: 'soggiorno', name: 'Soggiorno' }, { id: 'cucina', name: 'Cucina' }, { id: 'corridoio', name: 'Corridoio' },
    { id: 'camera_da_letto', name: 'Camera da letto' }, { id: 'cameretta', name: 'Cameretta' }, { id: 'bagno', name: 'Bagno' },
  ];
  occupiedAreas = new Set<string>(['cameretta']);
  async start() { /* niente da fare */ }
  onPeopleChange(cb: () => void) { this.listeners.push(cb); }
  people(filter: string[]) { return this.peopleList.filter(p => !filter.length || filter.includes(p.id)); }
  areas() { return this.areaList; }
  occupancy(areaId: string): Occupancy {
    if (!this.areaList.some(a => a.id === areaId)) return { occupied: false, sensors: [] };
    const on = this.occupiedAreas.has(areaId);
    return { occupied: on, sensors: [{ id: `binary_sensor.presenza_${areaId}`, name: `Presenza ${areaId.replace(/_/g, ' ')}`, on }] };
  }
  setPerson(id: string, home: boolean) {
    const p = this.peopleList.find(x => x.id === id);
    if (!p || p.home === home) return;
    p.home = home; p.state = home ? 'home' : 'not_home';
    this.listeners.forEach(l => l());
  }
  toggleArea(id: string) { this.occupiedAreas.has(id) ? this.occupiedAreas.delete(id) : this.occupiedAreas.add(id); }
}
