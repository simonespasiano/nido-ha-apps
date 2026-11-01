/* NIDO Pulizie: nucleo dell'interfaccia e scheda Robot */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = path => fetch(path, { cache: 'no-store' }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
const post = (path, body = {}) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = error ? 'error' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}

const nf1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
const fmtMin = s => s == null ? '–' : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;
const fmtTime = ts => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const fmtDate = ts => new Date(ts).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
function ago(ts) {
  if (!ts) return 'mai';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'adesso';
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ${h === 1 ? 'ora' : 'ore'} fa`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ieri' : `${d} giorni fa`;
}

const App = window.App = { ov: null, map: null, mapFetchedAt: null, selected: new Set(), clean: null, tab: 'robot', hooks: {} };

// ── schede ──
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.tab').forEach(s => (s.hidden = s.id !== `tab-${b.dataset.tab}`));
  App.tab = b.dataset.tab;
  App.hooks[App.tab]?.();
  if (App.tab === 'robot') drawMap();
}));
document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

// ── aggiornamento periodico ──
let timer;
async function refresh() {
  clearTimeout(timer);
  try {
    const ov = await api('api/overview');
    App.ov = ov;
    if (ov.mapFetchedAt && ov.mapFetchedAt !== App.mapFetchedAt) {
      App.map = await api('api/map').catch(() => null);
      App.mapFetchedAt = ov.mapFetchedAt;
    }
    if (!App.clean) App.clean = { ...ov.defaults };
    renderHeader(ov);
    if (App.tab === 'robot') renderRobot(ov);
    App.hooks.overview?.(ov);
  } catch (e) {
    $('#subtitle').textContent = `Server non raggiungibile (${e.message})`;
  }
  const busy = App.ov?.live || ['pulizia', 'rientro', 'pausa'].includes(App.ov?.robot?.activity);
  timer = setTimeout(refresh, busy ? 2000 : 5000);
}
App.refresh = refresh;

function renderHeader(ov) {
  const r = ov.robot;
  $('#subtitle').textContent = `${r.model ?? 'Narwal'}${r.firmware ? ` · ${r.firmware}` : ''}${ov.demo ? ' · demo con robot simulato' : ''}`;
  const pill = $('#status-pill');
  pill.hidden = false;
  const cls = !r.online ? 'bad' : r.activity === 'errore' ? 'bad' : ['pulizia', 'rientro', 'mappatura'].includes(r.activity) ? 'on' : r.activity === 'pausa' ? 'warn' : '';
  pill.innerHTML = `<span class="dot ${cls}"></span>${r.online ? esc(r.label) : 'Non collegato'}${r.battery != null ? ` · ${r.battery}%` : ''}`;
  $('#footer').textContent = `NIDO Pulizie ${ov.version} · ${ov.ha.kind === 'demo' ? 'casa simulata' : ov.ha.connected ? 'collegata a Home Assistant' : 'Home Assistant non raggiungibile'}${ov.ha.bridge === 'mqtt' ? ' · entità via MQTT' : ov.ha.bridge === 'rest' ? ' · sensori via REST' : ''}`;
}

// ── scheda Robot ──
function renderRobot(ov) {
  const r = ov.robot;
  const banner = $('#banner');
  if (!ov.configured) banner.innerHTML = `<div class="banner"><b>Indirizzo del robot non impostato</b>Apri Impostazioni → App → NIDO Pulizie → Configurazione e inserisci l'IP fisso del Narwal (es. 192.168.1.50), poi riavvia l'app.</div>`;
  else if (!r.online) banner.innerHTML = `<div class="banner bad"><b>Robot non collegato</b>${esc(ov.error ?? 'Tentativo di connessione in corso…')}<br><span class="note">Il robot accetta una sola connessione locale: chiudi l'app Narwal sul telefono e disattiva altre integrazioni Narwal in Home Assistant.</span></div>`;
  else if (r.errors?.length) banner.innerHTML = `<div class="banner bad"><b>Il robot segnala un problema</b>Codici: ${r.errors.join(', ')}. Controlla il robot o l'app Narwal per il dettaglio.</div>`;
  else banner.innerHTML = '';

  const bat = r.battery ?? null;
  const live = ov.live;
  const cleaning = ['pulizia', 'pausa', 'rientro', 'mappatura'].includes(r.activity);
  const L = ov.labels;
  const roomName = id => ov.rooms.find(x => x.id === id)?.name ?? `Stanza ${id}`;
  const act = (name, label, disabled = false, cls = '') => `<button class="btn ${cls}" data-act="${name}" ${disabled || !r.online ? 'disabled' : ''}>${label}</button>`;
  $('#status-card').innerHTML = `
    <div class="card-head"><h2>Stato</h2><span class="pill ${r.awake ? 'on' : ''}">${r.online ? (r.awake ? 'sveglio' : 'a riposo') : 'offline'}</span></div>
    <div class="state-big">${esc(r.online ? r.label : 'Non collegato')}</div>
    <div class="battery"><span>Batteria</span><div class="bar"><i class="${bat == null ? '' : bat < 20 ? 'low' : bat < 40 ? 'mid' : ''}" style="width:${bat ?? 0}%"></i></div><b>${bat == null ? '–' : bat + '%'}</b></div>
    ${live ? `
      <div class="progress" title="Avanzamento"><i style="width:${r.progress ?? 0}%"></i></div>
      <div class="facts">
        <div>Stanza<b>${r.currentRoomId ? esc(roomName(r.currentRoomId)) : '–'}</b></div>
        <div>Avanzamento<b>${r.progress != null ? r.progress + '%' : '–'}</b></div>
        <div>Superficie<b>${r.area != null ? nf1.format(r.area) + ' m²' : '–'}</b></div>
        <div>Tempo<b>${fmtMin(r.elapsed)}${r.remaining ? ` <small>· ancora ${fmtMin(r.remaining)}</small>` : ''}</b></div>
      </div>
      <p class="note">Avviata da ${esc(live.source)} alle ${fmtTime(live.start)}${live.visited.length ? ` · passata da ${live.visited.map(roomName).map(esc).join(', ')}` : ''}</p>` : `
      <div class="facts">
        <div>Aspirazione<b>${L.fan[r.fan] ?? '–'}</b></div>
        <div>Acqua<b>${L.water[r.water] ?? '–'}</b></div>
        <div>Sulla base<b>${r.docked ? 'sì' : 'no'}</b></div>
        <div>Ultima pulizia<b>${esc(lastClean(ov))}</b></div>
      </div>`}
    <div class="actions">
      ${r.activity === 'pausa' ? act('riprendi', '▶ Riprendi', false, 'primary') : act('pausa', '❚❚ Pausa', r.activity !== 'pulizia')}
      ${act('base', '⌂ Torna alla base', r.docked)}
      ${act('stop', '■ Termina', !cleaning)}
      ${act('trova', '🔔 Trova')}
    </div>
    <h3>Durante la pulizia</h3>
    <div class="ctl-row"><span>Aspirazione</span><div class="seg" data-set="aspirazione">${[1, 2, 3, 4].map(n => `<button data-v="${n}" class="${r.fan === n ? 'on' : ''}" ${r.online ? '' : 'disabled'}>${L.fan[n]}</button>`).join('')}</div></div>
    <div class="ctl-row"><span>Acqua</span><div class="seg" data-set="acqua">${[1, 2, 3].map(n => `<button data-v="${n}" class="${r.water === n ? 'on' : ''}" ${r.online ? '' : 'disabled'}>${L.water[n]}</button>`).join('')}</div></div>
    <h3>Base</h3>
    <div class="actions small">${act('lava_mop', 'Lava mop', !r.docked)}${act('asciuga_mop', 'Asciuga', !r.docked)}${act('svuota', 'Svuota', !r.docked)}</div>`;

  renderDemo(ov);
  renderRoomList(ov);
  renderCleanPanel(ov);
  drawMap();
}

function lastClean(ov) {
  const ts = Math.max(0, ...ov.rooms.map(r => r.lastCleaned ?? 0));
  return ts ? ago(ts) : 'mai';
}

$('#status-card').addEventListener('click', async ev => {
  const b = ev.target.closest('button');
  if (!b || b.disabled) return;
  const seg = b.closest('[data-set]');
  const name = seg ? seg.dataset.set : b.dataset.act;
  if (!name) return;
  b.disabled = true;
  try {
    const r = await post('api/action', { name, value: seg ? Number(b.dataset.v) : undefined });
    toast(r.ok ? 'Comando inviato' : `Il robot ha risposto: ${r.message}`, !r.ok);
  } catch (e) { toast(e.message, true); }
  refresh();
});

function drawMap() {
  const ov = App.ov, map = App.map, canvas = $('#map');
  if (!map || !ov) { $('#map-note').textContent = ov?.robot?.online ? 'Mappa in arrivo…' : 'Mappa non disponibile'; return; }
  const r = ov.robot;
  const robot = ov.live && r.positionPx ? r.positionPx : map.dock ? { x: map.dock.x, y: map.dock.y + 2, heading: Math.PI / 2 } : null;
  const dim = new Set(ov.rooms.filter(x => x.occupied).map(x => x.id));
  NidoMap.draw(canvas, map, { selected: App.selected, path: ov.live?.path, robot, dim, maxHeight: Math.min(560, window.innerHeight * 0.6) });
  $('#map-note').textContent = ov.live ? 'Percorso della pulizia in corso' : 'Tocca le stanze da pulire';
}
window.addEventListener('resize', () => App.tab === 'robot' && drawMap());

$('#map').addEventListener('click', ev => {
  const room = NidoMap.roomAt($('#map'), ev);
  if (!room) return;
  App.selected.has(room.id) ? App.selected.delete(room.id) : App.selected.add(room.id);
  renderRoomList(App.ov); renderCleanPanel(App.ov); drawMap();
});
$('#map').addEventListener('mousemove', ev => {
  const room = NidoMap.roomAt($('#map'), ev), tip = $('#map-tip');
  if (!room) { tip.hidden = true; return; }
  const info = App.ov.rooms.find(r => r.id === room.id);
  tip.innerHTML = `<b>${esc(room.name)}</b>${room.area ? ` · ${nf1.format(room.area)} m²` : ''}<br>Pulita ${ago(info?.lastCleaned)}${info?.occupied ? '<br>⚠ presenza rilevata' : ''}`;
  const rect = $('#map').getBoundingClientRect();
  tip.style.left = `${Math.min(ev.clientX - rect.left + 12, rect.width - 160)}px`;
  tip.style.top = `${ev.clientY - rect.top + 12}px`;
  tip.hidden = false;
});
$('#map').addEventListener('mouseleave', () => ($('#map-tip').hidden = true));

function renderRoomList(ov) {
  if (!App.map) { $('#room-list').innerHTML = ''; return; }
  $('#room-list').innerHTML = ov.rooms.map(r => `
    <button class="chip room-chip ${App.selected.has(r.id) ? 'on' : ''}" data-room="${r.id}" title="Pulita ${ago(r.lastCleaned)}">
      <i style="background:${NidoMap.roomColor(App.map, r.id)}"></i>${esc(r.name)}
      <small>${r.lastCleaned ? ago(r.lastCleaned) : 'mai'}</small>${r.occupied ? '<span class="occ" title="Presenza rilevata">●</span>' : ''}
    </button>`).join('');
}
$('#room-list').addEventListener('click', ev => {
  const b = ev.target.closest('[data-room]');
  if (!b) return;
  const id = Number(b.dataset.room);
  App.selected.has(id) ? App.selected.delete(id) : App.selected.add(id);
  renderRoomList(App.ov); renderCleanPanel(App.ov); drawMap();
});

function settingsControls(s, L, prefix) {
  const sel = (key, table, keys) => `<select data-${prefix}="${key}">${keys.map(k => `<option value="${k}" ${Number(s[key]) === k ? 'selected' : ''}>${table[k]}</option>`).join('')}</select>`;
  const mop = s.mode !== 1, vac = s.mode !== 2;
  return `<div class="opts">
    <label>Modalità ${sel('mode', L.mode, [4, 3, 1, 2])}</label>
    <label>Aspirazione ${vac ? sel('fan', L.fan, [1, 2, 3, 4, 5]) : '<select disabled><option>–</option></select>'}</label>
    <label>Acqua ${mop ? sel('water', L.water, [1, 2, 3]) : '<select disabled><option>–</option></select>'}</label>
    <label>Lavaggio ${mop ? sel('strength', L.strength, [1, 2]) : '<select disabled><option>–</option></select>'}</label>
    <label>Passaggi ${sel('passes', { 1: '1', 2: '2', 3: '3' }, [1, 2, 3])}</label>
    <label>Percorso ${sel('route', L.route, [1, 2])}</label>
  </div>`;
}
App.settingsControls = settingsControls;
App.readSettings = (root, prefix) => {
  const s = {};
  root.querySelectorAll(`[data-${prefix}]`).forEach(el => (s[el.dataset[prefix]] = Number(el.value)));
  return s;
};

function renderCleanPanel(ov) {
  const panel = $('#clean-panel');
  if (!App.map) { panel.innerHTML = ''; return; }
  const n = App.selected.size;
  const docked = ov.robot.docked && ov.robot.online;
  const busy = !!ov.live;
  panel.innerHTML = `
    ${settingsControls(App.clean, ov.labels, 'cl')}
    <div class="go">
      <button class="btn primary" id="go-rooms" ${!n || !docked || busy ? 'disabled' : ''}>Pulisci ${n ? `${n} ${n === 1 ? 'stanza' : 'stanze'}` : 'le stanze scelte'}</button>
      <button class="btn" id="go-all" ${!docked || busy ? 'disabled' : ''}>Tutta la casa</button>
      ${n ? '<button class="btn small" id="go-clear">Deseleziona</button>' : ''}
      <span class="note">${busy ? 'Pulizia in corso.' : !ov.robot.online ? '' : !docked ? 'La pulizia per stanze parte solo con il robot sulla base.' : ''}</span>
    </div>`;
}
$('#clean-panel').addEventListener('change', ev => {
  if (!ev.target.dataset.cl) return;
  App.clean = { ...App.clean, ...App.readSettings($('#clean-panel'), 'cl') };
  renderCleanPanel(App.ov);
});
$('#clean-panel').addEventListener('click', async ev => {
  const id = ev.target.id;
  if (id === 'go-clear') { App.selected.clear(); renderRoomList(App.ov); renderCleanPanel(App.ov); drawMap(); return; }
  if (id !== 'go-rooms' && id !== 'go-all') return;
  ev.target.disabled = true;
  try {
    const r = await post('api/clean', { rooms: id === 'go-all' ? [] : [...App.selected], settings: App.clean });
    toast(r.ok ? 'Pulizia avviata' : `Il robot ha rifiutato: ${r.message}`, !r.ok);
    if (r.ok) App.selected.clear();
  } catch (e) { toast(e.message, true); }
  refresh();
});

function renderDemo(ov) {
  const card = $('#demo-card');
  if (!ov.demo) { card.hidden = true; return; }
  card.hidden = false;
  card.innerHTML = `<div class="card-head"><h2>Casa simulata</h2><span class="pill">solo demo</span></div>
    <p class="note">Per provare i programmi: chi è in casa e dove c'è qualcuno.</p>
    <div class="chips">${ov.people.map(p => `<button class="chip ${p.home ? 'on' : ''}" data-person="${p.id}" data-home="${p.home}">${esc(p.name)}: ${p.home ? 'in casa' : 'fuori'}</button>`).join('')}</div>
    <div class="chips">${ov.rooms.filter(r => r.haArea).map(r => `<button class="chip ${r.occupied ? 'on' : ''}" data-area="${r.haArea}">${esc(r.name)}${r.occupied ? ' · presenza' : ''}</button>`).join('')}</div>`;
}
$('#demo-card').addEventListener('click', async ev => {
  const p = ev.target.closest('[data-person]'), a = ev.target.closest('[data-area]');
  if (p) await post('api/demo/person', { id: p.dataset.person, home: p.dataset.home !== 'true' });
  if (a) await post('api/demo/area', { id: a.dataset.area });
  refresh();
});

refresh();
