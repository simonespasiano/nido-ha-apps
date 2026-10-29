import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DATA_DIR, DEMO, PORT, loadOptions } from './config.js';
import { Store } from './db.js';
import { Engine, roomStats, simulate } from './engine.js';
import { DEFAULT_DETECTOR, DETECTOR_LIMITS, sanitizeDetector } from './detector.js';
import { HASource } from './ha.js';
import { DemoSource } from './demo.js';
import { HttpError, MiniServer } from './http.js';
import type { DataSource } from './types.js';
import type { Action } from './controls.js';

const VERSION = '0.5.3';
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const opts = loadOptions();
  const store = new Store(DATA_DIR);
  const log = (m: string) => console.log(`[nido-clima] ${m}`);

  const startTs = Date.now() - 36 * 3_600_000;
  const src: DataSource = DEMO ? new DemoSource(startTs) : new HASource(opts, log);
  const engine = new Engine(src, store, {
    ...DEFAULT_DETECTOR,
    onDelta: opts.soglia_accensione,
    offDelta: Math.min(opts.soglia_spegnimento, opts.soglia_accensione - 0.1),
  }, opts.pubblica_sensori && !DEMO);

  try {
    await src.start();
  } catch (err) {
    log(`Avvio non riuscito: ${err}`);
    process.exit(1);
  }

  if (DEMO && store.isEmpty()) {
    log('Modalità demo: genero 36 ore di storico simulato…');
    for (let t = startTs; t < Date.now(); t += 60_000) await engine.tick(t, false);
  }
  engine.log(`NIDO Clima ${VERSION} avviato${DEMO ? ' (demo)' : ''} — ${src.rooms().length} stanze`);

  const tick = () => engine.tick().catch(e => log(`Errore nel ciclo: ${e}`));
  await tick();
  setInterval(tick, opts.intervallo_secondi * 1000);
  setInterval(() => store.prune(opts.conserva_giorni), 6 * 3_600_000);

  const app = new MiniServer(join(here, '..', 'public'));
  const findRoom = (id: string) => {
    const r = src.rooms().find(r => r.id === id);
    if (!r) throw new HttpError(404, 'Stanza non trovata');
    return r;
  };

  app.get('/api/overview', () => ({
    version: VERSION, demo: DEMO, updated: engine.lastTick,
    plant: engine.plant ?? null,
    rooms: engine.views(),
  }));

  app.get('/api/rooms/:id/history', (p, q) => {
    const room = findRoom(p.id);
    // intervallo esplicito (from/to in ms) per lo zoom, altrimenti le ultime N ore
    const max = Math.min(5000, Math.max(50, Number(q.get('max') ?? 500)));
    if (q.get('from')) {
      const from = Number(q.get('from')), to = Number(q.get('to') ?? Date.now());
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, 'Intervallo non valido');
      return store.history(room.id, from, max, to);
    }
    const hours = Math.min(24 * 400, Math.max(1, Number(q.get('hours') ?? 24)));
    return store.history(room.id, Date.now() - hours * 3_600_000, max);
  });

  app.get('/api/events', (_p, q) =>
    store.events(Math.min(1000, Number(q.get('limit') ?? 200)), q.get('room') || undefined,
      Number(q.get('from') ?? 0) || 0, Number(q.get('to') ?? 0) || Number.MAX_SAFE_INTEGER));

  app.get('/api/stats', () => src.rooms().map(r => roomStats(store, r)));

  app.get('/api/entities', () => src.listEntities?.() ?? []);

  app.get('/api/rooms/:id/controls', p => {
    const room = findRoom(p.id);
    if (!src.controls) throw new HttpError(501, 'Comandi non disponibili');
    return src.controls(room);
  });

  app.post('/api/rooms/:id/action', async (p, _q, req, body) => {
    const room = findRoom(p.id);
    if (!src.act) throw new HttpError(501, 'Comandi non disponibili');
    if (!body || typeof body.action !== 'string') throw new HttpError(400, 'Azione mancante');
    let description: string;
    try { description = await src.act(room, body as Action); }
    catch (err) { throw new HttpError(400, err instanceof Error ? err.message : String(err)); }
    // l'ingress di Home Assistant indica chi sta usando il pannello
    const who = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name'];
    engine.log(`${description}${who ? ` — da ${who}` : ''}`, room.id, 'comando');
    return { ok: true, message: description };
  });

  app.get('/api/diagnosis', () => src.diagnosis ?? { areas: [], unassigned: [], mode: 'auto' });

  app.get('/api/thresholds', () => ({ ...engine.thresholds, limits: DETECTOR_LIMITS,
    rooms_list: src.rooms().map(r => ({ id: r.id, name: r.name })) }));

  app.post('/api/thresholds', (_p, _q, req, body) => {
    let t;
    try { t = body?.reset ? engine.resetThresholds() : engine.saveThresholds(body ?? {}); }
    catch (err) { throw new HttpError(400, err instanceof Error ? err.message : String(err)); }
    const who = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name'];
    const g = t.global;
    engine.log(`${body?.reset ? 'Soglie riportate ai valori della configurazione' : 'Soglie modificate'}: acceso sopra +${g.onDelta} °C, spento sotto +${g.offDelta} °C`
      + `${Object.keys(t.rooms).length ? ` (valori propri per ${Object.keys(t.rooms).length} ${Object.keys(t.rooms).length === 1 ? 'stanza' : 'stanze'})` : ''}${who ? ` — da ${who}` : ''}`);
    return t;
  });

  app.post('/api/thresholds/simulate', (_p, _q, _req, body) => {
    const hours = Math.min(24 * 30, Math.max(1, Number(body?.hours ?? 24)));
    const to = Date.now(), from = to - hours * 3_600_000;
    try {
      const global = sanitizeDetector(body?.global ?? {}, engine.thresholds.global);
      return src.rooms().map(r => {
        const cfg = sanitizeDetector(body?.rooms?.[r.id] ?? {}, global);
        return simulate(store, r, cfg, from, to);
      });
    } catch (err) { throw new HttpError(400, err instanceof Error ? err.message : String(err)); }
  });

  app.get('/api/data', () => store.counts());

  app.post('/api/data/reset', (_p, _q, req, body) => {
    if (body?.confirm !== 'CANCELLA') throw new HttpError(400, 'Conferma mancante');
    const withSettings = body?.settings === true;
    store.reset(withSettings);
    engine.clearMemory();
    if (withSettings) engine.resetThresholds();
    const who = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name'];
    engine.log(`Storico e diario azzerati${withSettings ? ', soglie riportate ai valori della configurazione' : ''}${who ? ` — da ${who}` : ''}`);
    return store.counts();
  });

  app.get('/api/settings', () => ({
    soglia_accensione: engine.thresholds.global.onDelta,
    soglia_spegnimento: engine.thresholds.global.offDelta,
    intervallo_secondi: opts.intervallo_secondi,
    conserva_giorni: opts.conserva_giorni,
    pubblica_sensori: opts.pubblica_sensori,
    stanze_manuali: opts.stanze.length,
    rooms: src.rooms(),
  }));

  await app.listen(PORT);
  log(`Interfaccia in ascolto sulla porta ${PORT}`);
}

main();
