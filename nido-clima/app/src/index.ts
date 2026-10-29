import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DATA_DIR, DEMO, PORT, loadOptions } from './config.js';
import { Store } from './db.js';
import { Engine, roomStats } from './engine.js';
import { HASource } from './ha.js';
import { DemoSource } from './demo.js';
import { HttpError, MiniServer } from './http.js';
import type { DataSource } from './types.js';

const VERSION = '0.1.0';
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const opts = loadOptions();
  const store = new Store(DATA_DIR);
  const log = (m: string) => console.log(`[nido-clima] ${m}`);

  const startTs = Date.now() - 36 * 3_600_000;
  const src: DataSource = DEMO ? new DemoSource(startTs) : new HASource(opts, log);
  const engine = new Engine(src, store, {
    onDelta: opts.soglia_accensione,
    offDelta: opts.soglia_spegnimento,
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
    const hours = Math.min(24 * 30, Math.max(1, Number(q.get('hours') ?? 24)));
    return store.history(room.id, Date.now() - hours * 3_600_000, 500);
  });

  app.get('/api/events', (_p, q) =>
    store.events(Math.min(1000, Number(q.get('limit') ?? 200)), q.get('room') || undefined));

  app.get('/api/stats', () => src.rooms().map(r => roomStats(store, r)));

  app.get('/api/entities', () => src.listEntities?.() ?? []);

  app.get('/api/settings', () => ({
    soglia_accensione: opts.soglia_accensione,
    soglia_spegnimento: opts.soglia_spegnimento,
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
