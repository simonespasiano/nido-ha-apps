/**
 * Sensore esterno: NIDO imposta la valvola su "external" e le invia la temperatura del sensore della stanza,
 * al posto delle automazioni di Home Assistant. Invio a ogni variazione di almeno 0,1 °C (non più di una volta
 * ogni 30 secondi) e comunque ogni 5 minuti, perché la valvola non resti con un valore vecchio.
 */
import type { Store } from './db.js';
import type { DataSource, Room } from './types.js';

export interface FeedSettings { enabled: boolean; rooms: Record<string, boolean> }
export interface FeedState { sent: number | null; at: number | null; ok: boolean | null; error: string | null; switched: boolean }

const KEY = 'sensore_esterno';
const REFRESH_MS = 5 * 60_000;
const MIN_GAP_MS = 30_000;
const r1 = (v: number) => Math.round(v * 10) / 10;

export class Feeder {
  settings: FeedSettings;
  state = new Map<string, FeedState>();

  constructor(private src: DataSource, private store: Store, private log: (msg: string, room?: string | null) => void) {
    this.settings = store.getSetting<FeedSettings>(KEY) ?? { enabled: true, rooms: {} };
  }

  activeFor(room: Room) { return this.settings.enabled && this.settings.rooms[room.id] !== false; }

  save(s: Partial<FeedSettings>, user: string | null) {
    const before = this.settings;
    this.settings = { enabled: s.enabled ?? before.enabled, rooms: { ...before.rooms, ...(s.rooms ?? {}) } };
    this.store.setSetting(KEY, this.settings);
    this.log(`Sensore esterno: ${this.settings.enabled ? 'NIDO invia la temperatura della stanza alle valvole' : 'invio disattivato'}${user ? ` — da ${user}` : ''}`);
    // le stanze tolte tornano sul sensore interno della valvola
    for (const room of this.src.rooms()) if (!this.activeFor(room)) void this.setMode(room, 'internal');
    void this.run();
  }

  private async setMode(room: Room, mode: 'internal' | 'external') {
    const link = this.src.valveLink?.(room);
    if (!link?.select || link.mode === mode || !this.src.service) return;
    try {
      await this.src.service('select', 'select_option', link.select, { option: mode });
      this.log(`Valvola impostata sul sensore ${mode === 'external' ? 'esterno (stanza)' : 'interno'}`, room.id);
    } catch (e) { this.log(`Cambio del sensore della valvola non riuscito: ${e instanceof Error ? e.message : e}`, room.id); }
  }

  async run(now = Date.now()) {
    if (!this.src.valveLink || !this.src.service) return;
    for (const room of this.src.rooms()) {
      const st = this.state.get(room.id) ?? { sent: null, at: null, ok: null, error: null, switched: false };
      this.state.set(room.id, st);
      if (!this.activeFor(room)) continue;
      const link = this.src.valveLink(room);
      if (!link.select || !link.input) { st.error = 'La valvola non espone il sensore esterno (servono le entità "sensor" e "external_temperature_input" di Zigbee2MQTT)'; continue; }
      const t = this.src.read(room, now).tRoom;
      if (t == null) { st.error = 'Sensore della stanza non disponibile: la valvola usa l\'ultimo valore ricevuto'; continue; }
      const v = r1(t);
      // la valvola deve ricevere il valore prima di passare a "external", altrimenti regolerebbe su un dato vecchio
      const due = st.sent == null || st.at == null || now - st.at >= REFRESH_MS || (Math.abs(v - st.sent) >= 0.1 && now - st.at >= MIN_GAP_MS);
      if (due) {
        try {
          await this.src.service('number', 'set_value', link.input, { value: v });
          st.sent = v; st.at = now; st.error = null;
        } catch (e) { st.error = `Invio non riuscito: ${e instanceof Error ? e.message : e}`; continue; }
      }
      if (link.mode !== 'external') { await this.setMode(room, 'external'); st.switched = true; }
      // conferma: la valvola riporta il valore ricevuto (o lo usa come temperatura) entro qualche minuto
      const seen = [link.inputValue, link.local].some(x => x != null && st.sent != null && Math.abs(x - st.sent) <= 0.3);
      if (st.at != null && now - st.at > 3 * 60_000) st.ok = seen;
      else if (seen) st.ok = true;
    }
  }

  view(room: Room) {
    const link = this.src.valveLink?.(room) ?? null;
    return { active: this.activeFor(room), link, ...(this.state.get(room.id) ?? { sent: null, at: null, ok: null, error: null, switched: false }) };
  }
}
