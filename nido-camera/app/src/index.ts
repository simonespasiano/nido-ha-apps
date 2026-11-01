import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { DATA_DIR, DEMO, GO2RTC_BIN, HA_CONFIG_DIR, MEDIA_DIR, PORT, loadOptions } from './config.js';
import { Store } from './db.js';
import { MiniServer, HttpError, HANDLED, sendFile } from './http.js';
import { DemoHome, HAHome, type Home } from './ha.js';
import { DemoBackend, Go2rtcBackend, GO2RTC_API_PORT, STREAM, type Backend } from './backend.js';
import { Engine, MODE_LABEL } from './engine.js';
import { Bridge } from './bridge.js';

export const VERSION = '0.1.1';
const here = dirname(fileURLToPath(import.meta.url));
const opts = loadOptions();
const store = new Store(DATA_DIR);
const logLines: { ts: number; msg: string }[] = [];
const log = (msg: string) => {
  console.log(`[${new Date().toLocaleTimeString('it-IT')}] ${msg}`);
  logLines.push({ ts: Date.now(), msg });
  if (logLines.length > 300) logLines.shift();
};
log(`NIDO Camera ${VERSION}${DEMO ? ' · modalità demo con immagini di prova' : ''}`);

const home: Home = DEMO ? new DemoHome() : new HAHome(log);
await home.start();
const backend: Backend = DEMO ? new DemoBackend() : new Go2rtcBackend(GO2RTC_BIN, DATA_DIR, HA_CONFIG_DIR, log, opts.debug);
if (DEMO) { opts.notifiche = opts.notifiche.length ? opts.notifiche : ['mobile_app_iphone_di_simone']; }
const engine = new Engine(opts, store, home, backend, MEDIA_DIR, log);
await engine.discover();
backend.start();
// nuove camere o abbinamenti rifatti: si ricontrolla ogni 5 minuti (ogni 30 s finché non ce n'è una)
setInterval(() => { if (!engine.camera || Date.now() % 300_000 < 30_000) engine.discover().catch(() => undefined); }, 30_000);
const bridge = new Bridge(engine, opts.pubblica_in_home_assistant && !DEMO, log);
await bridge.start();

const who = (req: IncomingMessage) => {
  const v = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name'];
  return (Array.isArray(v) ? v[0] : v) ?? null;
};

const app = new MiniServer(join(here, '..', 'public'));
app.proxy('/go2rtc', GO2RTC_API_PORT, () => engine.liveAllowed() ? null : 'Diretta disattivata quando c\'è qualcuno in casa');

app.get('/api/overview', async () => {
  const st = await backend.status();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const notifyAvailable = await home.notifyServices().catch(() => []);
  return {
    version: VERSION, demo: DEMO,
    camera: engine.camera, cameras: engine.cameras, backend: st,
    live: { allowed: engine.liveAllowed(), kind: DEMO ? 'mjpeg' : 'go2rtc' },
    rules: engine.rules, decision: engine.decision(), modes: MODE_LABEL,
    people: engine.people(), homeEmpty: engine.homeEmpty(), vacuumBusy: engine.vacuumBusy(),
    triggers: engine.triggers().map(id => ({ id, name: home.state(id)?.attributes.friendly_name ?? id, state: home.state(id)?.state ?? 'non trovato' })),
    recording: engine.recorder.current ? { ...engine.recorder.current } : null,
    lastSnapshot: engine.lastSnapshot, go2rtcError: engine.lastGo2rtcError,
    notify: { configured: opts.notifiche, available: notifyAvailable },
    today: store.stats(today.getTime()),
    bytes: store.totalBytes(), maxBytes: opts.spazio_massimo_gb * 1024 ** 3, keepDays: opts.conserva_giorni,
    ha: { kind: home.kind, connected: home.connected, bridge: bridge.mode },
    rtsp: DEMO ? null : `rtsp://<indirizzo di Home Assistant>:8554/${STREAM}?video&audio=aac`,
  };
});

app.get('/api/live.mjpeg', (_p, _q, _req, _b, res) => {
  if (!engine.liveAllowed()) throw new HttpError(403, 'Diretta disattivata quando c\'è qualcuno in casa');
  if (backend instanceof DemoBackend) { backend.mjpeg(res); return HANDLED; }
  res.writeHead(302, { Location: `../go2rtc/api/stream.mjpeg?src=${STREAM}` }); res.end();
  return HANDLED;
});

app.post('/api/snapshot', async (_p, _q, req) => {
  try { const s = await engine.snapshot(undefined, who(req)); return { ok: true, rel: s.rel }; }
  catch (e) { throw new HttpError(502, `Foto non riuscita: ${e instanceof Error ? e.message : e}`); }
});
app.post('/api/record', async (_p, _q, req) => {
  if (engine.recorder.busy) throw new HttpError(409, 'Registrazione già in corso');
  await engine.motion('manuale', 'manuale', who(req));
  return { ok: true };
});
app.post('/api/record/stop', () => { engine.recorder.stop(); return { ok: true }; });

app.get('/api/events', (_p, q) => {
  const days = Math.min(365, Math.max(1, Number(q.get('days') ?? 2)));
  const kind = q.get('kind');
  return store.events(Date.now() - days * 86400_000, Number.MAX_SAFE_INTEGER, 1000).filter(e => !kind || kind === 'tutti' || (kind === 'clip' ? e.recorded : e.kind === kind));
});
app.post('/api/events/:id/delete', (p, _q, req) => {
  if (!engine.deleteEvent(Number(p.id))) throw new HttpError(404, 'Evento non trovato');
  store.log('spazio', 'Evento eliminato', who(req));
  return { ok: true };
});
app.get('/api/stats', (_p, q) => {
  const days = Math.min(90, Math.max(1, Number(q.get('days') ?? 7)));
  const since = Date.now() - days * 86400_000;
  const evs = store.events(since, Number.MAX_SAFE_INTEGER, 5000).filter(e => e.kind === 'movimento');
  const byDay: Record<string, number> = {};
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400_000); byDay[d.toISOString().slice(0, 10)] = 0; }
  for (const e of evs) { const k = new Date(e.ts).toISOString().slice(0, 10); if (k in byDay) byDay[k]++; }
  return { ...store.stats(since), byDay };
});

app.get('/media/:a/:b/:c', (p, _q, req, _b, res) => sendFile(MEDIA_DIR, `${p.a}/${p.b}/${p.c}`, req, res));

app.get('/api/rules', () => ({ rules: engine.rules, decision: engine.decision() }));
app.post('/api/rules', (_p, _q, req, body) => { engine.saveRules(body, who(req)); return { rules: engine.rules, decision: engine.decision() }; });
app.post('/api/notify/test', async (_p, _q, req) => {
  try { await engine.testNotify(who(req)); return { ok: true }; } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
});
app.post('/api/rediscover', async () => { await engine.discover(); return { camera: engine.camera, cameras: engine.cameras }; });

app.get('/api/log', () => ({
  log: store.logs(Date.now() - 7 * 86400_000),
  app: [...logLines].reverse(),
  go2rtc: backend instanceof Go2rtcBackend ? backend.goLog().slice(-80).reverse() : [],
  config: (() => { try { return readFileSync(`${DATA_DIR}/go2rtc.yaml`, 'utf8'); } catch { return null; } })(),
}));

if (DEMO) {
  const dh = home as DemoHome;
  app.post('/api/demo/state', (_p, _q, _r, body) => { dh.setState(String(body?.id), String(body?.state)); return { ok: true }; });
  app.get('/api/demo/sent', () => dh.sent.slice(-10));
}

await app.listen(PORT);
log(`Interfaccia su http://localhost:${PORT}`);
process.on('SIGTERM', () => { backend.stop(); engine.recorder.stop(); setTimeout(() => process.exit(0), 1500); });
