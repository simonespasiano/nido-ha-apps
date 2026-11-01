import { EventEmitter } from 'node:events';

export interface HAState { entity_id: string; state: string; attributes: Record<string, any>; last_changed: string }
export interface HKCamera { title: string; entryId: string; cameraEntity: string | null; motionSensors: string[]; deviceName: string | null }

/**
 * Quello che serve di Home Assistant: stati (persone, sensori, aspirapolvere), le camere HomeKit
 * abbinate, i servizi notify e le credenziali MQTT. Emette 'state' a ogni cambio di stato.
 */
export interface Home extends EventEmitter {
  readonly kind: 'ha' | 'demo';
  connected: boolean;
  start(): Promise<void>;
  state(id: string): HAState | undefined;
  all(prefix: string): HAState[];
  homekitCameras(): Promise<HKCamera[]>;
  notifyServices(): Promise<string[]>;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<void>;
  cameraSnapshot(entity: string): Promise<Buffer | null>;
  mqttService(): Promise<{ host: string; port: number; username?: string; password?: string; ssl?: boolean } | null>;
  ingressPanel(): Promise<string | null>;
}

export class HAHome extends EventEmitter implements Home {
  readonly kind = 'ha' as const;
  connected = false;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private states = new Map<string, HAState>();
  private readonly wsUrl: string;
  private readonly restUrl: string;
  private readonly token: string;
  private readonly supervised: boolean;

  constructor(private log: (m: string) => void) {
    super();
    const base = process.env.HA_URL;
    this.token = process.env.HA_TOKEN ?? process.env.SUPERVISOR_TOKEN ?? '';
    this.supervised = !base && !!process.env.SUPERVISOR_TOKEN;
    this.wsUrl = base ? base.replace(/^http/, 'ws') + '/api/websocket' : 'ws://supervisor/core/websocket';
    this.restUrl = base ? base + '/api' : 'http://supervisor/core/api';
  }

  async start() {
    if (!this.token) { this.log('Nessun token di Home Assistant'); return; }
    await this.connect().catch(e => { this.log(`Home Assistant: ${e.message}`); setTimeout(() => this.reconnect(), 30_000); });
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
          if (old?.state !== ns?.state) this.emit('state', id, ns, old);
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
  private async reconnect() { try { await this.connect(); } catch { setTimeout(() => this.reconnect(), 30_000); } }

  private call(msg: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws!.send(JSON.stringify({ id, ...msg })); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  state(id: string) { return this.states.get(id); }
  all(prefix: string) { return [...this.states.values()].filter(s => s.entity_id.startsWith(prefix)); }

  async homekitCameras(): Promise<HKCamera[]> {
    if (!this.connected) return [];
    const [entries, devices, entities] = await Promise.all([
      this.call({ type: 'config_entries/get', domain: 'homekit_controller' }).catch(() => []),
      this.call({ type: 'config/device_registry/list' }),
      this.call({ type: 'config/entity_registry/list' }),
    ]);
    const out: HKCamera[] = [];
    for (const e of entries as any[]) {
      const ents = (entities as any[]).filter(x => x.config_entry_id === e.entry_id);
      const cam = ents.find(x => x.entity_id.startsWith('camera.'));
      if (!cam) continue;
      const dev = (devices as any[]).find(d => d.id === cam.device_id);
      const motion = ents.filter(x => x.entity_id.startsWith('binary_sensor.') && x.device_id === cam.device_id &&
        (this.states.get(x.entity_id)?.attributes.device_class === 'motion' || /motion|movimento/i.test(x.entity_id))).map(x => x.entity_id);
      out.push({ title: e.title, entryId: e.entry_id, cameraEntity: cam.entity_id, motionSensors: motion, deviceName: dev?.name_by_user ?? dev?.name ?? null });
    }
    return out;
  }

  async notifyServices(): Promise<string[]> {
    if (!this.connected) return [];
    const s = await this.call({ type: 'get_services' }).catch(() => ({}));
    return Object.keys(s.notify ?? {}).filter(n => n !== 'persistent_notification' && n !== 'send_message').sort();
  }

  async callService(domain: string, service: string, data: Record<string, unknown>) {
    await this.call({ type: 'call_service', domain, service, service_data: data });
  }

  async cameraSnapshot(entity: string): Promise<Buffer | null> {
    try {
      const r = await fetch(`${this.restUrl}/camera_proxy/${entity}`, { headers: { Authorization: `Bearer ${this.token}` } });
      return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    } catch { return null; }
  }

  async mqttService() {
    if (process.env.MQTT_HOST) return { host: process.env.MQTT_HOST, port: Number(process.env.MQTT_PORT ?? 1883), username: process.env.MQTT_USER, password: process.env.MQTT_PASSWORD };
    if (!this.supervised) return null;
    try {
      const r = await fetch('http://supervisor/services/mqtt', { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
      if (!r.ok) return null;
      const d: any = ((await r.json()) as any).data;
      return d?.host ? { host: d.host, port: Number(d.port ?? 1883), username: d.username, password: d.password, ssl: !!d.ssl } : null;
    } catch { return null; }
  }

  async ingressPanel() {
    if (!this.supervised) return null;
    try {
      const r = await fetch('http://supervisor/addons/self/info', { headers: { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` } });
      const d: any = ((await r.json()) as any).data;
      return d?.slug ? `/hassio/ingress/${d.slug}` : null;
    } catch { return null; }
  }
}

/** Casa finta per la demo: persone, un sensore di movimento della camera e un aspirapolvere. */
export class DemoHome extends EventEmitter implements Home {
  readonly kind = 'demo' as const;
  connected = true;
  private states = new Map<string, HAState>();
  sent: { service: string; data: unknown }[] = [];
  constructor() {
    super();
    const set = (id: string, state: string, attributes: Record<string, any>) => this.states.set(id, { entity_id: id, state, attributes, last_changed: new Date().toISOString() });
    set('person.simone', 'home', { friendly_name: 'Simone' });
    set('person.giulia', 'home', { friendly_name: 'Giulia' });
    set('binary_sensor.camera_hub_g3_motion', 'off', { friendly_name: 'Camera Hub G3 Movimento', device_class: 'motion' });
    set('binary_sensor.porta_ingresso', 'off', { friendly_name: 'Porta ingresso', device_class: 'door' });
    set('vacuum.narwal', 'docked', { friendly_name: 'Narwal' });
  }
  async start() { /* niente */ }
  state(id: string) { return this.states.get(id); }
  all(prefix: string) { return [...this.states.values()].filter(s => s.entity_id.startsWith(prefix)); }
  setState(id: string, state: string) {
    const old = this.states.get(id);
    if (!old || old.state === state) return;
    const ns = { ...old, state, last_changed: new Date().toISOString() };
    this.states.set(id, ns);
    this.emit('state', id, ns, old);
  }
  async homekitCameras(): Promise<HKCamera[]> {
    return [{ title: 'Camera-Hub-G3-DEMO', entryId: 'demo', cameraEntity: 'camera.camera_hub_g3', motionSensors: ['binary_sensor.camera_hub_g3_motion'], deviceName: 'Camera Hub G3' }];
  }
  async notifyServices() { return ['mobile_app_iphone_di_simone']; }
  async callService(domain: string, service: string, data: Record<string, unknown>) { this.sent.push({ service: `${domain}.${service}`, data }); }
  async cameraSnapshot() { return null; }
  async mqttService() { return null; }
  async ingressPanel() { return null; }
}
