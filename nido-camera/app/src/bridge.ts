/** Entità in Home Assistant via MQTT discovery: interruttori di privacy, ultima foto, stato della registrazione. */
import type { Engine, Mode } from './engine.js';
import { MODE_LABEL } from './engine.js';
import { Mqtt } from './mqtt.js';

const BASE = 'nido_camera';
const AVAIL = `${BASE}/disponibile`;
const STATE = `${BASE}/stato`;
const IMAGE = `${BASE}/foto`;
const MODES = Object.entries(MODE_LABEL) as [Mode, string][];

export class Bridge {
  private mqtt?: Mqtt;
  private last = '';
  mode: 'mqtt' | 'off' = 'off';
  constructor(private e: Engine, private enabled: boolean, private log: (m: string) => void) {}

  async start() {
    if (!this.enabled) return;
    const svc = await this.e.home.mqttService();
    if (!svc) { this.log('MQTT non disponibile: nessuna entità in Home Assistant (installa il broker Mosquitto)'); return; }
    this.mode = 'mqtt';
    this.mqtt = new Mqtt({ ...svc, clientId: `nido-camera-${Math.random().toString(16).slice(2, 8)}`, will: { topic: AVAIL, payload: 'offline', retain: true }, log: this.log });
    this.mqtt.onConnect = () => { this.mqtt!.publish(AVAIL, 'online', true); this.discovery(); this.last = ''; this.push(); };
    this.mqtt.onMessage = (t, p) => this.onCommand(t, p).catch(err => this.log(`Comando da Home Assistant non eseguito: ${err instanceof Error ? err.message : err}`));
    this.mqtt.subscribe(`${BASE}/cmd/#`);
    this.mqtt.subscribe('homeassistant/status');
    this.mqtt.start();
    this.e.on('changed', () => this.push());
    this.e.on('snapshot', (jpg: Buffer) => this.mqtt?.publish(IMAGE, jpg, true));
    setInterval(() => this.push(true), 60_000);
  }

  private cfg(component: string, key: string, conf: Record<string, unknown>) {
    const uid = `${BASE}_${key}`;
    this.mqtt!.publish(`homeassistant/${component}/${uid}/config`, JSON.stringify({
      unique_id: uid, availability_topic: AVAIL,
      device: { identifiers: [BASE], name: 'NIDO Camera', manufacturer: 'NIDO', model: this.e.camera?.deviceName ?? 'Camera HomeKit' },
      ...conf,
    }), true);
  }

  private discovery() {
    if (!this.mqtt?.connected) return;
    this.cfg('switch', 'automatica', { name: 'Registrazione e notifiche', state_topic: STATE, value_template: '{{ "OFF" if value_json.pausa else "ON" }}', command_topic: `${BASE}/cmd/automatica`, icon: 'mdi:cctv' });
    this.cfg('select', 'registra', { name: 'Registra', state_topic: STATE, value_template: '{{ value_json.registra }}', command_topic: `${BASE}/cmd/registra`, options: MODES.map(m => m[1]), icon: 'mdi:record-rec' });
    this.cfg('select', 'notifica', { name: 'Notifica', state_topic: STATE, value_template: '{{ value_json.notifica }}', command_topic: `${BASE}/cmd/notifica`, options: MODES.map(m => m[1]), icon: 'mdi:bell-ring' });
    this.cfg('binary_sensor', 'registrazione', { name: 'Registrazione in corso', state_topic: STATE, value_template: '{{ "ON" if value_json.registrazione else "OFF" }}', icon: 'mdi:record-circle' });
    this.cfg('sensor', 'ultimo_movimento', { name: 'Ultimo movimento', state_topic: STATE, value_template: '{{ value_json.ultimo_movimento }}', device_class: 'timestamp' });
    this.cfg('sensor', 'eventi_oggi', { name: 'Movimenti oggi', state_topic: STATE, value_template: '{{ value_json.oggi }}', state_class: 'measurement', icon: 'mdi:motion-sensor' });
    this.cfg('sensor', 'spazio', { name: 'Spazio usato', state_topic: STATE, value_template: '{{ value_json.spazio_mb }}', unit_of_measurement: 'MB', device_class: 'data_size', icon: 'mdi:harddisk' });
    this.cfg('button', 'foto', { name: 'Scatta foto', command_topic: `${BASE}/cmd/foto`, icon: 'mdi:camera' });
    this.cfg('button', 'registra_ora', { name: 'Registra 30 secondi', command_topic: `${BASE}/cmd/registra_ora`, icon: 'mdi:video' });
    this.cfg('image', 'ultima_foto', { name: 'Ultima foto', image_topic: IMAGE, content_type: 'image/jpeg' });
  }

  push(force = false) {
    if (!this.mqtt?.connected) return;
    const r = this.e.rules;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const last = this.e.store.events(0, Number.MAX_SAFE_INTEGER, 50).find(x => x.kind === 'movimento');
    const json = JSON.stringify({
      pausa: !!(r.pausedUntil && r.pausedUntil > Date.now()),
      registra: MODE_LABEL[r.record], notifica: MODE_LABEL[r.notify],
      registrazione: this.e.recorder.busy,
      ultimo_movimento: last ? new Date(last.ts).toISOString() : null,
      oggi: this.e.store.events(start.getTime()).filter(x => x.kind === 'movimento').length,
      spazio_mb: Math.round(this.e.store.totalBytes() / 1024 / 1024),
    });
    if (force || json !== this.last) { this.mqtt.publish(STATE, json, true); this.last = json; }
  }

  private async onCommand(topic: string, payload: string) {
    if (topic === 'homeassistant/status') { if (payload === 'online') { this.discovery(); this.push(true); } return; }
    const cmd = topic.slice(`${BASE}/cmd/`.length);
    const who = 'Home Assistant';
    const mode = (label: string) => MODES.find(m => m[1] === label)?.[0];
    if (cmd === 'automatica') this.e.saveRules({ pausedUntil: payload === 'OFF' ? Date.now() + 365 * 86400_000 : null }, who);
    else if (cmd === 'registra' && mode(payload)) this.e.saveRules({ record: mode(payload) }, who);
    else if (cmd === 'notifica' && mode(payload)) this.e.saveRules({ notify: mode(payload) }, who);
    else if (cmd === 'foto') await this.e.snapshot(undefined, who);
    else if (cmd === 'registra_ora') await this.e.motion('manuale', 'manuale', who);
    this.push(true);
  }
}
