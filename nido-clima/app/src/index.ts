import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DATA_DIR, DEMO, PORT, loadOptions } from './config.js';
import { Store } from './db.js';
import { Engine, roomStats, simulate } from './engine.js';
import { DEFAULT_DETECTOR, DETECTOR_LIMITS, sanitizeDetector } from './detector.js';
import { HASource } from './ha.js';
import { DemoSource, demoOutdoor } from './demo.js';
import { DEFAULT_MODELS, Weather } from './weather.js';
import { houseDashboard } from './house.js';
import { HttpError, MiniServer } from './http.js';
import type { DataSource } from './types.js';
import { Feeder } from './feeder.js';
import { Automations, LEVEL_LABEL, MODE_LABEL, PRESENCE_LABEL } from './automations.js';
import { houseHumidity } from './humidity.js';
import type { Action } from './controls.js';
import { setupPlancia } from './plancia.js';

const VERSION = "0.8.1";
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const opts = loadOptions();
  const store = new Store(DATA_DIR);
  const log = (m: string) => console.log(`[nido-clima] ${m}`);

  const startTs = Date.now() - Number(process.env.DEMO_DAYS ?? 10) * 86_400_000;
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
    log('Modalità demo: genero lo storico simulato…');
    for (let t = startTs; t < Date.now(); t += 60_000) await engine.tick(t, false);
  }
  engine.log(`NIDO Clima ${VERSION} avviato${DEMO ? ' (demo)' : ''} — ${src.rooms().length} stanze`);

  const weather = new Weather(store, () => src.location?.() ?? null,
    opts.modelli_meteo?.length ? opts.modelli_meteo : DEFAULT_MODELS,
    () => !!opts.sensore_esterno, log, DEMO ? demoOutdoor : null);
  weather.start();

  // temperatura e umidità esterne: sensore di casa se c'è, altrimenti osservazioni e previsioni meteo
  const outdoorNow = () => {
    const o = src.outdoorSensor?.();
    if (o && o.temp != null) return { temp: o.temp, hum: o.hum };
    const w = weather.nowValue(Date.now());
    return { temp: w.temp, hum: w.hum };
  };
  const outdoorAtFactory = (from: number, to: number) => {
    const rows = store.outdoor(from - 3_600_000, to + 3_600_000);
    return (ts: number) => {
      if (ts > Date.now() - 30 * 60_000) return outdoorNow();
      let lo = 0, hi = rows.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].ts < ts) lo = mid + 1; else hi = mid; }
      const r = rows[lo] && Math.abs(rows[lo].ts - ts) < 2 * 3_600_000 ? rows[lo] : null;
      return r ? { temp: r.temp, hum: r.hum } : outdoorNow();
    };
  };
  const feeder = new Feeder(src, store, (m, room = null) => engine.log(m, room, 'automazione'));
  const autos = new Automations(src, store, (m, room, kind = 'automazione') => engine.log(m, room, kind), outdoorNow);

  const tick = () => engine.tick()
    .then(() => { const o = src.outdoorSensor?.(); if (o && o.temp != null) weather.recordSensor(Date.now(), o.temp, o.hum); })
    .then(() => autos.run(engine.views()))
    .catch(e => log(`Errore nel ciclo: ${e}`));
  await tick();
  setInterval(tick, opts.intervallo_secondi * 1000);
  // la temperatura alla valvola va inviata più spesso del ciclo principale
  const feed = () => feeder.run().catch(e => log(`Errore invio sensore esterno: ${e}`));
  await feed();
  setInterval(feed, 30_000);
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
    engine.panelCommand(room.id, Array.isArray(who) ? who[0] : who ?? null);
    engine.log(`${description}${who ? ` — da ${who}` : ''}`, room.id, 'comando');
    return { ok: true, message: description };
  });

  app.get('/api/house', (_p, q) => {
    const hours = Math.min(24 * 30, Math.max(6, Number(q.get('hours') ?? 48)));
    return { ...houseDashboard(store, weather, engine.views(), hours), location: src.location?.() ?? null };
  });

  app.post('/api/weather/refresh', async () => { await weather.refresh(); return { ok: true, updated: weather.updated, errors: weather.errors }; });

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

  const who = (req: any) => { const w = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name']; return (Array.isArray(w) ? w[0] : w) ?? null; };

  // ── chi cambia la temperatura ──
  app.get('/api/changes', (_p, q) => {
    const days = Math.min(60, Math.max(1, Number(q.get('days') ?? 14)));
    const since = Date.now() - days * 86_400_000;
    const names = new Map(src.rooms().map(r => [r.id, r.name]));
    const ev = store.events(5000, undefined, since).filter(e => (e.kind === 'obiettivo' || e.kind === 'modalita') && e.origin);
    const origins = ['utente', 'valvola', 'automazione', 'nido', 'programma'] as const;
    const zero = () => Object.fromEntries(origins.map(o => [o, 0])) as Record<string, number>;
    const byOrigin = zero();
    const byRoom = new Map<string, Record<string, number>>();
    const byWho = new Map<string, number>();
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const e of ev) {
      byOrigin[e.origin!]++;
      if (e.room) { const r = byRoom.get(e.room) ?? zero(); r[e.origin!]++; byRoom.set(e.room, r); }
      if (e.origin === 'nido' || e.origin === 'programma') continue;
      const k = e.origin === 'utente' ? e.who ?? 'utente' : e.origin === 'valvola' ? 'Sulla valvola' : 'Automazioni di HA';
      byWho.set(k, (byWho.get(k) ?? 0) + 1);
      byHour[new Date(e.ts).getHours()]++;
    }
    return {
      days, total: ev.length, byOrigin, byHour,
      byWho: [...byWho].map(([who, n]) => ({ who, n })).sort((a, b) => b.n - a.n),
      byRoom: [...byRoom].map(([room, c]) => ({ room, name: names.get(room) ?? room, ...c })),
      list: ev.filter(e => e.origin !== 'nido' && e.origin !== 'programma').slice(0, 60).map(e => ({ ...e, roomName: e.room ? names.get(e.room) ?? e.room : null })),
    };
  });

  // ── umidità ──
  app.get('/api/humidity', (_p, q) => {
    const days = Math.min(60, Math.max(2, Number(q.get('days') ?? 14)));
    const now = Date.now();
    const fc = weather.consensus(now, now + 26 * 3_600_000).map((c: any) => ({ ts: c.ts, temp: c.mean ?? null, hum: c.hum ?? null }));
    return houseHumidity(store, src.rooms(), days, outdoorAtFactory(now - days * 86_400_000, now), fc, now);
  });

  // ── automazioni ──
  app.get('/api/automations', async () => {
    const house = autos.houseState();
    return {
      settings: autos.settings, house, decisions: autos.decisions, overrides: autos.overrides,
      rooms: src.rooms().map(r => ({ id: r.id, name: r.name, auto: autos.roomAuto(r) })),
      labels: { levels: LEVEL_LABEL, modes: MODE_LABEL },
      people: (src.people?.() ?? []).map(p => ({ ...p, manual: autos.presence[p.id] ?? null })), notify: await src.notifyServices?.() ?? [],
    };
  });
  app.post('/api/automations', async (_p, _q, req, body) => {
    try { autos.save(body ?? {}, who(req)); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    await autos.run(engine.views()).catch(() => {});
    return { ok: true, settings: autos.settings, decisions: autos.decisions };
  });
  // ── presenza: modalità della casa e persone, modificabili a mano subito ──
  const presenceView = (req: any) => {
    const house = autos.houseState();
    const uid = req.headers['x-remote-user-id'];
    const me = house.all.find(p => p.userId && p.userId === (Array.isArray(uid) ? uid[0] : uid))?.id ?? null;
    return { house, me, enabled: autos.settings.enabled, labels: { modes: MODE_LABEL, presence: PRESENCE_LABEL } };
  };
  app.get('/api/presence', (_p, _q, req) => presenceView(req));
  app.post('/api/presence', async (_p, _q, req, body) => {
    const st = body?.state == null || body.state === 'auto' ? null : String(body.state);
    try { autos.setPresence(String(body?.person), st as any, body?.hours ? Number(body.hours) : null, who(req)); }
    catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    await autos.run(engine.views()).catch(() => {});
    return presenceView(req);
  });
  app.post('/api/automations/mode', async (_p, _q, req, body) => {
    try { autos.setMode(String(body?.mode) as any, body?.vacationUntil, who(req)); }
    catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    await autos.run(engine.views()).catch(() => {});
    return presenceView(req);
  });
  app.post('/api/automations/override', async (_p, _q, req, body) => {
    engine.panelCommand(String(body?.room), who(req));
    try { autos.setOverride(String(body?.room), body?.value == null ? null : Number(body.value), body?.hours ? Number(body.hours) : null, who(req)); }
    catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    await autos.run(engine.views()).catch(() => {});
    return { ok: true, decisions: autos.decisions };
  });

  // ── valvole: tutte le impostazioni e il sensore esterno ──
  app.get('/api/valves', () => ({
    feed: feeder.settings,
    valves: src.rooms().map(r => ({ room: r.id, name: r.name, controls: src.controls?.(r) ?? null, feed: feeder.view(r) })),
  }));
  app.post('/api/valves/feed', (_p, _q, req, body) => { feeder.save(body ?? {}, who(req)); return { ok: true, feed: feeder.settings }; });
  app.post('/api/valves/bulk', async (_p, _q, req, body) => {
    const key = String(body?.key ?? ''), value = body?.value;
    if (!key || !src.controls || !src.act) throw new HttpError(400, 'Impostazione mancante');
    const results: { room: string; ok: boolean; message: string }[] = [];
    for (const r of src.rooms()) {
      if (Array.isArray(body?.rooms) && !body.rooms.includes(r.id)) continue;
      const d = src.controls(r).device.find(x => x.key === key);
      if (!d) { results.push({ room: r.id, ok: false, message: 'non disponibile su questa valvola' }); continue; }
      try { const m = await src.act(r, { action: 'entity', entity_id: d.entity_id, value }); engine.log(`${m} (applicato a tutte)${who(req) ? ` — da ${who(req)}` : ''}`, r.id, 'comando'); results.push({ room: r.id, ok: true, message: m }); }
      catch (e) { results.push({ room: r.id, ok: false, message: e instanceof Error ? e.message : String(e) }); }
    }
    return { results };
  });

  if (DEMO) app.post('/api/demo/person', (_p, _q, _r, body) => { (src as DemoSource).setPerson(String(body?.id), !!body?.home); return { ok: true }; });

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

  // plancia di Home Assistant con l'app a tutto schermo (si può scegliere come pagina iniziale)
  if (!DEMO && opts.plancia !== false)
    setupPlancia({ addon: 'nido_clima', urlPath: 'nido-clima', title: 'NIDO Clima', icon: 'mdi:radiator',
      cardDir: join(here, '..', 'plancia'), log }).catch(e => log(`Plancia: ${e}`));
}

main();
