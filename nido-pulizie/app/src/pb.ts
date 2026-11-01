/**
 * Protobuf senza schema (stile "blackbox"): il robot non pubblica i .proto,
 * quindi si decodifica per numero di campo e si interpreta il contenuto quando serve.
 */

export class F32 { constructor(public readonly bits: number) {} get value() { const b = Buffer.alloc(4); b.writeUInt32LE(this.bits >>> 0); return b.readFloatLE(0); } }
export class F64 { constructor(public readonly buf: Buffer) {} get value() { return this.buf.readDoubleLE(0); } }
export type Val = number | Buffer | F32 | F64;

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0, mul = 1, b: number;
  do {
    if (pos >= buf.length) throw new Error('varint troncato');
    b = buf[pos++];
    result += (b & 0x7f) * mul;
    mul *= 128;
    if (mul > 2 ** 70) throw new Error('varint troppo lungo');
  } while (b & 0x80);
  return [result, pos];
}

/** Decodifica un messaggio; lancia un errore se i byte non sono un messaggio protobuf valido. */
export function decodeRaw(buf: Buffer): Map<number, Val[]> {
  const out = new Map<number, Val[]>();
  let pos = 0;
  while (pos < buf.length) {
    let key: number;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8), wire = key & 7;
    if (field < 1 || field > 536870911) throw new Error('campo non valido');
    let v: Val;
    if (wire === 0) { [v, pos] = readVarint(buf, pos); }
    else if (wire === 1) { if (pos + 8 > buf.length) throw new Error('fixed64 troncato'); v = new F64(buf.subarray(pos, pos + 8)); pos += 8; }
    else if (wire === 2) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) throw new Error('lunghezza oltre il messaggio');
      v = buf.subarray(pos, pos + len); pos += len;
    } else if (wire === 5) { if (pos + 4 > buf.length) throw new Error('fixed32 troncato'); v = new F32(buf.readUInt32LE(pos)); pos += 4; }
    else throw new Error(`wire type ${wire} non gestito`);
    const arr = out.get(field);
    arr ? arr.push(v) : out.set(field, [v]);
  }
  return out;
}

/** Vista comoda su un messaggio decodificato. Tutti i getter sono tolleranti: valore mancante = undefined. */
export class PB {
  constructor(public readonly fields: Map<number, Val[]>, public readonly raw: Buffer) {}

  static decode(buf: Buffer): PB { return new PB(decodeRaw(buf), buf); }
  static tryDecode(buf: Buffer | undefined): PB | undefined {
    if (!buf || !Buffer.isBuffer(buf)) return undefined;
    try { return PB.decode(buf); } catch { return undefined; }
  }
  static empty() { return new PB(new Map(), Buffer.alloc(0)); }

  has(f: number) { return this.fields.has(f); }
  all(f: number): Val[] { return this.fields.get(f) ?? []; }
  first(f: number): Val | undefined { return this.fields.get(f)?.[0]; }

  int(f: number): number | undefined {
    const v = this.first(f);
    if (typeof v === 'number') return v;
    if (v instanceof F32) return v.bits;
    return undefined;
  }
  float(f: number): number | undefined {
    const v = this.first(f);
    if (v instanceof F32) return v.value;
    if (v instanceof F64) return v.value;
    if (typeof v === 'number') return v;
    return undefined;
  }
  bytes(f: number): Buffer | undefined { const v = this.first(f); return Buffer.isBuffer(v) ? v : undefined; }
  str(f: number): string | undefined { const b = this.bytes(f); return b ? b.toString('utf8') : undefined; }
  msg(f: number): PB | undefined { return PB.tryDecode(this.bytes(f)); }
  msgs(f: number): PB[] { return this.all(f).map(v => PB.tryDecode(Buffer.isBuffer(v) ? v : undefined)).filter((m): m is PB => !!m); }
  /** Interi ripetuti, sia "packed" (un unico blocco di byte) sia ripetuti uno per uno. */
  ints(f: number): number[] {
    const res: number[] = [];
    for (const v of this.all(f)) {
      if (typeof v === 'number') res.push(v);
      else if (Buffer.isBuffer(v)) res.push(...packedVarints(v));
    }
    return res;
  }
  /** Percorso puntato, es. path(3, 1) = campo 1 del sottomessaggio 3. */
  path(...fs: number[]): PB | undefined {
    let cur: PB | undefined = this;
    for (const f of fs) { cur = cur?.msg(f); if (!cur) return undefined; }
    return cur;
  }

  /** Rappresentazione JSON leggibile, per diagnosi e per salvare i dati grezzi. */
  toJSON(depth = 0): any {
    const o: Record<string, any> = {};
    for (const [f, vals] of this.fields) {
      const conv = vals.map(v => toPlain(v, depth));
      o[f] = conv.length === 1 ? conv[0] : conv;
    }
    return o;
  }
}

function toPlain(v: Val, depth: number): any {
  if (typeof v === 'number') return v;
  if (v instanceof F32) { const x = v.value; return Number.isFinite(x) && Math.abs(x) < 1e9 ? Math.round(x * 1e4) / 1e4 : v.bits; }
  if (v instanceof F64) return v.value;
  if (v.length === 0) return '';
  if (depth < 8) {
    const sub = PB.tryDecode(v);
    if (sub && sub.fields.size) return sub.toJSON(depth + 1);
  }
  const s = v.toString('utf8');
  if (/^[\x20-\x7e -￿]*$/.test(s) && !s.includes('�')) return s;
  return v.length > 64 ? `<${v.length} byte>` : 'hex:' + v.toString('hex');
}

export function packedVarints(buf: Buffer): number[] {
  const out: number[] = [];
  let pos = 0;
  try { while (pos < buf.length) { let n: number; [n, pos] = readVarint(buf, pos); out.push(n); } } catch { /* coda troncata */ }
  return out;
}

export function packedFloats(buf: Buffer | undefined): number[] {
  if (!buf) return [];
  const out: number[] = [];
  for (let i = 0; i + 4 <= buf.length; i += 4) out.push(buf.readFloatLE(i));
  return out;
}

function varintBytes(n: number): number[] {
  if (!Number.isFinite(n) || n < 0) throw new Error(`varint non valido: ${n}`);
  n = Math.floor(n);
  const out: number[] = [];
  while (n >= 128) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}

/** Costruttore di messaggi protobuf. */
export class W {
  private parts: Buffer[] = [];
  private key(f: number, wire: number) { this.parts.push(Buffer.from(varintBytes(f * 8 + wire))); }
  varint(f: number, n: number) { this.key(f, 0); this.parts.push(Buffer.from(varintBytes(n))); return this; }
  bytes(f: number, b: Buffer) { this.key(f, 2); this.parts.push(Buffer.from(varintBytes(b.length)), b); return this; }
  str(f: number, s: string) { return this.bytes(f, Buffer.from(s, 'utf8')); }
  msg(f: number, w: W) { return this.bytes(f, w.finish()); }
  f32(f: number, x: number) { this.key(f, 5); const b = Buffer.alloc(4); b.writeFloatLE(x); this.parts.push(b); return this; }
  packed(f: number, ns: number[]) { return this.bytes(f, Buffer.from(ns.flatMap(varintBytes))); }
  packedF32(f: number, xs: number[]) { const b = Buffer.alloc(xs.length * 4); xs.forEach((x, i) => b.writeFloatLE(x, i * 4)); return this.bytes(f, b); }
  finish(): Buffer { return Buffer.concat(this.parts); }
}

// ── Frame del protocollo Narwal ────────────────────────────────────────────────
// [0x01][len(topic)+2][0x22|0x2a][len(topic)][topic][protobuf]
//  0x22 = richiesta / broadcast, 0x2a = risposta a un comando (topic vuoto)

export const TAG_REQUEST = 0x22;
export const TAG_RESPONSE = 0x2a;

export interface Frame { tag: number; topic: string; payload: Buffer }

export function buildFrame(topic: string, payload: Buffer = Buffer.alloc(0), tag = TAG_REQUEST): Buffer {
  const t = Buffer.from(topic, 'utf8');
  if (t.length > 253) throw new Error('topic troppo lungo');
  return Buffer.concat([Buffer.from([0x01, t.length + 2, tag, t.length]), t, payload]);
}

export function parseFrame(data: Buffer): Frame | null {
  if (data.length < 4 || data[0] !== 0x01) return null;
  const tag = data[2];
  if (tag !== TAG_REQUEST && tag !== TAG_RESPONSE) return null;
  const len = data[3];
  if (data.length < 4 + len) return null;
  return { tag, topic: data.subarray(4, 4 + len).toString('utf8'), payload: data.subarray(4 + len) };
}

/** '/<product_key>/<device_id>/status/working_status' → 'status/working_status' */
export function shortTopic(topic: string): string {
  const parts = topic.split('/');
  return parts.length >= 4 ? parts.slice(3).join('/') : topic;
}
