import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { DATA_DIR, DEMO, PORT, loadOptions } from './config.js';
import { Store } from './db.js';
import { MiniServer, HttpError } from './http.js';
import { NarwalClient } from './narwal.js';
import { Engine, CommandError, sessionView } from './engine.js';
import { Bridge } from './bridge.js';
import { DemoHome, HAHome, type Home } from './home.js';
import { SimRobot } from './sim.js';
import { seedDemoHistory } from './demo.js';
import { statistics } from './stats.js';
import { FAN, MOP_STRENGTH, ROUTE, WATER, WORK_MODE, type RobotMap } from './protocol.js';
import type { PB } from './pb.js';
import { sanitizeProgram } from './programs.js';

export const VERSION = '0.1.0';
const here = dirname(fileURLToPath(import.meta.url));
const opts = loadOptions();
const store = new Store(DATA_DIR);
const logLines: { ts: number; msg: string }[] = [];
const log = (msg: string) => {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] ${msg}`);
  logLines.push({ ts: Date.now(), msg });
  if (logLines.length > 300) logLines.shift();
};

log(`NIDO Pulizie ${VERSION}${DEMO ? ' · modalità demo con robot simulato' : ''}`);

let host = opts.indirizzo_ip, port = opts.porta;
let sim: SimRobot | undefined;
if (DEMO) {
  sim = new SimRobot(Number(process.env.SIM_SPEED ?? 6), m => log(m));
  port = 19002; host = '127.0.0.1';
  await sim.listen(port);
}

const saved = store.getSetting<{ productKey: string; deviceId: string }>('robot_ids');
const client = new NarwalClient({ host, port, productKey: DEMO ? undefined : saved?.productKey, deviceId: DEMO ? undefined : saved?.deviceId, log, debug: opts.debug });
const home: Home = DEMO ? new DemoHome() : new HAHome(log);
await home.start();
const engine = new Engine(client, store, home, opts.persone, log);
const bridge = new Bridge(engine, opts.pubblica_in_home_assistant && !DEMO, log);
if (DEMO) seedDemoHistory(store);

// ultimi messaggi ricevuti per argomento, per la diagnosi
const lastRaw = new Map<string, { ts: number; data: unknown }>();
client.on('broadcast', (topic: string, pb: PB) => lastRaw.set(topic, { ts: Date.now(), data: pb.toJSON() }));

if (host) client.start();
else log('Indirizzo IP del robot non impostato: aprilo nella scheda Configurazione dell\'app');
await bridge.start();
setInterval(() => store.prune(opts.conserva_giorni), 6 * 3600_000);

// ── API ───────────────────────────────────────────────────────────────────────

const who = (req: IncomingMessage) => {
  const v = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name'];
  return (Array.isArray(v) ? v[0] : v) ?? null;
};

const wrap = async <T>(fn: () => Promise<T>) => {
  try { return await fn(); }
  catch (e) { if (e instanceof CommandError) throw new HttpError(409, e.message); throw new HttpError(502, e instanceof Error ? e.message : String(e)); }
};

function roomsView() {
  const last = store.lastCleaned();
  return (engine.map?.rooms ?? []).map(r => {
    const area = engine.roomAreas[r.id] ?? null;
    const occ = area ? home.occupancy(area) : null;
    return {
      id: r.id, name: r.name, typeName: r.typeName, area: r.area ?? null, cx: r.cx, cy: r.cy,
      haArea: area, haAreaName: area ? home.areas().find(a => a.id === area)?.name ?? area : null,
      occupied: occ?.occupied ?? false, presenceSensors: occ?.sensors ?? [],
      lastCleaned: last[r.id] ?? null,
      settings: engine.roomSettings[r.id] ?? null,
    };
  });
}

function mapView(m: RobotMap) {
  // griglia compressa a coppie [valore, ripetizioni]
  const rle: number[] = [];
  for (let i = 0; i < m.grid.length;) {
    const v = m.grid[i]; let n = 1;
    while (i + n < m.grid.length && m.grid[i + n] === v) n++;
    rle.push(v, n); i += n;
  }
  return { id: m.id, width: m.width, height: m.height, resolution: m.resolution, dock: m.dock, fetchedAt: m.fetchedAt, area: m.area, rooms: m.rooms, rle };
}

const app = new MiniServer(join(here, '..', 'public'));

app.get('/api/overview', () => {
  const s = engine.state;
  const m = engine.map;
  return {
    version: VERSION, demo: DEMO,
    configured: !!host,
    robot: { ...s, positionPx: s.position && m ? { x: s.position.x - m.originX, y: s.position.y - m.originY, heading: s.position.heading } : null },
    error: s.online ? null : client.lastError ?? null,
    mapFetchedAt: m?.fetchedAt ?? null,
    live: engine.liveSession(),
    rooms: roomsView(),
    people: home.people(opts.persone), homeEmpty: engine.isHomeEmpty(), emptySince: engine.emptySince,
    defaults: engine.defaults,
    programs: engine.programsView().map(p => ({ id: p.id, name: p.name, enabled: p.enabled, description: p.description, next: p.next, lastRun: p.lastRun, lastResult: p.lastResult })),
    ha: { kind: home.kind, connected: home.connected, bridge: bridge.mode },
    labels: { fan: FAN, water: WATER, mode: WORK_MODE, strength: MOP_STRENGTH, route: ROUTE },
  };
});

app.get('/api/map', () => { if (!engine.map) throw new HttpError(404, 'Mappa non ancora ricevuta'); return mapView(engine.map); });

app.post('/api/clean', (_p, _q, req, body) => wrap(async () => {
  const rooms: number[] = Array.isArray(body?.rooms) ? body.rooms.map(Number) : [];
  const r = await engine.cleanRooms(rooms, body?.settings, 'NIDO', who(req), undefined, !body?.settings);
  return { ok: r.ok, message: r.message };
}));

app.post('/api/action', (_p, _q, req, body) => wrap(async () => {
  const r = await engine.action(String(body?.name ?? ''), body?.value, who(req));
  return { ok: r.ok, message: r.message };
}));

app.get('/api/programs', () => engine.programsView());
app.post('/api/programs', (_p, _q, req, body) => engine.upsertProgram(body, who(req)));
app.post('/api/programs/:id/delete', (p, _q, req) => { if (!engine.deleteProgram(p.id, who(req))) throw new HttpError(404, 'Programma non trovato'); return { ok: true }; });
app.post('/api/programs/:id/run', (p, _q, req) => wrap(async () => {
  const prog = engine.programs.find(x => x.id === p.id);
  if (!prog) throw new HttpError(404, 'Programma non trovato');
  return engine.runProgram(prog, 'avvio manuale', who(req));
}));
app.post('/api/programs/:id/toggle', (p, _q, req) => {
  const prog = engine.programs.find(x => x.id === p.id);
  if (!prog) throw new HttpError(404, 'Programma non trovato');
  prog.enabled = !prog.enabled; engine.savePrograms();
  engine.event('programma', `Programma «${prog.name}» ${prog.enabled ? 'attivato' : 'disattivato'}`, who(req));
  return { enabled: prog.enabled };
});
app.post('/api/programs/preview', (_p, _q, _r, body) => {
  return engine.plan(sanitizeProgram(body));
});

app.get('/api/sessions', (_p, q) => {
  const days = Math.min(400, Math.max(1, Number(q.get('days') ?? 30)));
  return store.sessions(Date.now() - days * 86400_000).map(s => sessionView(s, engine.map));
});
app.get('/api/sessions/:id', p => { const s = store.session(Number(p.id)); if (!s) throw new HttpError(404, 'Sessione non trovata'); return sessionView(s, engine.map); });

app.get('/api/stats', (_p, q) => {
  const days = Math.min(365, Math.max(7, Number(q.get('days') ?? 30)));
  return {
    ...statistics(store.sessions(Date.now() - 2 * days * 86400_000, Number.MAX_SAFE_INTEGER, 5000), days, engine.map, store.lastCleaned()),
    battery: store.samples(Date.now() - 2 * 86400_000),
  };
});

app.get('/api/events', (_p, q) => store.events(Date.now() - Math.min(365, Number(q.get('days') ?? 14)) * 86400_000));

app.get('/api/rooms', () => ({ rooms: roomsView(), areas: home.areas(), defaults: engine.defaults }));
app.post('/api/rooms/:id', (p, _q, req, body) => {
  const id = Number(p.id);
  if (!engine.map?.rooms.some(r => r.id === id)) throw new HttpError(404, 'Stanza non trovata');
  if (body && 'haArea' in body) engine.setRoomArea(id, body.haArea ? String(body.haArea) : null);
  if (body && 'settings' in body) engine.setRoomSettings(id, body.settings);
  engine.event('impostazioni', `Stanza ${engine.roomName(id)} aggiornata`, who(req));
  return { ok: true };
});
app.post('/api/defaults', (_p, _q, req, body) => { engine.setDefaults(body ?? {}); engine.event('impostazioni', 'Impostazioni di pulizia predefinite aggiornate', who(req)); return engine.defaults; });

app.get('/api/diagnosis', () => ({
  version: VERSION, host, port, demo: DEMO,
  robot: { online: engine.state.online, awake: engine.state.awake, productKey: engine.state.productKey, deviceId: engine.state.deviceId, model: engine.state.model, firmware: engine.state.firmware, lastBroadcast: engine.state.lastBroadcast, lastError: client.lastError, maintain: engine.state.maintainItems, replace: engine.state.replaceItems },
  ha: { kind: home.kind, connected: home.connected, bridge: bridge.mode },
  counts: store.counts(),
  raw: Object.fromEntries(lastRaw),
  log: [...logLines].reverse(),
}));

app.post('/api/data/reset', (_p, _q, req, body) => {
  if (body?.confirm !== 'CANCELLA') throw new HttpError(400, 'Conferma mancante');
  store.reset();
  store.addEvent('impostazioni', 'Storico cancellato', who(req));
  return { ok: true };
});

app.post('/api/reconnect', (_p, _q, req) => {
  store.setSetting('robot_ids', null);
  engine.event('impostazioni', 'Nuova identificazione del robot richiesta', who(req));
  client.stop();
  client.state.productKey = undefined; client.state.deviceId = undefined;
  setTimeout(() => client.start(), 500);
  return { ok: true };
});

if (DEMO) {
  const dh = home as DemoHome;
  app.post('/api/demo/person', (_p, _q, _r, body) => { dh.setPerson(String(body?.id), !!body?.home); return { ok: true }; });
  app.post('/api/demo/area', (_p, _q, _r, body) => { dh.toggleArea(String(body?.id)); return { ok: true }; });
}

await app.listen(PORT);
log(`Interfaccia su http://localhost:${PORT}`);

process.on('SIGTERM', () => { client.stop(); sim?.close(); process.exit(0); });
