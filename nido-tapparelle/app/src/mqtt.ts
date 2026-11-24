/** Client MQTT 3.1.1 minimale (QoS 0, retain, last will): quanto basta per il discovery di Home Assistant. */
import { connect as tcpConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export interface MqttOptions {
  host: string; port: number; username?: string; password?: string; ssl?: boolean;
  clientId: string; will?: { topic: string; payload: string; retain: boolean };
  log: (m: string) => void;
}

function encLen(n: number): number[] {
  const out: number[] = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return out;
}
const str = (s: string) => { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };

export class Mqtt {
  private sock?: Socket;
  private buf = Buffer.alloc(0);
  private ping?: NodeJS.Timeout;
  private subs: string[] = [];
  private nextId = 1;
  private stopped = false;
  connected = false;
  onMessage?: (topic: string, payload: string) => void;
  onConnect?: () => void;

  constructor(private o: MqttOptions) {}

  start() { this.stopped = false; this.open(); }
  stop() { this.stopped = true; clearInterval(this.ping); this.sock?.end(); }

  private open() {
    const sock = this.o.ssl ? tlsConnect({ host: this.o.host, port: this.o.port, rejectUnauthorized: false }) : tcpConnect(this.o.port, this.o.host);
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    sock.on(this.o.ssl ? 'secureConnect' : 'connect', () => this.sendConnect());
    sock.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    sock.on('error', e => this.o.log(`MQTT: ${e.message}`));
    sock.on('close', () => {
      clearInterval(this.ping);
      const was = this.connected;
      this.connected = false;
      if (was) this.o.log('MQTT: connessione chiusa, ritento tra 15 secondi');
      if (!this.stopped) setTimeout(() => this.open(), 15_000);
    });
  }

  private packet(type: number, flags: number, body: Buffer) {
    this.sock?.write(Buffer.concat([Buffer.from([(type << 4) | flags, ...encLen(body.length)]), body]));
  }

  private sendConnect() {
    let flags = 0x02; // clean session
    const payload = [str(this.o.clientId)];
    if (this.o.will) { flags |= 0x04 | (this.o.will.retain ? 0x20 : 0); payload.push(str(this.o.will.topic), str(this.o.will.payload)); }
    if (this.o.username) { flags |= 0x80; payload.push(str(this.o.username)); }
    if (this.o.password) { flags |= 0x40; payload.push(str(this.o.password)); }
    const head = Buffer.concat([str('MQTT'), Buffer.from([4, flags, 0, 60])]);
    this.packet(1, 0, Buffer.concat([head, ...payload]));
  }

  private parse() {
    while (this.buf.length >= 2) {
      let mul = 1, len = 0, i = 1, b: number;
      do { if (i >= this.buf.length) return; b = this.buf[i++]; len += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
      if (this.buf.length < i + len) return;
      const type = this.buf[0] >> 4, body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      if (type === 2) { // CONNACK
        if (body[1] !== 0) { this.o.log(`MQTT: connessione rifiutata (codice ${body[1]})`); this.sock?.end(); return; }
        this.connected = true;
        this.o.log(`MQTT collegato a ${this.o.host}:${this.o.port}`);
        this.ping = setInterval(() => this.packet(12, 0, Buffer.alloc(0)), 30_000);
        if (this.subs.length) this.sendSubscribe(this.subs);
        this.onConnect?.();
      } else if (type === 3) { // PUBLISH
        const tl = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + tl).toString('utf8');
        this.onMessage?.(topic, body.subarray(2 + tl).toString('utf8'));
      }
    }
  }

  private sendSubscribe(topics: string[]) {
    const id = this.nextId++ & 0xffff || 1;
    const idb = Buffer.alloc(2); idb.writeUInt16BE(id);
    this.packet(8, 2, Buffer.concat([idb, ...topics.map(t => Buffer.concat([str(t), Buffer.from([0])]))]));
  }

  subscribe(topic: string) { this.subs.push(topic); if (this.connected) this.sendSubscribe([topic]); }

  publish(topic: string, payload: string, retain = false) {
    if (!this.connected) return;
    this.packet(3, retain ? 1 : 0, Buffer.concat([str(topic), Buffer.from(payload, 'utf8')]));
  }
}
