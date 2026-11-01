import { EventEmitter } from 'node:events';
import { PB, buildFrame, parseFrame, shortTopic, TAG_RESPONSE, type Frame } from './pb.js';
import {
  MODEL_NAMES, PRODUCT_KEYS, RESULT, T, UNANSWERED, accepted, applyBaseStatus, applyDisplayMap, applyWorkingStatus,
  deriveActivity, emptyState, parseMap, pVarint1, subscriptionPayload, type RobotMap, type RobotState, type Trajectory,
} from './protocol.js';

const KEEPALIVE_MS = 15_000;
const STALE_MS = 15_000;
const RESUB_MS = 8 * 60_000;
const POLL_MS = 60_000;
const RESPONSE_TIMEOUT_MS = 5_000;
const LATE_GRACE_MS = 10_000;
const UNAWAITED_WINDOW_MS = 5_000;
const DISCOVERY_MS = 45_000;

export interface CommandResult { code: number; ok: boolean; message: string; data: PB }

interface Expected { topic: string; expires: number; resolve?: (f: Frame) => void; done: boolean }

export interface ClientOptions {
  host: string;
  port: number;
  productKey?: string;
  deviceId?: string;
  log: (msg: string) => void;
  debug?: boolean;
}

/**
 * Client del WebSocket locale del Narwal.
 * Una sola connessione per robot: con l'app Narwal aperta sul telefono il robot può rifiutare questa.
 */
export class NarwalClient extends EventEmitter {
  state: RobotState = emptyState();
  map: RobotMap | null = null;
  private ws?: WebSocket;
  private expected: Expected[] = [];
  private lock: Promise<unknown> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private lastResub = 0;
  private stopped = false;
  private retryMs = 5_000;
  private discoverResolve?: (ids: { productKey: string; deviceId: string }) => void;
  private connectedAt = 0;
  lastError?: string;

  constructor(private opts: ClientOptions) { super(); }

  get prefix() { return this.state.productKey ? `/${this.state.productKey}/${this.state.deviceId ?? ''}` : ''; }

  start() {
    this.stopped = false;
    if (this.opts.productKey) this.state.productKey = this.opts.productKey;
    if (this.opts.deviceId) this.state.deviceId = this.opts.deviceId;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    try { this.ws?.close(); } catch { /* già chiuso */ }
  }

  private clearTimers() { this.timers.forEach(t => clearInterval(t)); this.timers = []; }

  private async connect() {
    if (this.stopped) return;
    const url = `ws://${this.opts.host}:${this.opts.port}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { this.fail(`Indirizzo non valido: ${e}`); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    ws.onopen = async () => {
      opened = true;
      this.connectedAt = Date.now();
      this.state.online = true;
      this.lastError = undefined;
      this.opts.log(`Collegato al robot su ${url}`);
      try { await this.handshake(); this.retryMs = 5_000; }
      catch (e) { this.opts.log(`Collegamento non completato: ${e instanceof Error ? e.message : e}`); try { ws.close(); } catch { /* */ } }
    };
    ws.onmessage = ev => {
      const data = ev.data instanceof ArrayBuffer ? Buffer.from(ev.data) : Buffer.isBuffer(ev.data) ? ev.data : null;
      if (data) this.onFrame(data);
      else this.opts.log(`Messaggio di testo dal robot: ${String(ev.data).slice(0, 200)}`);
    };
    ws.onerror = () => { if (!opened) this.lastError = `Il robot non risponde su ${url}`; };
    ws.onclose = ev => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.expected.forEach(e => { e.done = true; });
      this.expected = [];
      const was = this.state.online;
      this.state.online = false;
      this.state.awake = false;
      if (was) this.opts.log(`Connessione al robot chiusa${ev.reason ? ` (${ev.reason})` : ''}`);
      this.emit('state', this.state);
      if (!this.stopped) {
        // una chiusura subito dopo l'apertura di solito significa che un altro client (app Narwal) è già collegato
        if (opened && Date.now() - this.connectedAt < 3000) this.lastError = 'Il robot ha chiuso subito la connessione: forse l\'app Narwal o un\'altra integrazione è collegata';
        setTimeout(() => this.connect(), this.retryMs);
        this.retryMs = Math.min(60_000, this.retryMs * 2);
      }
    };
  }

  private fail(msg: string) {
    this.lastError = msg;
    this.opts.log(msg);
    if (!this.stopped) setTimeout(() => this.connect(), this.retryMs);
  }

  private async handshake() {
    if (!this.state.deviceId || !this.state.productKey) {
      const ids = await this.discover();
      this.state.productKey = ids.productKey;
      this.state.deviceId = ids.deviceId;
      this.opts.log(`Robot riconosciuto: ${MODEL_NAMES[ids.productKey] ?? ids.productKey}, id ${ids.deviceId}`);
      this.emit('identified', ids);
      // lascia arrivare (e scartare) le risposte agli ultimi messaggi di identificazione
      await new Promise(r => setTimeout(r, 1000));
    }
    this.state.model = MODEL_NAMES[this.state.productKey!] ?? 'Narwal';
    this.expected = [];
    await this.wakeBurst();
    this.lastResub = Date.now();
    try {
      const info = await this.command(T.DEVICE_INFO);
      const fw = info.data.str(3);
      if (fw) this.state.firmware = fw;
    } catch { /* non indispensabile */ }
    await this.refreshStatus().catch(() => undefined);
    await this.fetchMap().catch(e => this.opts.log(`Mappa non disponibile: ${e instanceof Error ? e.message : e}`));
    await this.refreshConsumables().catch(() => undefined);
    this.timers.push(setInterval(() => this.keepalive(), KEEPALIVE_MS));
    this.timers.push(setInterval(() => { if (!this.state.awake) this.refreshStatus().catch(() => undefined); }, POLL_MS));
    this.timers.push(setInterval(() => this.refreshConsumables().catch(() => undefined), 6 * 3600_000));
    this.emit('state', this.state);
  }

  /**
   * Trova product key e id del dispositivo. Un robot addormentato sulla base non risponde alla sola
   * richiesta di identificazione: per ogni product key noto si manda la stessa raffica di risveglio
   * dell'app Narwal (con id vuoto nel topic) e si legge l'id dalla risposta o dal primo broadcast.
   */
  private discover(): Promise<{ productKey: string; deviceId: string }> {
    return new Promise((resolve, reject) => {
      const keys = this.state.productKey ? [this.state.productKey, ...PRODUCT_KEYS.filter(k => k !== this.state.productKey)] : PRODUCT_KEYS;
      const id = this.state.deviceId ?? '';
      const burst = (k: string): Buffer[] => [
        buildFrame(`/${k}/${id}/${T.NOTIFY_APP}`, pVarint1(1)),
        buildFrame(`/${k}/${id}/${T.ACTIVE_PUBLISH}`, subscriptionPayload(600)),
        buildFrame(`/${k}/${id}/${T.ACTIVE_PUBLISH}`, pVarint1(600)),
        buildFrame(`/${k}/${id}/${T.HEARTBEAT}`, pVarint1(1)),
        buildFrame(`/${k}/${id}/${T.DEVICE_INFO}`),
        buildFrame(`/${k}/${id}/${T.GET_BASE_STATUS}`),
      ];
      const queue: Buffer[] = [];
      let round = 0;
      const refill = () => { for (const k of keys) queue.push(...burst(k)); queue.push(buildFrame(`//${T.DEVICE_INFO}`)); round++; };
      const tick = setInterval(() => {
        if (!queue.length) { if (round >= 3) return; refill(); }
        const f = queue.shift()!;
        try { this.ws?.send(new Uint8Array(f)); } catch { /* chiusura gestita altrove */ }
      }, 150);
      this.discoverStats = { frames: 0, logged: 0 };
      const timeout = setTimeout(() => {
        clearInterval(tick); this.discoverResolve = undefined;
        const n = this.discoverStats.frames;
        reject(new Error(n
          ? `il robot ha mandato ${n} messaggi ma nessuno con il suo identificativo (dettagli nel registro): indica device_id e product_key nella configurazione`
          : 'nessuna risposta dal robot: probabilmente dorme sulla base. Apri per un attimo l\'app Narwal sul telefono (poi chiudila) o premi un tasto del robot; in alternativa indica device_id e product_key nella configurazione'));
      }, DISCOVERY_MS);
      this.discoverResolve = ids => { clearInterval(tick); clearTimeout(timeout); this.discoverResolve = undefined; resolve(ids); };
    });
  }
  private discoverStats = { frames: 0, logged: 0 };

  private onFrame(data: Buffer) {
    const f = parseFrame(data);
    if (!f) { if (this.opts.debug || this.discoverResolve) this.opts.log(`Messaggio non riconosciuto dal robot: ${data.subarray(0, 60).toString('hex')}`); return; }
    if (this.discoverResolve) {
      this.discoverStats.frames++;
      if (this.discoverStats.logged < 6 || this.opts.debug) {
        this.discoverStats.logged++;
        this.opts.log(`Identificazione, ricevuto: tag 0x${f.tag.toString(16)} topic "${f.topic}" ${JSON.stringify(PB.tryDecode(f.payload)?.toJSON() ?? f.payload.toString('hex').slice(0, 120)).slice(0, 300)}`);
      }
      if (f.tag === TAG_RESPONSE) {
        const pb = PB.tryDecode(f.payload);
        const pk = pb?.str(1)?.trim(), id = pb?.str(2)?.trim();
        if (id && /^[\w.-]+$/.test(id)) { this.discoverResolve({ productKey: pk && /^\w+$/.test(pk) ? pk : (this.state.productKey ?? PRODUCT_KEYS[0]), deviceId: id }); return; }
      } else {
        const parts = f.topic.split('/');
        if (parts.length >= 4 && parts[1] && parts[2]) { this.discoverResolve({ productKey: parts[1], deviceId: parts[2] }); }
      }
      return;
    }
    if (f.tag === TAG_RESPONSE) { this.routeResponse(f); return; }
    this.onBroadcast(f);
  }

  private routeResponse(f: Frame) {
    const now = Date.now();
    while (this.expected.length) {
      const e = this.expected.shift()!;
      if (e.expires < now) continue;
      if (!e.resolve || e.done) return; // conferma di un comando senza attesa, o risposta tardiva
      e.done = true;
      e.resolve(f);
      return;
    }
  }

  private onBroadcast(f: Frame) {
    const now = Date.now();
    const wasAwake = this.state.awake;
    this.state.lastBroadcast = now;
    this.state.awake = true;
    const topic = shortTopic(f.topic);
    const pb = PB.tryDecode(f.payload);
    if (!pb) return;
    if (this.opts.debug) this.opts.log(`← ${topic} ${JSON.stringify(pb.toJSON()).slice(0, 400)}`);
    switch (topic) {
      case T.BASE_STATUS: applyBaseStatus(this.state, pb, now); break;
      case T.WORKING_STATUS: applyWorkingStatus(this.state, pb); break;
      case T.DISPLAY_MAP: {
        const tr: Trajectory | null = applyDisplayMap(this.state, pb, now);
        if (tr) this.emit('trajectory', tr);
        break;
      }
      case T.UPGRADE_STATUS: { const st = pb.int(2); this.state.upgrading = st != null && st > 0 && st < 100; break; }
      case T.CLEAN_REPORT: this.emit('report', pb); break;
      default: break;
    }
    this.emit('broadcast', topic, pb);
    if (!wasAwake || topic === T.BASE_STATUS || topic === T.WORKING_STATUS) this.emit('state', this.state);
  }

  private send(topic: string, payload: Buffer, expected?: Expected) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.prefix) throw new Error('robot non collegato');
    if (expected) this.expected.push(expected);
    try { this.ws.send(new Uint8Array(buildFrame(`${this.prefix}/${topic}`, payload))); }
    catch (e) { if (expected) this.expected = this.expected.filter(x => x !== expected); throw e; }
  }

  /** Invio senza attendere la risposta; la conferma, se arriva, viene scartata nel giusto ordine. */
  sendUnawaited(topic: string, payload: Buffer = Buffer.alloc(0)) {
    this.send(topic, payload, UNANSWERED.has(topic) ? undefined : { topic, expires: Date.now() + UNAWAITED_WINDOW_MS, done: false });
    if (topic === T.ACTIVE_PUBLISH) this.lastResub = Date.now();
  }

  /** Comando con attesa della risposta. Le risposte non dicono a chi appartengono: si serializza. */
  command(topic: string, payload: Buffer = Buffer.alloc(0), timeoutMs = RESPONSE_TIMEOUT_MS): Promise<CommandResult> {
    const run = async (): Promise<CommandResult> => {
      const frame = await new Promise<Frame>((resolve, reject) => {
        const e: Expected = { topic, expires: Date.now() + timeoutMs + LATE_GRACE_MS, done: false, resolve };
        try { this.send(topic, payload, e); } catch (err) { reject(err); return; }
        setTimeout(() => { if (!e.done) { e.done = true; reject(new Error(`nessuna risposta a ${topic} entro ${timeoutMs / 1000} s`)); } }, timeoutMs);
      });
      const data = PB.tryDecode(frame.payload) ?? PB.empty();
      const f1 = data.first(1);
      const code = typeof f1 === 'number' ? f1 : 1; // campo 1 non intero = risposta con dati = successo
      return { code, ok: accepted(code), message: RESULT[code] ?? `Codice ${code}`, data };
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }

  async wakeBurst() {
    const cmds: [string, Buffer][] = [
      [T.NOTIFY_APP, pVarint1(1)],
      [T.ACTIVE_PUBLISH, subscriptionPayload(600)],
      [T.ACTIVE_PUBLISH, pVarint1(600)],
      [T.HEARTBEAT, pVarint1(1)],
      [T.GET_BASE_STATUS, Buffer.alloc(0)],
    ];
    for (const [t, p] of cmds) {
      try { this.sendUnawaited(t, p); } catch { return; }
      await new Promise(r => setTimeout(r, 200));
    }
  }

  /** Prima di un comando: se il robot dorme lo sveglia e aspetta qualche secondo un segno di vita. */
  async ensureAwake(maxMs = 8000) {
    if (this.state.awake) return;
    await this.wakeBurst();
    const until = Date.now() + maxMs;
    while (!this.state.awake && Date.now() < until) await new Promise(r => setTimeout(r, 300));
  }

  private keepalive() {
    if (!this.state.online) return;
    const now = Date.now();
    if (this.state.awake && this.state.lastBroadcast && now - this.state.lastBroadcast > STALE_MS) {
      this.state.awake = false;
      this.emit('state', this.state);
    }
    try {
      if (now - this.lastResub > RESUB_MS) this.sendUnawaited(T.ACTIVE_PUBLISH, subscriptionPayload(600));
      // il battito dell'app azzera il timeout di inattività (60 s) senza svegliare un robot sulla base
      if (this.state.awake || this.state.docked) this.sendUnawaited(T.HEARTBEAT, pVarint1(1));
      else void this.wakeBurst();
    } catch { /* la chiusura verrà gestita da onclose */ }
  }

  async refreshStatus() {
    const r = await this.command(T.GET_BASE_STATUS);
    const pb = r.data.msg(2);
    if (!pb) return;
    if (this.state.workingStatus == null || this.state.awake) applyBaseStatus(this.state, pb);
    else {
      // robot addormentato: lo stato di lavoro nella risposta può essere quello dell'ultima sessione, si aggiorna solo la batteria
      const bat = pb.float(2);
      if (bat != null && Number.isFinite(bat) && bat >= 0 && bat <= 100.5) this.state.battery = Math.round(Math.min(100, bat));
      this.state.lastBaseStatus = Date.now();
      deriveActivity(this.state);
    }
    this.emit('state', this.state);
  }

  async refreshConsumables() {
    const r = await this.command(T.CONSUMABLES);
    const p = r.data.msg(1);
    this.state.maintainItems = p?.ints(1).filter(Boolean) ?? [];
    this.state.replaceItems = p?.ints(2).filter(Boolean) ?? [];
  }

  async fetchMap(): Promise<RobotMap | null> {
    await this.ensureAwake(4000);
    const r = await this.command(T.GET_MAP, Buffer.alloc(0), 15_000);
    const map = parseMap(r.data);
    if (map) {
      this.map = map;
      this.emit('map', map);
      this.opts.log(`Mappa caricata: ${map.rooms.length} stanze (${map.rooms.map(x => x.name).join(', ')})`);
    }
    return map;
  }
}
