import { detect, plantState, type DetectorConfig } from './detector.js';
import type { Store } from './db.js';
import type { AppEvent, DataSource, PlantStatus, Room, RoomStatus, Sample } from './types.js';

const fmt = (n: number) => n.toFixed(1).replace('.', ',');
const BUFFER_MIN = 40;

export interface RoomView {
  room: Room;
  sample: Sample | null;
  status: RoomStatus | null;
  todayMinutes: number;
}

/** Ciclo principale: legge, rileva, registra, pubblica. */
export class Engine {
  private buffers = new Map<string, Sample[]>();
  private statuses = new Map<string, RoomStatus>();
  private lastSamples = new Map<string, Sample>();
  private lastWindowEvent = new Map<string, number>();
  plant?: PlantStatus;
  lastTick = 0;

  constructor(
    private src: DataSource,
    private store: Store,
    private cfg: DetectorConfig,
    private publishEnabled: boolean,
  ) {}

  log(message: string, room: string | null = null, kind: AppEvent['kind'] = 'sistema', ts = Date.now()) {
    this.store.insertEvent({ ts, room, kind, message });
  }

  async tick(now = Date.now(), publish = true) {
    const statuses: RoomStatus[] = [];
    for (const room of this.src.rooms()) {
      const sample = this.src.read(room, now);
      const buf = (this.buffers.get(room.id) ?? []).filter(s => s.ts >= now - BUFFER_MIN * 60_000);
      const prev = this.statuses.get(room.id);
      const status = detect(this.cfg, buf, sample, prev);
      sample.heating = status.heating;

      // eventi leggibili per il diario
      if (prev && prev.heating !== status.heating) {
        this.log(status.heating
          ? `Termosifone acceso — ${status.reason.charAt(0).toLowerCase()}${status.reason.slice(1)}`
          : `Termosifone spento — ${status.reason.charAt(0).toLowerCase()}${status.reason.slice(1)}`,
          room.id, status.heating ? 'calorifero_on' : 'calorifero_off', now);
      }
      if (status.window && !prev?.window && now - (this.lastWindowEvent.get(room.id) ?? 0) > 30 * 60_000) {
        this.lastWindowEvent.set(room.id, now);
        this.log(`Possibile finestra aperta: la stanza perde ${fmt(Math.abs(status.slopeRoom ?? 0))} °C/ora`, room.id, 'finestra', now);
      }
      const last = this.lastSamples.get(room.id);
      if (last?.setpoint != null && sample.setpoint != null && Math.abs(last.setpoint - sample.setpoint) >= 0.1) {
        this.log(`Obiettivo da ${fmt(last.setpoint)} a ${fmt(sample.setpoint)} °C`, room.id, 'obiettivo', now);
      }
      if (last?.mode && sample.mode && last.mode !== sample.mode) {
        this.log(`Modalità cambiata: ${last.mode} → ${sample.mode}`, room.id, 'modalita', now);
      }

      buf.push(sample);
      this.buffers.set(room.id, buf);
      this.statuses.set(room.id, status);
      this.lastSamples.set(room.id, sample);
      this.store.insertSample(room.id, sample);
      statuses.push(status);

      if (publish && this.publishEnabled && this.src.publish) {
        this.src.publish(room, status, this.plant!).catch(() => {});
      }
    }

    const newPlant = plantState(statuses, now, this.plant);
    if (this.plant && this.plant.state !== newPlant.state) {
      if (newPlant.state === 'acceso') this.log('Impianto centralizzato acceso', null, 'impianto_on', now);
      if (newPlant.state === 'spento') this.log('Impianto centralizzato probabilmente spento', null, 'impianto_off', now);
    }
    this.plant = newPlant;
    if (publish && this.publishEnabled && this.src.publishPlant) this.src.publishPlant(newPlant).catch(() => {});
    this.lastTick = now;
  }

  views(): RoomView[] {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    return this.src.rooms().map(room => ({
      room,
      sample: this.lastSamples.get(room.id) ?? null,
      status: this.statuses.get(room.id) ?? null,
      todayMinutes: this.store.heatingMinutes(room.id, startOfDay.getTime(), Date.now() + 1),
    }));
  }
}

/** Statistiche: ore di accensione e velocità di riscaldamento/raffreddamento stimate dai dati. */
export function roomStats(store: Store, room: Room) {
  const day = 86_400_000;
  const sod = new Date(); sod.setHours(0, 0, 0, 0);
  const t0 = sod.getTime();
  const now = Date.now() + 1;
  const hist = store.history(room.id, now - 7 * day, 1_000_000);

  // segmenti continui con lo stesso stato del calorifero
  const rates = { heat: [] as number[], cool: [] as number[] };
  let seg: Sample[] = [];
  const flush = () => {
    if (seg.length < 5) return;
    const a = seg[0], b = seg[seg.length - 1];
    const h = (b.ts - a.ts) / 3_600_000;
    if (a.tRoom == null || b.tRoom == null) return;
    if (a.heating && h >= 0.33) rates.heat.push((b.tRoom - a.tRoom) / h);
    if (!a.heating && h >= 1) rates.cool.push((b.tRoom - a.tRoom) / h);
  };
  for (const s of hist) {
    if (seg.length && (seg[0].heating !== s.heating || s.ts - seg[seg.length - 1].ts > 15 * 60_000)) { flush(); seg = []; }
    seg.push(s);
  }
  flush();
  const median = (xs: number[]) => {
    if (!xs.length) return null;
    const v = [...xs].sort((x, y) => x - y);
    return v[Math.floor(v.length / 2)];
  };

  return {
    room: room.id,
    name: room.name,
    minutes: {
      today: store.heatingMinutes(room.id, t0, now),
      yesterday: store.heatingMinutes(room.id, t0 - day, t0),
      week: store.heatingMinutes(room.id, now - 7 * day, now),
    },
    today: store.stats(room.id, t0, now),
    heatRate: median(rates.heat),
    coolRate: median(rates.cool),
    heatSamples: rates.heat.length,
  };
}
