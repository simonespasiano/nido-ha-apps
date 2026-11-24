import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { DATA_DIR, DEMO, PORT, loadOptions } from './config.js';
import { Store } from './db.js';
import { Engine, posLabel } from './engine.js';
import { HAHome, type Home } from './home.js';
import { DemoHome } from './demo.js';
import { HttpError, MiniServer } from './http.js';
import { Bridge } from './bridge.js';
import { statistics } from './stats.js';
import { MODE_LABEL, sanitizeGlobal, sanitizeRule, sanitizeScene, sanitizeShutter, type Mode } from './model.js';
import { DIRECTIONS, sunPosition } from './sun.js';

const VERSION = '0.1.0';
const here = dirname(fileURLToPath(import.meta.url));
const log = (m: string) => console.log(`[nido-tapparelle] ${m}`);

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'x';
const who = (req: IncomingMessage) => { const w = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name']; return (Array.isArray(w) ? w[0] : w) ?? null; };
const bad = (e: unknown) => new HttpError(400, e instanceof Error ? e.message : String(e));

async function main() {
  const opts = loadOptions();
  const store = new Store(DATA_DIR);
  const home: Home = DEMO ? new DemoHome() : new HAHome(log);
  const engine = new Engine(home, store, opts, log);
  if (opts.persone.length && !engine.global.people.length) engine.global.people = opts.persone;

  try { await home.start(); }
  catch (err) { log(`Avvio non riuscito: ${err instanceof Error ? err.message : err}`); process.exit(1); }

  home.onChange((e, o, n) => { try { engine.onStateChange(e, o, n); } catch (err) { log(`Errore: ${err}`); } });
  home.onRegistry(() => { engine.checkNewDevices(); engine.emit('settings'); });
  engine.checkNewDevices(true);
  engine.log(`NIDO Tapparelle ${VERSION} avviata${DEMO ? ' (demo)' : ''} — ${engine.shutters().length} tapparelle`);

  const bridge = new Bridge(engine, opts.pubblica_in_home_assistant && !DEMO, log);
  await bridge.start();

  const tick = () => engine.tick().catch(e => log(`Errore nel ciclo: ${e instanceof Error ? e.stack : e}`));
  await tick();
  setInterval(tick, 30_000);
  setInterval(() => { store.prune(opts.conserva_giorni); engine.checkNewDevices(); }, 6 * 3_600_000);

  const app = new MiniServer(join(here, '..', 'public'));
  const groups = () => [...new Set(engine.shutters().map(s => s.settings.group).filter(Boolean))].sort();

  app.get('/api/overview', () => ({
    version: VERSION, demo: DEMO, ha: { kind: home.kind, connected: home.connected, bridge: bridge.mode },
    overview: engine.overview(), shutters: engine.views(), scenes: engine.scenes,
    areas: home.areas().filter(a => engine.shutters().some(s => s.cover.areaId === a.id)), groups: groups(),
  }));

  // ── comandi ──
  app.post('/api/shutters/:id/command', async (p, _q, req, b) => {
    const s = engine.shutters().find(x => x.id === p.id);
    if (!s) throw new HttpError(404, 'Tapparella non trovata');
    const target = b?.action === 'position' ? Number(b.position) : b?.action === 'favorite' ? s.settings.favorite : b?.action;
    if (!['open', 'close', 'stop'].includes(target) && !Number.isFinite(target)) throw new HttpError(400, 'Comando non valido');
    try { return { ok: true, message: await engine.command(s.id, target, { origin: 'utente', who: who(req) ?? 'pannello NIDO', reason: 'dal pannello' }) }; }
    catch (e) { throw bad(e); }
  });

  app.post('/api/command', async (_p, _q, req, b) => {
    const list = engine.resolveTargets(Array.isArray(b?.targets) ? b.targets.map(String) : []);
    if (!list.length) throw new HttpError(400, 'Nessuna tapparella scelta');
    const target = b?.action === 'position' ? Number(b.position) : b?.action;
    const res: string[] = [];
    for (const s of list) {
      const t = b?.action === 'favorite' ? s.settings.favorite : target;
      try { res.push(await engine.command(s.id, t, { origin: 'utente', who: who(req) ?? 'pannello NIDO', reason: 'dal pannello' })); }
      catch (e) { res.push(e instanceof Error ? e.message : String(e)); }
    }
    const label = b?.action === 'open' ? 'Aperte' : b?.action === 'close' ? 'Chiuse' : b?.action === 'stop' ? 'Fermate' : b?.action === 'favorite' ? 'Posizione preferita per' : `Portate ${posLabel(target)}`;
    engine.log(`${label} ${list.length} tapparelle${who(req) ? ` — da ${who(req)}` : ''}`, null, 'comando', 'utente', who(req));
    return { ok: true, results: res };
  });

  app.post('/api/shutters/:id/resume', (p, _q, req) => { engine.resume(p.id, who(req)); return { ok: true }; });

  app.post('/api/shutters/:id/settings', (p, _q, req, b) => {
    const s = engine.shutters().find(x => x.id === p.id);
    if (!s) throw new HttpError(404, 'Tapparella non trovata');
    let next;
    try { next = sanitizeShutter(b ?? {}, s.settings); } catch (e) { throw bad(e); }
    engine.saveShutter(s.id, next);
    engine.log(`Impostazioni modificate${who(req) ? ` — da ${who(req)}` : ''}`, s.id, 'impostazioni', 'utente', who(req));
    return { ok: true, settings: next };
  });

  app.get('/api/shutters/:id/history', (p, q) => {
    const days = Math.min(60, Math.max(1, Number(q.get('days') ?? 2)));
    const since = Date.now() - days * 86_400_000;
    return { moves: store.moves(since, Date.now() + 1, p.id), start: store.positionBefore(p.id, since), since };
  });

  // ── scenari ──
  app.post('/api/scenes', (_p, _q, req, b) => {
    const id = b?.id && engine.scenes.some(s => s.id === b.id) ? String(b.id) : (() => {
      let base = slug(String(b?.name ?? 'scenario')), id = base, n = 2;
      while (engine.scenes.some(s => s.id === id)) id = `${base}_${n++}`;
      return id;
    })();
    let sc;
    try { sc = sanitizeScene(b, id); } catch (e) { throw bad(e); }
    if (!Object.keys(sc.positions).length) throw new HttpError(400, 'Aggiungi almeno una tapparella');
    const list = engine.scenes.filter(s => s.id !== id);
    const idx = engine.scenes.findIndex(s => s.id === id);
    list.splice(idx < 0 ? list.length : idx, 0, sc);
    engine.saveScenes(list);
    engine.log(`Scenario "${sc.name}" salvato${who(req) ? ` — da ${who(req)}` : ''}`, null, 'impostazioni', 'utente', who(req));
    return { ok: true, scene: sc };
  });
  app.post('/api/scenes/:id/delete', (p, _q, req) => {
    const sc = engine.scenes.find(s => s.id === p.id);
    if (!sc) throw new HttpError(404, 'Scenario non trovato');
    const used = engine.rules.filter(r => r.action.type === 'scenario' && r.action.scene === p.id);
    if (used.length) throw new HttpError(400, `Lo usa l'automazione "${used[0].name}": cambiala prima`);
    engine.saveScenes(engine.scenes.filter(s => s.id !== p.id));
    engine.log(`Scenario "${sc.name}" eliminato${who(req) ? ` — da ${who(req)}` : ''}`, null, 'impostazioni', 'utente', who(req));
    return { ok: true };
  });
  app.post('/api/scenes/:id/run', async (p, _q, req) => {
    try { return { ok: true, results: await engine.runScene(p.id, { origin: 'utente', who: who(req) ?? 'pannello NIDO', reason: null }) }; }
    catch (e) { throw bad(e); }
  });

  // ── automazioni ──
  app.get('/api/rules', () => ({
    rules: engine.rules.map(r => ({ ...r, next: engine.nextEvents(Date.now(), 48).find(e => e.rule === r.id)?.ts ?? null })),
    next: engine.nextEvents(Date.now(), 30),
  }));
  app.post('/api/rules', (_p, _q, req, b) => {
    const id = b?.id && engine.rules.some(r => r.id === b.id) ? String(b.id) : (() => {
      let base = slug(String(b?.name ?? 'automazione')), id = base, n = 2;
      while (engine.rules.some(r => r.id === id)) id = `${base}_${n++}`;
      return id;
    })();
    let r;
    try { r = sanitizeRule(b, id); } catch (e) { throw bad(e); }
    const list = [...engine.rules];
    const idx = list.findIndex(x => x.id === id);
    if (idx >= 0) list[idx] = r; else list.push(r);
    engine.saveRules(list);
    engine.log(`Automazione "${r.name}" salvata${r.enabled ? '' : ' (spenta)'}${who(req) ? ` — da ${who(req)}` : ''}`, null, 'impostazioni', 'utente', who(req));
    return { ok: true, rule: r };
  });
  app.post('/api/rules/:id/delete', (p, _q, req) => {
    const r = engine.rules.find(x => x.id === p.id);
    if (!r) throw new HttpError(404, 'Automazione non trovata');
    engine.saveRules(engine.rules.filter(x => x.id !== p.id));
    engine.log(`Automazione "${r.name}" eliminata${who(req) ? ` — da ${who(req)}` : ''}`, null, 'impostazioni', 'utente', who(req));
    return { ok: true };
  });
  app.post('/api/rules/:id/toggle', (p, _q, req, b) => {
    const r = engine.rules.find(x => x.id === p.id);
    if (!r) throw new HttpError(404, 'Automazione non trovata');
    engine.saveRules(engine.rules.map(x => x.id === p.id ? { ...x, enabled: !!b?.enabled } : x));
    engine.log(`Automazione "${r.name}" ${b?.enabled ? 'attivata' : 'spenta'}${who(req) ? ` — da ${who(req)}` : ''}`, null, 'impostazioni', 'utente', who(req));
    return { ok: true };
  });
  app.post('/api/rules/:id/run', async (p, _q, req) => {
    const r = engine.rules.find(x => x.id === p.id);
    if (!r) throw new HttpError(404, 'Automazione non trovata');
    const d: string[] = [];
    await engine.execRule(r, d, who(req) ?? 'pannello NIDO');
    return { ok: true, message: d[0] ?? '' };
  });

  // ── impostazioni della casa ──
  app.get('/api/settings', async () => ({
    global: engine.global, modeLabel: MODE_LABEL, directions: DIRECTIONS,
    notifyServices: await home.notifyServices(), people: engine.presence().people,
    allPeople: home.people([]).map(p => ({ id: p.id, name: p.name })),
    outdoor: engine.outdoorEntities(), sensors: home.sensors(),
  }));
  app.post('/api/settings', async (_p, _q, req, b) => {
    let g;
    try { g = sanitizeGlobal(b ?? {}, engine.global); } catch (e) { throw bad(e); }
    const modeChanged = g.mode !== engine.global.mode;
    engine.saveGlobal(g);
    engine.log(modeChanged ? `Modalità impostata su ${MODE_LABEL[g.mode as Mode]}${g.mode === 'vacanza' && g.vacationUntil ? ` fino al ${new Date(g.vacationUntil).toLocaleDateString('it-IT')}` : ''}${who(req) ? ` — da ${who(req)}` : ''}`
      : `Impostazioni della casa modificate${who(req) ? ` — da ${who(req)}` : ''}`, null, modeChanged ? 'modalita' : 'impostazioni', 'utente', who(req));
    await engine.tick();
    return { ok: true, global: g };
  });
  app.post('/api/mode', async (_p, _q, req, b) => {
    const g = sanitizeGlobal({ ...engine.global, mode: b?.mode, vacationUntil: b?.vacationUntil ?? null }, engine.global);
    engine.saveGlobal(g);
    engine.log(`Modalità impostata su ${MODE_LABEL[g.mode]}${g.mode === 'vacanza' && g.vacationUntil ? ` fino al ${new Date(g.vacationUntil).toLocaleDateString('it-IT')}` : ''}${who(req) ? ` — da ${who(req)}` : ''}`, null, 'modalita', 'utente', who(req));
    await engine.tick();
    return { ok: true };
  });

  app.get('/api/sensors', () => {
    const sh = engine.shutters();
    return {
      sensors: home.sensors().map(s => ({ ...s, linked: sh.filter(x => x.contact === s.entity || x.settings.lux === s.entity).map(x => engine.nameOf(x)) })),
      outdoor: engine.outdoorEntities(), values: engine.outdoor(),
      areas: home.areas(),
    };
  });

  app.get('/api/sunpath', () => {
    const loc = home.location();
    if (!loc) return { points: [], now: null };
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const day = (base: number) => Array.from({ length: 97 }, (_, i) => base + i * 15 * 60_000).map(ts => ({ ts, ...sunPosition(ts, loc.lat, loc.lon) })).filter(p => p.elevation > -2);
    const y = new Date(d.getFullYear(), 5, 21).getTime(), w = new Date(d.getFullYear(), 11, 21).getTime();
    return { points: day(d.getTime()), summer: day(y), winter: day(w), now: sunPosition(Date.now(), loc.lat, loc.lon) };
  });

  // ── diario e statistiche ──
  app.get('/api/events', (_p, q) =>
    store.events(Math.min(1000, Number(q.get('limit') ?? 300)), q.get('shutter') || undefined, q.get('kind') || undefined));
  app.get('/api/stats', (_p, q) => {
    const days = Math.min(90, Math.max(1, Number(q.get('days') ?? 14)));
    return statistics(store, engine.views().map(v => ({ id: v.id, name: v.name, position: v.position })), days);
  });
  app.get('/api/data', () => store.counts());
  app.post('/api/data/reset', (_p, _q, req, b) => {
    if (b?.confirm !== 'CANCELLA') throw new HttpError(400, 'Conferma mancante');
    store.reset();
    engine.log(`Storico e diario azzerati${who(req) ? ` — da ${who(req)}` : ''}`);
    return store.counts();
  });

  if (DEMO) app.post('/api/demo/simulate', (_p, _q, _r, b) => { (home as DemoHome).simulate(String(b?.kind), String(b?.id), b?.value); return { ok: true }; });

  await app.listen(PORT);
  log(`Interfaccia in ascolto sulla porta ${PORT}`);
}

main();
