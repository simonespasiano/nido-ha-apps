/**
 * Il robot in Home Assistant: entità "aspirapolvere" e sensori creati via MQTT discovery
 * (comandabili da dashboard e automazioni). Senza MQTT ripiega su sensori di sola lettura via REST.
 */
import type { Engine } from './engine.js';
import { Mqtt } from './mqtt.js';
import { FAN, WATER } from './protocol.js';

const BASE = 'nido_pulizie';
const AVAIL = `${BASE}/disponibile`;
const ROBOT_AVAIL = `${BASE}/robot`;
const STATE = `${BASE}/stato`;
const VACUUM = `${BASE}/aspirapolvere`; // il vacuum MQTT legge il JSON {state, fan_speed} direttamente, senza template

const FAN_LIST = [1, 2, 3, 4].map(n => FAN[n]);

function haState(e: Engine): string {
  switch (e.state.activity) {
    case 'pulizia': case 'mappatura': return 'cleaning';
    case 'pausa': return 'paused';
    case 'rientro': return 'returning';
    case 'in_carica': case 'carico': case 'base': return 'docked';
    case 'errore': return 'error';
    default: return 'idle';
  }
}

export class Bridge {
  private mqtt?: Mqtt;
  private lastPayload = '';
  private published = new Set<string>();
  mode: 'mqtt' | 'rest' | 'off' = 'off';

  constructor(private e: Engine, private enabled: boolean, private log: (m: string) => void) {}

  async start() {
    if (!this.enabled) return;
    const svc = await this.e.home.mqttService?.();
    if (svc) {
      this.mode = 'mqtt';
      this.mqtt = new Mqtt({ ...svc, clientId: `nido-pulizie-${Math.random().toString(16).slice(2, 8)}`, will: { topic: AVAIL, payload: 'offline', retain: true }, log: this.log });
      this.mqtt.onConnect = () => { this.mqtt!.publish(AVAIL, 'online', true); this.published.clear(); this.lastPayload = ''; this.discovery(); this.push(); };
      this.mqtt.onMessage = (t, p) => this.onCommand(t, p).catch(err => this.log(`Comando da Home Assistant non eseguito: ${err instanceof Error ? err.message : err}`));
      this.mqtt.subscribe(`${BASE}/cmd/#`);
      this.mqtt.subscribe('homeassistant/status');
      this.mqtt.start();
    } else if (this.e.home.setState) {
      this.mode = 'rest';
      this.log('MQTT non disponibile: pubblico solo sensori di lettura (installa il broker Mosquitto per comandare il robot da Home Assistant)');
    }
    this.e.client.on('state', () => this.push());
    this.e.client.on('map', () => this.discovery());
    this.e.on('programs', () => { this.discovery(); this.push(true); });
    this.e.on('session', () => this.push(true));
    setInterval(() => this.push(true), 60_000);
  }

  private device() {
    const s = this.e.state;
    return { identifiers: [`${BASE}_${s.deviceId ?? 'robot'}`], name: 'Narwal', manufacturer: 'Narwal', model: s.model ?? 'Narwal', sw_version: s.firmware };
  }

  private cfg(component: string, key: string, conf: Record<string, unknown>) {
    const uid = `${BASE}_${this.e.state.deviceId ?? 'robot'}_${key}`;
    const topic = `homeassistant/${component}/${uid}/config`;
    this.published.add(topic);
    this.mqtt!.publish(topic, JSON.stringify({
      unique_id: uid, device: this.device(),
      availability: [{ topic: AVAIL }, { topic: ROBOT_AVAIL }], availability_mode: 'all',
      ...conf,
    }), true);
  }

  private discovery() {
    if (!this.mqtt?.connected || !this.e.state.deviceId) return;
    const before = new Set(this.published);
    this.published.clear();
    this.cfg('vacuum', 'vacuum', {
      name: null, state_topic: VACUUM,
      json_attributes_topic: STATE, json_attributes_template: '{{ value_json.attributi | tojson }}',
      command_topic: `${BASE}/cmd/vacuum`, send_command_topic: `${BASE}/cmd/send`,
      set_fan_speed_topic: `${BASE}/cmd/fan`, fan_speed_list: FAN_LIST,
      supported_features: ['start', 'stop', 'pause', 'return_home', 'locate', 'fan_speed', 'send_command'],
      payload_start: 'start', payload_pause: 'pause', payload_stop: 'stop', payload_return_to_base: 'return_to_base', payload_locate: 'locate',
    });
    // il JSON di stato contiene sia la parte per il vacuum sia i valori dei sensori
    const sensor = (key: string, name: string, tpl: string, extra: Record<string, unknown> = {}) =>
      this.cfg('sensor', key, { name, state_topic: STATE, value_template: tpl, ...extra });
    sensor('batteria', 'Batteria', '{{ value_json.batteria }}', { device_class: 'battery', unit_of_measurement: '%', state_class: 'measurement' });
    sensor('attivita', 'Attività', '{{ value_json.attivita }}', { icon: 'mdi:robot-vacuum' });
    sensor('stanza', 'Stanza attuale', '{{ value_json.stanza }}', { icon: 'mdi:floor-plan' });
    sensor('area', 'Superficie pulita', '{{ value_json.area }}', { unit_of_measurement: 'm²', icon: 'mdi:texture-box' });
    sensor('avanzamento', 'Avanzamento', '{{ value_json.avanzamento }}', { unit_of_measurement: '%', icon: 'mdi:progress-clock' });
    sensor('ultima', 'Ultima pulizia', '{{ value_json.ultima }}', { device_class: 'timestamp' });
    sensor('settimana', 'Superficie ultimi 7 giorni', '{{ value_json.settimana }}', { unit_of_measurement: 'm²', state_class: 'measurement', icon: 'mdi:chart-bar' });
    this.cfg('binary_sensor', 'errore', { name: 'Problema', state_topic: STATE, value_template: '{{ "ON" if value_json.errore else "OFF" }}', device_class: 'problem' });
    this.cfg('binary_sensor', 'base', { name: 'Sulla base', state_topic: STATE, value_template: '{{ "ON" if value_json.base else "OFF" }}', icon: 'mdi:home-import-outline' });
    this.cfg('select', 'acqua', {
      name: 'Acqua lavaggio', state_topic: STATE, value_template: '{{ value_json.acqua }}', command_topic: `${BASE}/cmd/water`,
      options: [1, 2, 3].map(n => WATER[n]), icon: 'mdi:water',
    });
    for (const [k, n, i] of [['lava_mop', 'Lava i mop', 'mdi:water-sync'], ['asciuga_mop', 'Asciuga i mop', 'mdi:fan'], ['svuota', 'Svuota il contenitore', 'mdi:delete-empty'], ['aggiorna_mappa', 'Aggiorna la mappa', 'mdi:map-search']] as const)
      this.cfg('button', k, { name: n, command_topic: `${BASE}/cmd/azione/${k}`, icon: i });
    for (const r of this.e.map?.rooms ?? [])
      this.cfg('button', `stanza_${r.id}`, { name: `Pulisci ${r.name}`, command_topic: `${BASE}/cmd/stanza/${r.id}`, icon: 'mdi:broom' });
    for (const p of this.e.programs) {
      this.cfg('switch', `programma_${p.id.slice(0, 8)}`, { name: `Programma ${p.name}`, state_topic: `${BASE}/programma/${p.id}`, command_topic: `${BASE}/cmd/programma/${p.id}/attivo`, icon: 'mdi:calendar-clock' });
      this.cfg('button', `esegui_${p.id.slice(0, 8)}`, { name: `Esegui ${p.name}`, command_topic: `${BASE}/cmd/programma/${p.id}/esegui`, icon: 'mdi:play-circle-outline' });
    }
    // entità che non esistono più (stanze o programmi rimossi)
    for (const t of before) if (!this.published.has(t)) this.mqtt.publish(t, '', true);
  }

  private stats() {
    const since = Date.now() - 7 * 86400_000;
    const ss = this.e.store.sessions(since);
    const area = ss.reduce((a, s) => a + (s.area ?? 0), 0);
    const last = this.e.store.sessions(0, Number.MAX_SAFE_INTEGER, 1)[0];
    return { area: Math.round(area * 10) / 10, last: last ? new Date(last.end ?? last.start).toISOString() : null };
  }

  push(force = false) {
    const s = this.e.state, st = this.stats();
    const live = this.e.liveSession();
    const payload = {
      vacuum: { state: haState(this.e), fan_speed: s.fan ? FAN[Math.min(4, s.fan)] : null },
      batteria: s.battery ?? null,
      attivita: s.label,
      stanza: s.currentRoomId && live ? this.e.roomName(s.currentRoomId) : 'nessuna',
      area: live ? (s.area ?? 0) : 0,
      avanzamento: live ? (s.progress ?? 0) : 0,
      ultima: st.last,
      settimana: st.area,
      errore: s.errors.length > 0,
      base: s.docked,
      acqua: s.water ? WATER[s.water] : null,
      attributi: { stato: s.label, batteria: s.battery, stanza_attuale: s.currentRoomId ? this.e.roomName(s.currentRoomId) : null, codici_errore: s.errors, firmware: s.firmware, stanze: (this.e.map?.rooms ?? []).map(r => r.name) },
    };
    const json = JSON.stringify(payload);
    if (this.mode === 'mqtt' && this.mqtt?.connected) {
      this.mqtt.publish(ROBOT_AVAIL, s.online ? 'online' : 'offline', true);
      if (force || json !== this.lastPayload) { this.mqtt.publish(STATE, json, true); this.mqtt.publish(VACUUM, JSON.stringify(payload.vacuum), true); this.lastPayload = json; }
      for (const p of this.e.programs) this.mqtt.publish(`${BASE}/programma/${p.id}`, p.enabled ? 'ON' : 'OFF', true);
    } else if (this.mode === 'rest' && (force || json !== this.lastPayload)) {
      this.lastPayload = json;
      void this.e.home.setState!('sensor.nido_pulizie_stato', s.label, { ...payload.attributi, batteria: s.battery, superficie_7_giorni: st.area, ultima_pulizia: st.last, icon: 'mdi:robot-vacuum', friendly_name: 'Narwal' });
      void this.e.home.setState!('sensor.nido_pulizie_batteria', String(s.battery ?? 'unknown'), { unit_of_measurement: '%', device_class: 'battery', friendly_name: 'Narwal batteria' });
    }
  }

  private async onCommand(topic: string, payload: string) {
    if (topic === 'homeassistant/status') { if (payload === 'online') { this.published.clear(); this.discovery(); this.push(true); } return; }
    const rest = topic.slice(`${BASE}/cmd/`.length).split('/');
    const who = 'Home Assistant';
    const e = this.e;
    switch (rest[0]) {
      case 'vacuum': {
        const map: Record<string, string> = { pause: 'pausa', stop: 'stop', return_to_base: 'base', locate: 'trova' };
        if (payload === 'start') {
          if (e.state.activity === 'pausa') await e.action('riprendi', null, who);
          else await e.cleanRooms([], undefined, who, who);
        } else if (map[payload]) await e.action(map[payload], null, who);
        break;
      }
      case 'fan': { const n = Number(Object.entries(FAN).find(([, v]) => v === payload)?.[0]); if (n) await e.action('aspirazione', n, who); break; }
      case 'water': { const n = Number(Object.entries(WATER).find(([, v]) => v === payload)?.[0]); if (n) await e.action('acqua', n, who); break; }
      case 'azione': await e.action(rest[1], null, who); break;
      case 'stanza': await e.cleanRooms([Number(rest[1])], undefined, who, who, undefined, true); break;
      case 'programma': {
        const p = e.programs.find(x => x.id === rest[1]);
        if (!p) return;
        if (rest[2] === 'attivo') { p.enabled = payload === 'ON'; e.savePrograms(); e.event('programma', `Programma «${p.name}» ${p.enabled ? 'attivato' : 'disattivato'}`, who); }
        else if (rest[2] === 'esegui') await e.runProgram(p, 'da Home Assistant', who);
        break;
      }
      case 'send': {
        // vacuum.send_command: command "pulisci_stanze" (o "clean_rooms"), params { stanze: ["Cucina", 3], modo, aspirazione, acqua }
        let j: any; try { j = JSON.parse(payload); } catch { j = { command: payload }; }
        const cmd = j.command ?? j;
        const params = j.params ?? {};
        if (cmd === 'pulisci_stanze' || cmd === 'clean_rooms' || cmd === 'app_segment_clean') {
          const list: any[] = params.stanze ?? params.rooms ?? params.segments ?? (Array.isArray(params) ? params : []);
          const ids = list.map(v => typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : e.map?.rooms.find(r => r.name.toLowerCase() === String(v).toLowerCase())?.id).filter((x): x is number => !!x);
          await e.cleanRooms(ids, { mode: params.modo ?? params.mode, fan: params.aspirazione ?? params.fan, water: params.acqua ?? params.water, passes: params.passaggi }, who, who, undefined, true);
        } else if (typeof cmd === 'string') await e.action(cmd, params.valore ?? params.value ?? null, who);
        break;
      }
    }
  }
}
