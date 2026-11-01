import { inflateSync } from 'node:zlib';
import { PB, W, packedFloats, packedVarints } from './pb.js';

/** Product key noti che rispondono sul WebSocket locale (porta 9002). Prima quelli del Flow 2. */
export const PRODUCT_KEYS = [
  'QxMSPG6VSO', 'iSuVlI1If2', 'mkbqaprvrb', // Flow 2
  'QoEsI5qYXO', // Flow (AX12)
  'DrzDKQ0MU8', 'qV6BujoYLz', 'hEA7OEshlx', 'fjhpiem4ba', 'ulonq49mm1', 'BYWBPqSxeC', 'CGjuB6dzq7',
];

export const MODEL_NAMES: Record<string, string> = {
  QxMSPG6VSO: 'Narwal Flow 2', iSuVlI1If2: 'Narwal Flow 2', mkbqaprvrb: 'Narwal Flow 2', QoEsI5qYXO: 'Narwal Flow',
  DrzDKQ0MU8: 'Narwal Freo Z10 Ultra', qV6BujoYLz: 'Narwal Freo Z10 Pro', hEA7OEshlx: 'Narwal Freo Z Ultra',
  fjhpiem4ba: 'Narwal Freo 20', ulonq49mm1: 'Narwal Freo 20 Edge', CGjuB6dzq7: 'Narwal JX',
};

export const T = {
  // broadcast
  BASE_STATUS: 'status/robot_base_status',
  WORKING_STATUS: 'status/working_status',
  DISPLAY_MAP: 'map/display_map',
  UPGRADE_STATUS: 'upgrade/upgrade_status',
  DOWNLOAD_STATUS: 'status/download_status',
  TIMELINE: 'status/time_line_status',
  CLEAN_REPORT: 'report/clean_report',
  // comandi
  DEVICE_INFO: 'common/get_device_info',
  GET_BASE_STATUS: 'status/get_device_base_status',
  ACTIVE_PUBLISH: 'common/active_robot_publish',
  NOTIFY_APP: 'common/notify_app_event',
  HEARTBEAT: 'status/app_status_heartbeat',
  YELL: 'common/yell',
  PAUSE: 'task/pause',
  RESUME: 'task/resume',
  FORCE_END: 'task/force_end',
  RECALL: 'supply/recall',
  WASH_MOP: 'supply/wash_mop',
  DRY_MOP: 'supply/dry_mop',
  DUST_GATHERING: 'supply/dust_gathering',
  START_CLEAN: 'clean/start_clean',
  PLAN_START: 'clean/plan/start',
  EASY_CLEAN: 'clean/easy_clean/start',
  SET_FAN: 'clean/set_fan_level',
  SET_MOP: 'clean/set_mop_humidity',
  GET_MAP: 'map/get_map',
  CONSUMABLES: 'consumable/get_consumable_info',
} as const;

export const SUBSCRIBED_TOPICS = [T.BASE_STATUS, T.WORKING_STATUS, T.UPGRADE_STATUS, T.DOWNLOAD_STATUS, T.DISPLAY_MAP, T.TIMELINE];

/** Comandi a cui il robot non risponde mai: non devono occupare un posto nella coda delle risposte. */
export const UNANSWERED = new Set<string>([T.HEARTBEAT]);

export const RESULT: Record<number, string> = {
  1: 'Eseguito', 2: 'Non applicabile in questo stato', 3: 'In conflitto con un\'attività in corso',
  4: 'Robot non pronto (deve essere sulla base)', 6: 'Applicato',
};
export const accepted = (code: number) => code === 1 || code === 6;

export const FAN = { 1: 'Silenzioso', 2: 'Normale', 3: 'Forte', 4: 'Profondo', 5: 'Super' } as Record<number, string>;
export const WATER = { 1: 'Poca', 2: 'Normale', 3: 'Molta' } as Record<number, string>;
export const MOP_STRENGTH = { 1: 'Normale', 2: 'Intensa' } as Record<number, string>;
export const ROUTE = { 1: 'Standard', 2: 'Accurato' } as Record<number, string>;
export const WORK_MODE = { 1: 'Aspira', 2: 'Lava', 3: 'Aspira poi lava', 4: 'Aspira e lava' } as Record<number, string>;

export const ROOM_TYPE: Record<number, string> = {
  0: 'Stanza', 1: 'Camera matrimoniale', 2: 'Camera', 3: 'Soggiorno', 4: 'Cucina', 5: 'Bagno', 6: 'Bagno di servizio',
  7: 'Balcone', 8: 'Sala da pranzo', 9: 'Cabina armadio', 10: 'Corridoio', 11: 'Studio', 12: 'Cameretta',
  13: 'Sala giochi', 14: 'Ripostiglio', 15: 'Altro',
};

// ── Payload dei comandi ────────────────────────────────────────────────────────

export const pVarint1 = (n: number) => new W().varint(1, n).finish();

export function subscriptionPayload(duration = 600): Buffer {
  const w = new W();
  for (const t of SUBSCRIBED_TOPICS) w.msg(1, new W().str(1, t).varint(2, duration));
  return w.finish();
}

export interface CleanSettings {
  mode: number;       // WORK_MODE
  fan: number;        // FAN
  water: number;      // WATER
  strength: number;   // MOP_STRENGTH
  passes: number;     // 1..3
  route?: number;     // ROUTE
}

export const DEFAULT_CLEAN: CleanSettings = { mode: 4, fan: 2, water: 2, strength: 1, passes: 1, route: 1 };

// CleanParam: 1 modo, 2 aspirazione, 3 intensità lavaggio, 4 acqua, 5/6/7 passaggi, 8 percorso
const MODE_PARAM: Record<number, [number, number[]]> = { 1: [2, [5]], 2: [3, [6]], 3: [5, [5, 6]], 4: [4, [7]] };

export function sanitizeClean(s: Partial<CleanSettings> | undefined): CleanSettings {
  const c = { ...DEFAULT_CLEAN, ...(s ?? {}) };
  const pick = (v: unknown, table: Record<number, string>, d: number) => (Number(v) in table ? Number(v) : d);
  return {
    mode: pick(c.mode, WORK_MODE, 4), fan: pick(c.fan, FAN, 2), water: pick(c.water, WATER, 2),
    strength: pick(c.strength, MOP_STRENGTH, 1), passes: Math.min(3, Math.max(1, Math.round(Number(c.passes) || 1))),
    route: c.route == null ? undefined : pick(c.route, ROUTE, 1),
  };
}

function cleanParam(s: CleanSettings): W {
  const [mode, passTags] = MODE_PARAM[s.mode] ?? MODE_PARAM[4];
  const w = new W().varint(1, mode).varint(2, s.fan).varint(3, s.strength).varint(4, s.water);
  // l'ordine dei tag deve essere crescente come nell'app
  const tags = new Map<number, number>();
  for (const t of passTags) tags.set(t, s.passes);
  if (s.route != null) tags.set(8, s.route);
  [...tags.keys()].sort((a, b) => a - b).forEach(t => w.varint(t, tags.get(t)!));
  return w;
}

/**
 * clean/start_clean: StartClean{1: CleanTask{1: map_id, 2: [CleanItem], 3: TaskOption{}, 5: taskType}}
 * CleanItem{1: ZoneOption{1: 1 (stanza), 2: room_id}, 2: CleanParam, 3: ordine}
 */
export function startCleanPayload(mapId: number, rooms: { id: number; settings: CleanSettings }[]): Buffer {
  const task = new W().varint(1, mapId);
  rooms.forEach((r, i) => task.msg(2, new W().msg(1, new W().varint(1, 1).varint(2, r.id)).msg(2, cleanParam(r.settings)).varint(3, i + 1)));
  task.msg(3, new W());
  const modes = new Set(rooms.map(r => r.settings.mode));
  task.varint(5, modes.size === 1 ? [...modes][0] : 6);
  return new W().msg(1, task).finish();
}

// ── Stato del robot ────────────────────────────────────────────────────────────

export type Activity = 'pulizia' | 'pausa' | 'rientro' | 'in_carica' | 'carico' | 'base' | 'fermo' | 'mappatura' | 'errore' | 'sconosciuto';

export const ACTIVITY_LABEL: Record<Activity, string> = {
  pulizia: 'Sta pulendo', pausa: 'In pausa', rientro: 'Torna alla base', in_carica: 'In carica',
  carico: 'Sulla base · carico', base: 'Sulla base', fermo: 'Fermo fuori dalla base', mappatura: 'Sta mappando',
  errore: 'Errore', sconosciuto: 'In attesa di dati',
};

const CLEANING_STATUSES = new Set([3, 4, 5, 17, 19]);

export interface RobotState {
  online: boolean;           // WebSocket aperto
  awake: boolean;            // broadcast negli ultimi 15 s
  deviceId?: string;
  productKey?: string;
  model?: string;
  firmware?: string;
  battery?: number;
  workingStatus?: number;
  taskKind?: number;         // 3.4
  paused: boolean;
  returning: boolean;
  docked: boolean;
  activity: Activity;
  label: string;
  fan?: number;
  water?: number;
  errors: number[];
  cleanWaterTank?: number;
  sewageTank?: number;
  dustBox?: number;
  charging?: number;
  progress?: number;         // 0..100
  area?: number;             // m² sessione
  elapsed?: number;          // s
  remaining?: number;        // s
  currentRoomId?: number;
  position?: { x: number; y: number; heading: number; ts: number };
  upgrading: boolean;
  lastBroadcast?: number;
  lastBaseStatus?: number;
  maintainItems: number[];
  replaceItems: number[];
}

export function emptyState(): RobotState {
  return { online: false, awake: false, paused: false, returning: false, docked: false, activity: 'sconosciuto', label: ACTIVITY_LABEL.sconosciuto, errors: [], upgrading: false, maintainItems: [], replaceItems: [] };
}

// segnali "sulla base" che cambiano tra firmware
interface DockSignals { presence?: number; sub?: number; activity?: number; f11?: number; f47?: number }

export function applyBaseStatus(s: RobotState, pb: PB, now = Date.now()) {
  s.lastBaseStatus = now;
  const bat = pb.float(2);
  if (bat != null && Number.isFinite(bat) && bat >= 0 && bat <= 100.5) s.battery = Math.round(Math.min(100, bat));
  s.errors = pb.msgs(1).map(e => e.int(1) ?? 0).filter(Boolean);
  const f3 = pb.msg(3);
  const dock: DockSignals = { f11: pb.int(11), f47: pb.int(47) };
  if (f3) {
    let ws = f3.int(1);
    s.taskKind = f3.int(4);
    if (ws === 2 && s.taskKind === 3) ws = 3; // Flow 2 v01.09.10: "2" con tipo attività 3 = sta pulendo fuori dalla base
    s.workingStatus = ws;
    s.paused = f3.int(2) === 1;
    dock.presence = f3.int(3); dock.sub = f3.int(10); dock.activity = f3.int(12);
    s.returning = f3.int(7) === 1 && (dock.sub === 2 || ws === 19);
  }
  s.fan = pb.int(26) ?? s.fan;
  s.water = pb.int(29) ?? s.water;
  s.dustBox = pb.int(20) ?? s.dustBox;
  s.cleanWaterTank = pb.int(23) ?? s.cleanWaterTank;
  s.sewageTank = pb.int(24) ?? s.sewageTank;
  s.charging = pb.int(47) ?? s.charging;

  const ws = s.workingStatus ?? 0;
  const cleaning = CLEANING_STATUSES.has(ws) || ws === 7;
  if (ws === 2 || ws === 10 || ws === 14) s.docked = true;
  else if (cleaning) s.docked = false;
  else s.docked = dock.sub === 1 || dock.presence === 1 || dock.presence === 6 || (dock.activity ?? 0) > 0 || (dock.f11 ?? 0) >= 2 || dock.f47 === 1 || dock.f47 === 3;
  deriveActivity(s);
}

export function deriveActivity(s: RobotState) {
  const ws = s.workingStatus ?? 0;
  let a: Activity;
  if (s.workingStatus == null) a = 'sconosciuto';
  else if (s.errors.length && !s.docked) a = 'errore';
  else if (ws === 7) a = 'mappatura';
  else if (CLEANING_STATUSES.has(ws)) a = s.paused ? 'pausa' : (s.returning || ws === 19) ? 'rientro' : 'pulizia';
  else if (s.docked) a = (s.battery ?? 0) >= 100 || ws === 14 ? 'carico' : ws === 10 || ws === 2 ? 'in_carica' : 'base';
  else a = 'fermo';
  s.activity = a;
  s.label = ACTIVITY_LABEL[a];
}

export function applyWorkingStatus(s: RobotState, pb: PB) {
  const p = pb.float(1);
  if (p != null && Number.isFinite(p)) s.progress = Math.round(Math.max(0, Math.min(1, p > 1 ? p / 100 : p)) * 100);
  const area = pb.float(2);
  if (area != null && Number.isFinite(area) && area >= 0 && area < 2000) s.area = Math.round(area * 10) / 10;
  const el = pb.int(3); if (el != null) s.elapsed = el;
  const rem = pb.int(4); if (rem != null) s.remaining = rem;
  const z = pb.first(6);
  if (typeof z === 'number') s.currentRoomId = z;
  else { const m = pb.msg(6) ?? pb.msg(8); const id = m?.int(1); if (id != null) s.currentRoomId = id; }
}

export interface Trajectory { xs: number[]; ys: number[] }

export function applyDisplayMap(s: RobotState, pb: PB, now = Date.now()): Trajectory | null {
  const pos = pb.path(1, 1);
  const x = pos?.float(1), y = pos?.float(2);
  const h = pb.msg(1)?.float(2);
  if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y) && !(x === 0 && y === 0))
    s.position = { x, y, heading: h != null && Number.isFinite(h) ? h : 0, ts: now };
  const tr = pb.msg(2);
  if (!tr) return null;
  const xs = packedFloats(tr.bytes(1)), ys = packedFloats(tr.bytes(2));
  const n = Math.min(xs.length, ys.length);
  const out: Trajectory = { xs: [], ys: [] };
  for (let i = 0; i < n; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { out.xs.push(xs[i]); out.ys.push(ys[i]); }
  return out.xs.length ? out : null;
}

// ── Mappa ──────────────────────────────────────────────────────────────────────

export interface MapRoom { id: number; name: string; type: number; typeName: string; category: number; cx?: number; cy?: number; pixels?: number; area?: number }

export interface RobotMap {
  id: number;
  width: number;
  height: number;
  resolution: number;     // mm per pixel
  originX: number;
  originY: number;
  rooms: MapRoom[];
  dock?: { x: number; y: number };
  /** per pixel: 0 fuori, 1 pavimento non assegnato, 2 ostacolo, 3 muro, >=10 → stanza (id = v - 10), +1000 bordo */
  grid: number[];
  area?: number;
  fetchedAt: number;
}

export function decompressGrid(buf: Buffer): Buffer {
  for (const fn of [() => inflateSync(buf), () => inflateSync(buf, { windowBits: 15 + 32 } as any)]) {
    try { return fn(); } catch { /* prova il formato successivo */ }
  }
  throw new Error('griglia della mappa non decomprimibile');
}

export function parseMap(resp: PB, now = Date.now()): RobotMap | null {
  const m = resp.msg(2);
  if (!m) return null;
  const width = m.int(4) ?? 0, height = m.int(5) ?? 0;
  if (!width || !height || width * height > 4_000_000) return null;
  const o6 = m.msg(6);
  const originX = o6?.int(3) ?? 0, originY = o6?.int(1) ?? 0;
  const rooms: MapRoom[] = m.msgs(12).map(r => {
    const type = r.int(2) ?? 0, idx = r.int(8) ?? 0;
    const name = (r.str(3) ?? '').trim();
    const typeName = ROOM_TYPE[type] ?? 'Stanza';
    return { id: r.int(1) ?? 0, name: name || (idx > 1 ? `${typeName} ${idx}` : typeName), type, typeName, category: r.int(4) ?? 0 };
  }).filter(r => r.id > 0);

  let grid: number[] = new Array(width * height).fill(0);
  const comp = m.bytes(17);
  if (comp?.length) {
    const raw = decompressGrid(comp);
    let px: number[];
    if (raw[0] === 0x0a) { const inner = PB.tryDecode(raw)?.bytes(1); px = packedVarints(inner ?? raw.subarray(1)); }
    else px = packedVarints(raw);
    const sums = new Map<number, [number, number, number]>();
    for (let i = 0; i < width * height; i++) {
      const v = px[i] ?? 0;
      let g = 0;
      if (v === 0) g = 0;
      else if (v === 0x20) g = 1;
      else if (v === 0x28) g = 2;
      else {
        const room = Math.floor(v / 256), type = v & 0xff;
        if (room === 0) g = type & 0x10 ? 3 : 1;
        else {
          g = 10 + room + (type & 0x10 ? 1000 : 0);
          if (!(type & 0x10)) { const s = sums.get(room) ?? [0, 0, 0]; s[0] += i % width; s[1] += Math.floor(i / width); s[2]++; sums.set(room, s); }
        }
      }
      grid[i] = g;
    }
    for (const r of rooms) { const s = sums.get(r.id); if (s) { r.cx = s[0] / s[2]; r.cy = s[1] / s[2]; r.pixels = s[2]; } }
  }
  let dock: RobotMap['dock'];
  const d = m.path(8, 1);
  const dx = d?.float(1), dy = d?.float(2);
  if (dx != null && dy != null && Number.isFinite(dx) && Number.isFinite(dy)) dock = { x: dx - originX, y: dy - originY };
  const resolution = m.int(3) ?? 0;
  const roomArea = (px: number) => resolution ? Math.round(px * (resolution / 1000) ** 2 * 10) / 10 : undefined;
  return {
    id: m.int(1) ?? 0, width, height, resolution, originX, originY, dock, grid, fetchedAt: now,
    area: m.int(33) ?? undefined,
    rooms: rooms.map(r => ({ ...r, area: r.pixels ? roomArea(r.pixels) : undefined })),
  };
}

/** Coordinate del robot (display_map) → pixel della griglia. */
export const toGrid = (map: RobotMap, x: number, y: number) => ({ x: x - map.originX, y: y - map.originY });

export function parseCleanReport(pb: PB) {
  return {
    elapsed: pb.int(3), start: pb.int(6), end: pb.int(7),
    reason: pb.str(33), raw: pb.toJSON(),
  };
}
