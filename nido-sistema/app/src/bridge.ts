/** Sensori e comandi in Home Assistant: MQTT discovery se c'è il broker, altrimenti stati via REST. */
import type { Engine } from './engine.js';
import { MODE_LABEL, type FanMode } from './fan.js';
import { Mqtt } from './mqtt.js';

const BASE = 'nido_sistema';
const AVAIL = `${BASE}/disponibile`;
const STATE = `${BASE}/stato`;
const MODES = Object.entries(MODE_LABEL) as [FanMode, string][];

export interface Rest { setState(id: string, state: string, attrs: Record<string, unknown>): Promise<void> }

export class Bridge {
  private mqtt?: Mqtt;
  private lastPush = 0;
  mode: 'mqtt' | 'rest' | 'off' = 'off';
  constructor(private e: Engine, private enabled: boolean, private svc: (() => Promise<any>) | null, private rest: Rest | null, private log: (m: string) => void) {}

  async start() {
    if (!this.enabled) return;
    const s = await this.svc?.().catch(() => null);
    if (s) {
      this.mode = 'mqtt';
      this.mqtt = new Mqtt({ ...s, clientId: `nido-sistema-${Math.random().toString(16).slice(2, 8)}`, will: { topic: AVAIL, payload: 'offline', retain: true }, log: this.log });
      this.mqtt.onConnect = () => { this.mqtt!.publish(AVAIL, 'online', true); this.discovery(); this.push(true); };
      this.mqtt.onMessage = (t, p) => this.onCommand(t, p);
      this.mqtt.subscribe(`${BASE}/cmd/#`);
      this.mqtt.subscribe('homeassistant/status');
      this.mqtt.start();
    } else if (this.rest) { this.mode = 'rest'; this.log('MQTT non disponibile: pubblico solo sensori di lettura via REST'); }
    this.e.on('tick', () => this.push());
  }

  private cfg(component: string, key: string, conf: Record<string, unknown>) {
    const uid = `${BASE}_${key}`;
    this.mqtt!.publish(`homeassistant/${component}/${uid}/config`, JSON.stringify({
      unique_id: uid, availability_topic: AVAIL, state_topic: STATE,
      device: { identifiers: [BASE], name: 'Raspberry Pi', manufacturer: 'Raspberry Pi', model: this.e.last.model ?? 'Raspberry Pi', sw_version: 'NIDO Sistema' },
      ...conf,
    }), true);
  }

  private discovery() {
    const temp = (key: string, name: string, f: string) => this.cfg('sensor', key, { name, value_template: `{{ value_json.${f} }}`, device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement', suggested_display_precision: 1 });
    temp('cpu', 'Temperatura CPU', 'cpu');
    if (this.e.last.temps.rp1 != null) temp('rp1', 'Temperatura RP1', 'rp1');
    if (this.e.last.temps.ssd != null) temp('ssd', 'Temperatura SSD', 'ssd');
    this.cfg('sensor', 'ventola_giri', { name: 'Ventola', value_template: '{{ value_json.giri }}', unit_of_measurement: 'giri/min', state_class: 'measurement', icon: 'mdi:fan' });
    this.cfg('sensor', 'ventola_velocita', { name: 'Velocità ventola', value_template: '{{ value_json.ventola }}', unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:fan-speed-2' });
    this.cfg('sensor', 'cpu_uso', { name: 'Uso CPU', value_template: '{{ value_json.uso }}', unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:cpu-64-bit' });
    this.cfg('sensor', 'cpu_freq', { name: 'Frequenza CPU', value_template: '{{ value_json.freq }}', unit_of_measurement: 'MHz', device_class: 'frequency', state_class: 'measurement' });
    this.cfg('sensor', 'memoria', { name: 'Memoria usata', value_template: '{{ value_json.memoria }}', unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:memory' });
    this.cfg('sensor', 'disco', { name: 'Disco usato', value_template: '{{ value_json.disco }}', unit_of_measurement: '%', state_class: 'measurement', icon: 'mdi:harddisk' });
    this.cfg('sensor', 'avvio', { name: 'Ultimo avvio', value_template: '{{ value_json.avvio }}', device_class: 'timestamp' });
    this.cfg('binary_sensor', 'sottotensione', { name: 'Sottotensione', value_template: '{{ "ON" if value_json.sottotensione else "OFF" }}', device_class: 'problem' });
    this.cfg('binary_sensor', 'rallentato', { name: 'Rallentato', value_template: '{{ "ON" if value_json.rallentato else "OFF" }}', device_class: 'problem' });
    this.cfg('select', 'modalita', { name: 'Modalità ventola', value_template: '{{ value_json.modalita }}', command_topic: `${BASE}/cmd/modalita`, options: MODES.map(m => m[1]), icon: 'mdi:fan-auto' });
    this.cfg('button', 'raffredda', { name: 'Ventola al massimo 15 minuti', command_topic: `${BASE}/cmd/raffredda`, icon: 'mdi:fan-plus' });
  }

  push(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPush < 15_000) return;
    this.lastPush = now;
    const s = this.e.last;
    const p = {
      cpu: s.temps.cpu, rp1: s.temps.rp1, ssd: s.temps.ssd, giri: s.fan.rpm, ventola: s.fan.percent,
      uso: s.cpu.usage, freq: s.cpu.freqMHz, memoria: s.memory?.percent ?? null, disco: s.disk?.percent ?? null,
      avvio: s.uptime != null ? new Date(Math.floor((now - s.uptime * 1000) / 60_000) * 60_000).toISOString() : null,
      sottotensione: !!s.power.undervoltage, rallentato: s.power.throttled != null && (s.power.throttled & 0x6) !== 0,
      modalita: MODE_LABEL[this.e.settings.mode],
    };
    if (this.mode === 'mqtt' && this.mqtt?.connected) this.mqtt.publish(STATE, JSON.stringify(p), true);
    else if (this.mode === 'rest') {
      void this.rest!.setState('sensor.nido_sistema_cpu', String(p.cpu ?? 'unknown'), { unit_of_measurement: '°C', device_class: 'temperature', state_class: 'measurement', friendly_name: 'Raspberry temperatura CPU' });
      void this.rest!.setState('sensor.nido_sistema_ventola', String(p.giri ?? 'unknown'), { unit_of_measurement: 'giri/min', icon: 'mdi:fan', friendly_name: 'Raspberry ventola', velocita: p.ventola, modalita: p.modalita });
    }
  }

  private onCommand(topic: string, payload: string) {
    if (topic === 'homeassistant/status') { if (payload === 'online') { this.discovery(); this.push(true); } return; }
    const cmd = topic.slice(`${BASE}/cmd/`.length);
    if (cmd === 'modalita') { const m = MODES.find(x => x[1] === payload)?.[0]; if (m) this.e.setMode(m, 'Home Assistant'); }
    else if (cmd === 'raffredda') this.e.boost(15, 'Home Assistant');
    this.push(true);
  }
}
