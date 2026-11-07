import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { Store } from './db.js';
import { MiniServer, HttpError } from './http.js';
import { Hardware } from './sysfs.js';
import { SimPi } from './sim.js';
import { Engine, type Options } from './engine.js';
import { Bridge } from './bridge.js';
import { CURVES, MODE_HELP, MODE_LABEL, SAFETY_TEMP, type FanMode } from './fan.js';

export const VERSION = '0.1.1';
const DEMO = process.env.DEMO === '1';
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const PORT = Number(process.env.PORT ?? 8099);
const here = dirname(fileURLToPath(import.meta.url));

const raw: any = (() => { const p = process.env.OPTIONS_PATH ?? `${DATA_DIR}/options.json`; try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; } catch { return {}; } })();
const opts: Options = {
  notifiche: (Array.isArray(raw.notifiche) ? raw.notifiche : []).map((s: string) => String(s).trim().replace(/^notify\./, '')).filter(Boolean),
  avviso_temperatura: Number(raw.avviso_temperatura ?? 75), conserva_giorni: Number(raw.conserva_giorni ?? 30),
  pubblica_in_home_assistant: raw.pubblica_in_home_assistant !== false, debug: !!raw.debug,
};

const logLines: { ts: number; msg: string }[] = [];
const log = (msg: string) => { console.log(`[${new Date().toLocaleTimeString('it-IT')}] ${msg}`); logLines.push({ ts: Date.now(), msg }); if (logLines.length > 300) logLines.shift(); };
log(`NIDO Sistema ${VERSION}${DEMO ? ' · demo con un Raspberry Pi simulato' : ''}`);

let hw: Hardware;
if (DEMO) { const sim = new SimPi(join(DATA_DIR, 'sim')); hw = new Hardware(join(sim.root, 'sys'), join(sim.root, 'proc'), DATA_DIR); }
else hw = new Hardware('/sys', '/proc', '/data');
if (!hw.hasFan()) log('Ventola non trovata: solo lettura delle temperature');

// Home Assistant via REST (notifiche, stati) e credenziali MQTT dal Supervisor
const token = process.env.SUPERVISOR_TOKEN ?? '';
const haRest = token ? 'http://supervisor/core/api' : null;
const ha = haRest ? {
  notify: async (svc: string, title: string, message: string) => {
    const r = await fetch(`${haRest}/services/notify/${svc}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, message, data: { tag: 'nido-sistema' } }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
} : DEMO ? { notify: async (svc: string, title: string) => { log(`(demo) notifica a ${svc}: ${title}`); } } : null;

const store = new Store(DATA_DIR);
if (DEMO && !store.summary(0).n) {
  // 3 giorni finti per vedere i grafici
  for (let ts = Date.now() - 3 * 86400_000; ts < Date.now(); ts += 60_000) {
    const h = new Date(ts).getHours(), busy = (h >= 19 && h <= 23) || (h === 3) ? 1 : 0;
    const load = 12 + busy * 35 + 8 * Math.sin(ts / 3.6e6) + Math.random() * 6;
    const fan = busy ? 50 + Math.random() * 10 : 29;
    const cpu = 44 + load * 0.3 - fan * 0.08 + Math.random();
    store.addSample({ ts, cpu, rp1: cpu - 5, ssd: cpu - 12, rpm: 1500 + fan * 65, fan, load, freq: busy ? 2400 : 1500 });
  }
}
const engine = new Engine(hw, store, opts, ha, log);
const mqttSvc = token ? async () => {
  const r = await fetch('http://supervisor/services/mqtt', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const d: any = ((await r.json()) as any).data;
  return d?.host ? { host: d.host, port: Number(d.port ?? 1883), username: d.username, password: d.password, ssl: !!d.ssl } : null;
} : null;
const rest = haRest ? { setState: async (id: string, state: string, attributes: Record<string, unknown>) => { await fetch(`${haRest}/states/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ state, attributes }) }).catch(() => undefined); } } : null;
const bridge = new Bridge(engine, opts.pubblica_in_home_assistant && !DEMO, mqttSvc, rest, log);
await bridge.start();

const who = (req: IncomingMessage) => { const v = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name']; return (Array.isArray(v) ? v[0] : v) ?? null; };
const app = new MiniServer(join(here, '..', 'public'));

app.get('/api/overview', () => {
  const s = engine.last;
  const day = store.summary(Date.now() - 86400_000);
  return {
    version: VERSION, demo: DEMO, snap: s,
    fan: { ...engine.settings, curve: engine.curve(), target: engine.target, boostUntil: engine.boostUntil, control: hw.control, inControl: hw.inControl, note: engine.controlNote, hasFan: hw.hasFan() },
    modes: Object.keys(MODE_LABEL).map(k => ({ id: k, label: MODE_LABEL[k as FanMode], help: MODE_HELP[k as FanMode], curve: k === 'auto' ? null : k === 'personalizzata' ? engine.settings.custom : CURVES[k as keyof typeof CURVES] })),
    safety: SAFETY_TEMP, alertTemp: opts.avviso_temperatura,
    day: { cpuMin: day.cpuMin, cpuMax: day.cpuMax, cpuAvg: day.cpuAvg, fanAvg: day.fanAvg, ssdMax: day.ssdMax },
    notify: opts.notifiche, bridge: bridge.mode,
  };
});

app.get('/api/history', (_p, q) => {
  const hours = Math.min(24 * 30, Math.max(1, Number(q.get('hours') ?? 24)));
  const points = 300;
  const bucket = Math.max(30_000, Math.round((hours * 3600_000) / points / 30_000) * 30_000);
  return { hours, bucket, series: store.series(Date.now() - hours * 3600_000, bucket) };
});

app.post('/api/fan', (_p, _q, req, body) => {
  try { engine.setMode(body?.mode, who(req), body?.custom, body?.hyst, body?.useHottest); }
  catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
  return { ok: true };
});
app.post('/api/boost', (_p, _q, req, body) => { engine.boost(Number(body?.minutes ?? 15), who(req)); return { ok: true }; });
app.post('/api/notify/test', async (_p, _q, req) => { try { await engine.testNotify(who(req)); return { ok: true }; } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); } });
app.get('/api/log', () => ({ log: store.logs(Date.now() - 14 * 86400_000), app: [...logLines].reverse() }));

await app.listen(PORT);
log(`Interfaccia su http://localhost:${PORT}`);
const stop = () => { engine.shutdown(); log('Ventola restituita al firmware, arresto'); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
