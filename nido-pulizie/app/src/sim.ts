/**
 * Narwal simulato: un server WebSocket che parla lo stesso protocollo del robot (porta 9002),
 * usato in modalità demo e per provare il client senza il robot vero.
 * Riproduce i comportamenti noti: una sola connessione, chiusura dopo 60 s senza comandi,
 * broadcast solo dopo l'iscrizione, start_clean solo dalla base, risposte senza topic in ordine.
 */
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { PB, W, buildFrame, parseFrame, shortTopic, TAG_RESPONSE } from './pb.js';
import { T } from './protocol.js';

const PK = 'QxMSPG6VSO';
const DEVICE = 'sim-flow2-0001';
const FW = 'v01.09.10.02';
const W_PX = 130, H_PX = 96, RES = 60; // 60 mm per pixel → 7,8 × 5,8 m
const ORIGIN_X = 40, ORIGIN_Y = 25;

interface SimRoom { id: number; type: number; name: string; x0: number; y0: number; x1: number; y1: number }
const ROOMS: SimRoom[] = [
  { id: 1, type: 3, name: 'Soggiorno', x0: 2, y0: 2, x1: 62, y1: 50 },
  { id: 2, type: 4, name: 'Cucina', x0: 64, y0: 2, x1: 100, y1: 40 },
  { id: 3, type: 10, name: '', x0: 64, y0: 42, x1: 127, y1: 54 },          // Corridoio (nome dal tipo)
  { id: 4, type: 1, name: 'Camera da letto', x0: 2, y0: 52, x1: 62, y1: 93 },
  { id: 5, type: 12, name: 'Cameretta', x0: 64, y0: 56, x1: 100, y1: 93 },
  { id: 6, type: 5, name: 'Bagno', x0: 102, y0: 56, x1: 127, y1: 93 },
  { id: 7, type: 9, name: '', x0: 102, y0: 2, x1: 127, y1: 40 },           // Cabina armadio
];
const DOCK = { x: 30, y: 4 }; // pixel

function buildGrid(): number[] {
  const g = new Array(W_PX * H_PX).fill(0);
  for (const r of ROOMS) for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    const edge = x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1;
    g[y * W_PX + x] = (r.id << 8) | (edge ? 0x11 : 0x01);
  }
  // porte: tolgono il bordo in alcuni punti
  const door = (x: number, y: number, dx: number, dy: number, n: number) => { for (let i = 0; i < n; i++) { const xx = x + dx * i, yy = y + dy * i; const v = g[yy * W_PX + xx]; if (v) g[yy * W_PX + xx] = v & ~0x10; } };
  door(62, 20, 0, 1, 8); door(63, 20, 0, 1, 8); door(80, 40, 1, 0, 8); door(80, 41, 1, 0, 8);
  // alcuni mobili come ostacoli non assegnati
  for (let y = 20; y < 30; y++) for (let x = 15; x < 35; x++) g[y * W_PX + x] = 0x28;
  for (let y = 70; y < 85; y++) for (let x = 15; x < 40; x++) g[y * W_PX + x] = 0x28;
  return g;
}

function mapPayload(): Buffer {
  const grid = buildGrid();
  const packed = new W().packed(1, grid).finish();
  const m = new W()
    .varint(1, 1730000000).varint(3, RES).varint(4, W_PX).varint(5, H_PX)
    .msg(6, new W().varint(1, ORIGIN_Y).varint(2, 0).varint(3, ORIGIN_X).varint(4, RES))
    .msg(8, new W().msg(1, new W().f32(1, DOCK.x + ORIGIN_X).f32(2, DOCK.y + ORIGIN_Y)).f32(2, Math.PI / 2));
  ROOMS.forEach((r, i) => m.msg(12, new W().varint(1, r.id).varint(2, r.type).str(3, r.name).varint(4, 1).varint(8, 1 + (i === 99 ? 1 : 0))));
  m.bytes(17, deflateSync(packed)).varint(33, 48);
  return new W().varint(1, 1).msg(2, m).finish();
}

// ── WebSocket minimale lato server ─────────────────────────────────────────────

class WsConn {
  private buf = Buffer.alloc(0);
  closed = false;
  onBinary?: (b: Buffer) => void;
  onClose?: () => void;
  constructor(private sock: Duplex) {
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('close', () => { if (!this.closed) { this.closed = true; this.onClose?.(); } });
    sock.on('error', () => undefined);
  }
  private parse() {
    while (this.buf.length >= 2) {
      const op = this.buf[0] & 0x0f, masked = !!(this.buf[1] & 0x80);
      let len = this.buf[1] & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (this.buf.length < need) return;
      let payload = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) { const mask = this.buf.subarray(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4])); }
      this.buf = this.buf.subarray(need);
      if (op === 2) this.onBinary?.(payload);
      else if (op === 8) { this.close(1000, ''); }
      else if (op === 9) this.write(0x0a, payload);
    }
  }
  private write(op: number, payload: Buffer) {
    if (this.closed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h; })();
    this.sock.write(Buffer.concat([head, payload]));
  }
  send(b: Buffer) { this.write(2, b); }
  close(code: number, reason: string) {
    if (this.closed) return;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason)); p.writeUInt16BE(code); p.write(reason, 2);
    this.write(8, p);
    this.closed = true;
    this.sock.end();
    this.onClose?.();
  }
}

// ── Robot ──────────────────────────────────────────────────────────────────────

interface Plan { rooms: { id: number; mode: number; fan: number }[]; pts: { x: number; y: number; room: number }[]; idx: number }

export class SimRobot {
  private server?: Server;
  private conn?: WsConn;
  private lastCmd = 0;
  private subscribedUntil = 0;
  private awakeUntil = 0;
  battery = 78;
  ws = 10;              // working status
  paused = false;
  returning = false;
  fan = 2; water = 2;
  x = DOCK.x; y = DOCK.y + 3; heading = Math.PI / 2;
  private plan?: Plan;
  private covered = new Set<number>();
  private elapsed = 0;
  private startedAt = 0;
  private trail: { x: number; y: number }[] = [];
  private tick?: NodeJS.Timeout;
  private bcast?: NodeJS.Timeout;
  private homePath: { x: number; y: number }[] = [];

  constructor(private speed = Number(process.env.SIM_SPEED ?? 6), private log: (m: string) => void = () => undefined) {}

  listen(port: number): Promise<void> {
    this.server = createServer((_q, r) => { r.writeHead(426); r.end(); });
    this.server.on('upgrade', (req, sock) => {
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string') { sock.destroy(); return; }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const c = new WsConn(sock);
      if (this.conn && !this.conn.closed) { c.close(1008, 'Another client connected'); return; } // una sola connessione
      this.conn = c;
      this.lastCmd = Date.now();
      c.onBinary = b => this.onFrame(b);
      c.onClose = () => { if (this.conn === c) this.conn = undefined; };
    });
    this.tick = setInterval(() => this.step(0.5), 500);
    this.bcast = setInterval(() => this.broadcast(), 1500);
    return new Promise(res => this.server!.listen(port, '127.0.0.1', () => res()));
  }

  close() { clearInterval(this.tick); clearInterval(this.bcast); this.conn?.close(1001, ''); this.server?.close(); }

  private reply(payload: Buffer) { this.conn?.send(buildFrame('', payload, TAG_RESPONSE)); }
  private ok(code = 1) { this.reply(new W().varint(1, code).finish()); }

  private onFrame(b: Buffer) {
    const f = parseFrame(b);
    if (!f || !this.conn) return;
    // byte di intestazione sbagliato → il robot vero chiude la connessione
    if (b[1] !== Buffer.byteLength(f.topic) + 2) { this.conn.close(1002, 'bad header'); return; }
    const parts = f.topic.split('/');
    const topic = shortTopic(f.topic);
    this.lastCmd = Date.now();
    if (topic === T.DEVICE_INFO) {
      if (parts[1] === PK || parts[1] === '') this.reply(new W().str(1, PK).str(2, DEVICE).str(3, FW).finish());
      return; // prefisso sbagliato: il robot ignora
    }
    if (parts[1] !== PK || parts[2] !== DEVICE) return;
    const pb = PB.tryDecode(f.payload) ?? PB.empty();
    switch (topic) {
      case T.HEARTBEAT: return; // mai risposto
      case T.NOTIFY_APP: this.awakeUntil = Date.now() + 45_000; return this.ok();
      case T.ACTIVE_PUBLISH: {
        const dur = pb.msgs(1).length ? (pb.msgs(1)[0].int(2) ?? 600) : (pb.int(1) ?? 600);
        this.subscribedUntil = Date.now() + dur * 1000;
        this.awakeUntil = Math.max(this.awakeUntil, Date.now() + 30_000);
        return this.ok();
      }
      case T.GET_BASE_STATUS: return this.reply(new W().varint(1, 1).msg(2, this.baseStatus()).finish());
      case T.GET_MAP: return this.reply(mapPayload());
      case T.CONSUMABLES: return this.reply(new W().msg(1, new W()).finish());
      case T.YELL: this.log('«Sono qui!»'); return this.ok();
      case T.SET_FAN: this.fan = pb.int(1) ?? this.fan; return this.ok();
      case T.SET_MOP: this.water = pb.int(1) ?? this.water; return this.ok();
      case T.PAUSE: if (!this.plan) return this.ok(2); this.paused = true; return this.ok();
      case T.RESUME: if (!this.plan || !this.paused) return this.ok(2); this.paused = false; return this.ok();
      case T.FORCE_END: case T.RECALL:
        if (this.isDocked()) return this.ok(2);
        this.goHome(); return this.ok();
      case T.WASH_MOP: case T.DRY_MOP: case T.DUST_GATHERING: return this.ok(this.isDocked() ? 1 : 2);
      case T.START_CLEAN: {
        if (!this.isDocked()) return this.ok(4);
        const task = pb.msg(1);
        const items = task?.msgs(2) ?? [];
        const rooms = items.map(it => ({ id: it.path(1)?.int(2) ?? 0, mode: it.msg(2)?.int(1) ?? 4, fan: it.msg(2)?.int(2) ?? 2 })).filter(r => ROOMS.some(x => x.id === r.id));
        if (!rooms.length || task?.int(1) !== 1730000000) return this.ok(2);
        this.startPlan(rooms, task?.int(5) === 6 ? 17 : 4);
        return this.reply(new W().bytes(1, task!.raw).finish()); // il robot risponde con l'eco della configurazione
      }
      case T.PLAN_START: case T.EASY_CLEAN:
        if (!this.isDocked()) return this.ok(4);
        this.startPlan(ROOMS.map(r => ({ id: r.id, mode: 4, fan: this.fan })), 4);
        return this.ok();
      default: return this.ok(2);
    }
  }

  private isDocked() { return !this.plan && this.homePath.length === 0; }

  private startPlan(rooms: Plan['rooms'], ws: number) {
    const pts: Plan['pts'] = [];
    for (const r of rooms) {
      const room = ROOMS.find(x => x.id === r.id)!;
      let dir = 1;
      for (let y = room.y0 + 3; y <= room.y1 - 3; y += 5) {
        const a = room.x0 + 3, b = room.x1 - 3;
        pts.push({ x: dir > 0 ? a : b, y, room: r.id }, { x: dir > 0 ? b : a, y, room: r.id });
        dir = -dir;
      }
    }
    this.plan = { rooms, pts, idx: 0 };
    this.covered.clear(); this.elapsed = 0; this.startedAt = Date.now(); this.trail = [];
    this.ws = ws; this.paused = false; this.returning = false;
    this.log(`Simulatore: pulizia di ${rooms.length} stanze`);
  }

  private goHome() {
    this.plan = undefined;
    this.returning = true;
    this.homePath = [{ x: this.x, y: DOCK.y + 10 }, { x: DOCK.x, y: DOCK.y + 10 }, { x: DOCK.x, y: DOCK.y + 3 }];
  }

  private step(dt: number) {
    const sdt = dt * this.speed;
    const now = Date.now();
    if (this.plan && !this.paused) {
      this.elapsed += sdt;
      this.battery = Math.max(5, this.battery - 0.025 * sdt);
      this.moveTowards(this.plan.pts, sdt, () => { this.plan!.idx++; });
      if (this.plan && this.plan.idx >= this.plan.pts.length) { this.sendReport('Pulizia completata'); this.goHome(); }
      else if (this.battery < 12) { this.sendReport('Batteria scarica'); this.goHome(); }
    } else if (this.homePath.length) {
      this.moveTowards(this.homePath, sdt, () => { this.homePath.shift(); });
      if (!this.homePath.length) { this.returning = false; this.ws = 10; this.heading = -Math.PI / 2; }
    } else if (this.isDocked()) {
      this.battery = Math.min(100, this.battery + 0.05 * sdt);
      this.ws = this.battery >= 100 ? 14 : 10;
    }
    // il robot chiude il socket dopo 60 s senza comandi
    if (this.conn && now - this.lastCmd > 60_000) this.conn.close(1000, 'Idle timeout');
  }

  private moveTowards(path: { x: number; y: number }[], sdt: number, arrived: () => void) {
    let budget = 5 * sdt; // 5 px/s ≈ 0,3 m/s
    let guard = 0;
    while (budget > 0 && guard++ < 50) {
      const target = this.plan ? this.plan.pts[this.plan.idx] : path[0];
      if (!target) return;
      const dx = target.x - this.x, dy = target.y - this.y, d = Math.hypot(dx, dy);
      if (d < 0.01) { arrived(); continue; }
      const s = Math.min(d, budget);
      this.heading = Math.atan2(dy, dx);
      this.x += (dx / d) * s; this.y += (dy / d) * s;
      budget -= s;
      if (this.plan) for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) this.covered.add(Math.round(this.y + oy) * W_PX + Math.round(this.x + ox));
      if (s >= d) arrived();
    }
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 30) this.trail.splice(0, this.trail.length - 30);
  }

  private currentRoom(): number {
    if (!this.plan) return 0;
    return this.plan.pts[Math.min(this.plan.idx, this.plan.pts.length - 1)]?.room ?? 0;
  }

  private area() { return Math.round(this.covered.size * (RES / 1000) ** 2 * 10) / 10; }

  private baseStatus(): W {
    const cleaning = !!this.plan || this.homePath.length > 0;
    const f3 = new W().varint(1, this.ws);
    if (this.paused) f3.varint(2, 1);
    f3.varint(3, cleaning ? 0 : 1);
    if (this.ws === 2) f3.varint(4, 1);
    if (this.returning) f3.varint(7, 1);
    f3.varint(10, cleaning ? (this.returning ? 2 : 0) : 1);
    return new W().f32(2, this.battery).msg(3, f3).varint(11, cleaning ? 1 : 3).varint(20, 1).varint(23, 1).varint(24, 1).varint(26, this.fan).varint(29, this.water).varint(47, cleaning ? 0 : 1);
  }

  private bframe(topic: string, w: W) { this.conn?.send(buildFrame(`/${PK}/${DEVICE}/${topic}`, w.finish())); }

  private broadcast() {
    const now = Date.now();
    const active = !!this.plan || this.homePath.length > 0;
    if (!this.conn || now > this.subscribedUntil || (!active && now > this.awakeUntil)) return;
    this.bframe(T.BASE_STATUS, this.baseStatus());
    if (this.plan) {
      const total = this.plan.pts.length || 1;
      this.bframe(T.WORKING_STATUS, new W().f32(1, this.plan.idx / total).f32(2, this.area()).varint(3, Math.round(this.elapsed)).varint(4, Math.round((total - this.plan.idx) * 6)).varint(6, this.currentRoom()));
    }
    if (active) {
      this.bframe(T.DISPLAY_MAP, new W()
        .msg(1, new W().msg(1, new W().f32(1, this.x + ORIGIN_X).f32(2, this.y + ORIGIN_Y)).f32(2, this.heading))
        .msg(2, new W().packedF32(1, this.trail.map(p => p.x + ORIGIN_X)).packedF32(2, this.trail.map(p => p.y + ORIGIN_Y)))
        .msg(5, new W().msg(1, new W().f32(1, DOCK.x + ORIGIN_X).f32(2, DOCK.y + ORIGIN_Y)))
        .varint(10, now));
    }
  }

  private sendReport(reason: string) {
    if (!this.conn) return;
    const start = Math.round(this.startedAt / 1000);
    this.bframe(T.CLEAN_REPORT, new W().varint(3, Math.round(this.elapsed)).varint(6, start).varint(7, start + Math.round(this.elapsed)).f32(8, this.area()).str(33, reason));
  }
}

/** Avvio autonomo: `node dist/sim.js 9002` per avere un finto robot in rete locale. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 9002);
  new SimRobot(Number(process.env.SIM_SPEED ?? 6), m => console.log(m)).listen(port).then(() => console.log(`Narwal simulato su ws://127.0.0.1:${port}`));
}
