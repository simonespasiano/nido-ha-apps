/**
 * NIDO Tapparelle in Home Assistant: modalità, protezione dal sole, scenari e interruttori per tapparella
 * creati via MQTT discovery, così si usano da dashboard, assistenti vocali e automazioni.
 * Senza MQTT pubblica solo un sensore di lettura via REST.
 */
import type { Engine } from './engine.js';
import { MODES, sanitizeShutter, type Mode } from './model.js';
import { Mqtt } from './mqtt.js';

const BASE = 'nido_tapparelle';
const AVAIL = `${BASE}/disponibile`;
const STATE = `${BASE}/stato`;
const DEVICE = { identifiers: [BASE], name: 'NIDO Tapparelle', manufacturer: 'NIDO', model: 'Gestione tapparelle' };

export class Bridge {
  private mqtt?: Mqtt;
  private published = new Set<string>();
  private last = '';
  mode: 'mqtt' | 'rest' | 'off' = 'off';

  constructor(private e: Engine, private enabled: boolean, private log: (m: string) => void) {}

  async start() {
    if (!this.enabled) return;
    const svc = await this.e.home.mqttService?.();
    if (svc) {
      this.mode = 'mqtt';
      this.mqtt = new Mqtt({ ...svc, clientId: `${BASE}-${Math.random().toString(16).slice(2, 8)}`, will: { topic: AVAIL, payload: 'offline', retain: true }, log: this.log });
      this.mqtt.onConnect = () => { this.mqtt!.publish(AVAIL, 'online', true); this.last = ''; this.discovery(); this.push(); };
      this.mqtt.onMessage = (t, p) => this.onCommand(t, p).catch(err => this.log(`Comando da Home Assistant non eseguito: ${err instanceof Error ? err.message : err}`));
      this.mqtt.subscribe(`${BASE}/cmd/#`);
      this.mqtt.subscribe('homeassistant/status');
      this.mqtt.start();
    } else if (this.e.home.setState) {
      this.mode = 'rest';
      this.log('MQTT non disponibile: pubblico solo un sensore di lettura (installa il broker Mosquitto per comandare NIDO da Home Assistant)');
    }
    this.e.on('tick', () => this.push());
    this.e.on('state', () => this.push());
    this.e.on('settings', () => { this.discovery(); this.push(true); });
    this.e.on('scenes', () => { this.discovery(); this.push(true); });
  }

  private cfg(component: string, key: string, conf: Record<string, unknown>) {
    const uid = `${BASE}_${key}`;
    const topic = `homeassistant/${component}/${uid}/config`;
    this.published.add(topic);
    this.mqtt!.publish(topic, JSON.stringify({ unique_id: uid, object_id: uid, device: DEVICE, availability_topic: AVAIL, ...conf }), true);
  }

  private discovery() {
    if (!this.mqtt?.connected) return;
    const before = new Set(this.published);
    this.published.clear();
    const labels = this.e.overview().modeLabel;
    this.cfg('select', 'modalita', {
      name: 'Modalità', icon: 'mdi:window-shutter-cog', state_topic: STATE, value_template: '{{ value_json.modalita_testo }}',
      command_topic: `${BASE}/cmd/modalita`, options: MODES.map(m => labels[m]),
      json_attributes_topic: STATE, json_attributes_template: '{{ value_json.attributi | tojson }}',
    });
    this.cfg('switch', 'sole', {
      name: 'Protezione dal sole', icon: 'mdi:weather-sunny-alert', state_topic: STATE, value_template: '{{ "ON" if value_json.sole else "OFF" }}',
      command_topic: `${BASE}/cmd/sole`,
    });
    this.cfg('sensor', 'prossimo', {
      name: 'Prossimo movimento', icon: 'mdi:clock-outline', device_class: 'timestamp', state_topic: STATE,
      value_template: '{{ value_json.prossimo or None }}', json_attributes_topic: STATE, json_attributes_template: '{{ value_json.prossimo_info | tojson }}',
    });
    this.cfg('button', 'apri_tutte', { name: 'Apri tutte', icon: 'mdi:arrow-up-box', command_topic: `${BASE}/cmd/tutte`, payload_press: 'apri' });
    this.cfg('button', 'chiudi_tutte', { name: 'Chiudi tutte', icon: 'mdi:arrow-down-box', command_topic: `${BASE}/cmd/tutte`, payload_press: 'chiudi' });
    for (const sc of this.e.scenes)
      this.cfg('button', `scenario_${sc.id}`, { name: `Scenario ${sc.name}`, icon: 'mdi:palette-outline', command_topic: `${BASE}/cmd/scenario`, payload_press: sc.id });
    for (const s of this.e.shutters()) {
      const name = this.e.nameOf(s);
      this.cfg('switch', `auto_${s.id}`, {
        name: `${name} automatica`, icon: 'mdi:window-shutter-auto', state_topic: STATE,
        value_template: `{{ "ON" if value_json.auto['${s.id}'] else "OFF" }}`, command_topic: `${BASE}/cmd/auto/${s.id}`,
      });
      this.cfg('binary_sensor', `pausa_${s.id}`, {
        name: `${name} in pausa manuale`, icon: 'mdi:hand-back-right', state_topic: STATE,
        value_template: `{{ "ON" if value_json.pausa['${s.id}'] else "OFF" }}`,
      });
    }
    for (const t of before) if (!this.published.has(t)) this.mqtt.publish(t, '', true);
  }

  private payload() {
    const ov = this.e.overview();
    const views = this.e.views();
    const next = ov.next[0];
    return {
      modalita: ov.mode, modalita_testo: ov.modeLabel[ov.mode as Mode], sole: this.e.global.sun.enabled,
      prossimo: next ? new Date(next.ts).toISOString() : null,
      prossimo_info: next ? { regola: next.name, azione: next.text, tapparelle: next.shutters.length } : {},
      auto: Object.fromEntries(views.map(v => [v.id, v.settings.enabled])),
      pausa: Object.fromEntries(views.map(v => [v.id, !!v.hold])),
      attributi: {
        modalita_effettiva: ov.effective, presenza: ov.presence.state, stagione: ov.season,
        sole_azimut: ov.sun?.azimuth ?? null, sole_elevazione: ov.sun?.elevation ?? null,
        vento_forte: ov.storm.wind, pioggia: ov.storm.rain,
        aperte: views.filter(v => (v.position ?? 0) >= 95).length, chiuse: views.filter(v => (v.position ?? 100) <= 5).length,
        protette_dal_sole: views.filter(v => v.protect).length,
      },
    };
  }

  private push(force = false) {
    const p = this.payload();
    const json = JSON.stringify(p);
    if (!force && json === this.last) return;
    this.last = json;
    if (this.mode === 'mqtt') this.mqtt!.publish(STATE, json, true);
    else if (this.mode === 'rest') this.e.home.setState?.('sensor.nido_tapparelle_modalita', p.modalita_testo, {
      friendly_name: 'NIDO Tapparelle', icon: 'mdi:window-shutter-cog', ...p.attributi, prossimo: p.prossimo,
    });
  }

  private async onCommand(topic: string, payload: string) {
    if (topic === 'homeassistant/status') { if (payload === 'online') { this.discovery(); this.push(true); } return; }
    const parts = topic.slice(BASE.length + 1).split('/'); // cmd/...
    const ctx = { origin: 'automazione' as const, who: 'Home Assistant', reason: 'da Home Assistant' };
    switch (parts[1]) {
      case 'modalita': {
        const labels = this.e.overview().modeLabel;
        const m = (Object.keys(labels) as Mode[]).find(k => labels[k] === payload || k === payload);
        if (!m) return;
        this.e.saveGlobal({ ...this.e.global, mode: m });
        this.e.log(`Modalità impostata su ${labels[m]} da Home Assistant`, null, 'modalita', 'automazione', 'Home Assistant');
        await this.e.tick();
        break;
      }
      case 'sole':
        this.e.saveGlobal({ ...this.e.global, sun: { ...this.e.global.sun, enabled: payload === 'ON' } });
        this.e.log(`Protezione dal sole ${payload === 'ON' ? 'attivata' : 'disattivata'} da Home Assistant`, null, 'sole', 'automazione', 'Home Assistant');
        break;
      case 'scenario': await this.e.runScene(payload, ctx); break;
      case 'tutte':
        for (const s of this.e.shutters()) await this.e.command(s.id, payload === 'apri' ? 'open' : 'close', ctx).catch(() => undefined);
        this.e.log(`${payload === 'apri' ? 'Apri' : 'Chiudi'} tutte — da Home Assistant`, null, 'comando', 'automazione', 'Home Assistant');
        break;
      case 'auto': {
        const id = parts[2];
        const s = this.e.shutters().find(x => x.id === id);
        if (!s) return;
        this.e.saveShutter(id, sanitizeShutter({ enabled: payload === 'ON' }, s.settings));
        this.e.log(`Automazioni ${payload === 'ON' ? 'attivate' : 'disattivate'} da Home Assistant`, id, 'comando', 'automazione', 'Home Assistant');
        break;
      }
    }
    this.push(true);
  }
}
