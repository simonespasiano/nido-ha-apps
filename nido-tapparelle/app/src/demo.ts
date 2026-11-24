/** Casa finta per provare l'app sul computer: tapparelle che si muovono, contatti, sensori esterni e persone. */
import type { Area, CallInfo, CoverInfo, HAState, Home, Person, SensorInfo } from './home.js';
import { sensorRole } from './home.js';
import { sunPosition } from './sun.js';

interface DemoCover { entity: string; name: string; area: string; pos: number; target: number | null; position: boolean }

const AREAS: Area[] = [
  { id: 'soggiorno', name: 'Soggiorno' }, { id: 'cucina', name: 'Cucina' }, { id: 'camera', name: 'Camera da letto' },
  { id: 'cameretta', name: 'Cameretta' }, { id: 'studio', name: 'Studio' }, { id: 'bagno', name: 'Bagno' }, { id: 'esterno', name: 'Esterno' },
];
const LOC = { lat: 45.528, lon: 9.276, name: 'Casa (demo)' };

export class DemoHome implements Home {
  readonly kind = 'demo' as const;
  connected = true;
  private covs: DemoCover[] = [
    { entity: 'cover.tapparella_soggiorno', name: 'Porta-finestra soggiorno', area: 'soggiorno', pos: 100, target: null, position: true },
    { entity: 'cover.tapparella_soggiorno_ovest', name: 'Finestra soggiorno', area: 'soggiorno', pos: 100, target: null, position: true },
    { entity: 'cover.tapparella_cucina', name: 'Tapparella cucina', area: 'cucina', pos: 60, target: null, position: true },
    { entity: 'cover.tapparella_camera', name: 'Tapparella camera', area: 'camera', pos: 0, target: null, position: true },
    { entity: 'cover.tapparella_cameretta', name: 'Tapparella cameretta', area: 'cameretta', pos: 100, target: null, position: true },
    { entity: 'cover.tapparella_studio', name: 'Tapparella studio', area: 'studio', pos: 40, target: null, position: true },
    { entity: 'cover.tapparella_bagno', name: 'Tapparella bagno', area: 'bagno', pos: 100, target: null, position: false },
  ];
  private st = new Map<string, HAState>();
  private area = new Map<string, string>();
  private cbs: ((e: string, o: HAState | undefined, n: HAState | undefined) => void)[] = [];
  private own: { entity: string; ts: number }[] = [];
  peopleList: Person[] = [
    { id: 'person.simone', name: 'Simone', home: true, state: 'home', trackers: 1 },
    { id: 'person.giulia', name: 'Giulia', home: true, state: 'home', trackers: 1 },
  ];

  constructor() {
    const set = (id: string, state: string, attributes: Record<string, any>, area?: string) => {
      this.st.set(id, { entity_id: id, state, attributes, last_changed: new Date().toISOString() });
      if (area) this.area.set(id, area);
    };
    for (const c of this.covs) { this.area.set(c.entity, c.area); this.publishCover(c, false); }
    set('binary_sensor.porta_finestra_soggiorno', 'off', { friendly_name: 'Porta-finestra soggiorno', device_class: 'door' }, 'soggiorno');
    set('binary_sensor.finestra_cucina', 'off', { friendly_name: 'Finestra cucina', device_class: 'window' }, 'cucina');
    set('sensor.temperatura_esterna', '17.5', { friendly_name: 'Temperatura esterna', device_class: 'temperature', unit_of_measurement: '°C' }, 'esterno');
    set('sensor.luminosita_esterna', '0', { friendly_name: 'Luminosità esterna', device_class: 'illuminance', unit_of_measurement: 'lx' }, 'esterno');
    set('sensor.vento', '8', { friendly_name: 'Velocità del vento', device_class: 'wind_speed', unit_of_measurement: 'km/h' }, 'esterno');
    set('weather.casa', 'sunny', { friendly_name: 'Meteo casa', temperature: 17, wind_speed: 8 });
    for (const [a, t] of [['soggiorno', 22.4], ['cucina', 23.1], ['camera', 20.8], ['cameretta', 21.5], ['studio', 24.2]] as const)
      set(`sensor.temperatura_${a}`, String(t), { friendly_name: `Temperatura ${AREAS.find(x => x.id === a)!.name}`, device_class: 'temperature', unit_of_measurement: '°C' }, a);
    for (const p of this.peopleList) set(p.id, p.state, { friendly_name: p.name, device_trackers: ['device_tracker.x'] });
  }

  async start() {
    setInterval(() => this.step(), 500);
    setInterval(() => this.weather(), 30_000);
    this.weather();
  }

  private publishCover(c: DemoCover, notify = true) {
    const old = this.st.get(c.entity);
    const moving = c.target != null && Math.round(c.target) !== Math.round(c.pos);
    const state = moving ? (c.target! > c.pos ? 'opening' : 'closing') : c.pos <= 0 ? 'closed' : 'open';
    const ns: HAState = { entity_id: c.entity, state, last_changed: new Date().toISOString(), attributes: {
      friendly_name: c.name, device_class: 'shutter', supported_features: c.position ? 15 : 11,
      ...(c.position ? { current_position: Math.round(c.pos) } : {}),
    } };
    this.st.set(c.entity, ns);
    if (notify && (old?.state !== ns.state || old?.attributes.current_position !== ns.attributes.current_position)) this.cbs.forEach(cb => cb(c.entity, old, ns));
  }

  private step() {
    for (const c of this.covs) {
      if (c.target == null) continue;
      const d = c.target - c.pos;
      if (Math.abs(d) <= 2.5) { c.pos = c.target; c.target = null; }
      else c.pos += Math.sign(d) * 2.5;
      this.publishCover(c);
    }
  }

  private weather() {
    const s = sunPosition(Date.now(), LOC.lat, LOC.lon);
    const lux = s.elevation <= 0 ? 0 : Math.round(110000 * Math.sin((s.elevation * Math.PI) / 180) ** 1.2);
    this.setRaw('sensor.luminosita_esterna', String(lux));
  }

  private setRaw(id: string, state: string, attrs: Record<string, any> = {}) {
    const old = this.st.get(id);
    if (!old) return;
    const ns = { ...old, state, attributes: { ...old.attributes, ...attrs }, last_changed: new Date().toISOString() };
    this.st.set(id, ns);
    if (old.state !== state) this.cbs.forEach(cb => cb(id, old, ns));
  }

  /** Comandi dall'interfaccia demo: pulsante a muro, porte, persone, vento. */
  simulate(kind: string, id: string, value: unknown) {
    if (kind === 'muro') { const c = this.covs.find(x => x.entity === id); if (c) { c.target = Number(value); this.publishCover(c); } }
    else if (kind === 'contatto') this.setRaw(id, value ? 'on' : 'off');
    else if (kind === 'persona') {
      const p = this.peopleList.find(x => x.id === id);
      if (p) { p.home = !!value; p.state = value ? 'home' : 'not_home'; this.setRaw(id, p.state); }
    } else if (kind === 'valore') this.setRaw(id, String(value));
  }

  onChange(cb: (e: string, o: HAState | undefined, n: HAState | undefined) => void) { this.cbs.push(cb); }
  onRegistry() { /* niente */ }
  get(entity: string) { return this.st.get(entity); }
  areas() { return AREAS; }
  location() { return LOC; }
  people(filter: string[]) { return this.peopleList.filter(p => !filter.length || filter.includes(p.id)); }

  covers(): CoverInfo[] {
    return this.covs.map(c => {
      const s = this.st.get(c.entity)!;
      return {
        entity: c.entity, name: c.name, areaId: c.area, areaName: AREAS.find(a => a.id === c.area)!.name,
        position: c.position ? Math.round(c.pos) : (c.pos > 0 ? 100 : 0), state: s.state,
        supportsPosition: c.position, supportsStop: true, available: true, deviceClass: 'shutter',
      };
    });
  }

  sensors(): SensorInfo[] {
    const out: SensorInfo[] = [];
    for (const s of this.st.values()) {
      const role = sensorRole(s.entity_id, s.attributes);
      if (!role) continue;
      const areaId = this.area.get(s.entity_id) ?? null;
      out.push({ entity: s.entity_id, name: s.attributes.friendly_name, domain: s.entity_id.split('.')[0], deviceClass: s.attributes.device_class ?? null,
        areaId, areaName: AREAS.find(a => a.id === areaId)?.name ?? null, state: s.state, unit: s.attributes.unit_of_measurement ?? null, role });
    }
    return out;
  }

  async cover(entity: string, action: 'open' | 'close' | 'stop' | 'position', position?: number) {
    const c = this.covs.find(x => x.entity === entity);
    if (!c) throw new Error('tapparella sconosciuta');
    this.own.push({ entity, ts: Date.now() });
    if (action === 'stop') c.target = null;
    else if (!c.position) c.target = action === 'close' || (action === 'position' && (position ?? 0) < 50) ? 0 : 100;
    else c.target = action === 'open' ? 100 : action === 'close' ? 0 : Math.round(position ?? 0);
    this.publishCover(c);
  }

  lastCall(entity: string, withinMs: number, now = Date.now()): CallInfo | null {
    const o = [...this.own].reverse().find(x => x.entity === entity && now - x.ts < withinMs);
    return o ? { ts: o.ts, userId: null, userName: null, automation: false, own: true, service: '' } : null;
  }

  async notifyServices() { return ['mobile_app_iphone_di_simone']; }
  async notify(service: string, title: string, message: string) { console.log(`[demo] notifica ${service}: ${title} — ${message}`); }
}
