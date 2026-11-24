// NIDO Tapparelle — interfaccia. Tutti gli URL sono relativi: funziona dentro l'ingress di Home Assistant.
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = ts => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const n1 = v => v == null ? '–' : Number(v).toFixed(1).replace('.', ',');
const isToday = ts => new Date(ts).toDateString() === new Date().toDateString();
const when = ts => isToday(ts) ? hhmm(ts) : new Date(ts).toDateString() === new Date(Date.now() + 864e5).toDateString() ? `domani ${hhmm(ts)}` : `${new Date(ts).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' })} ${hhmm(ts)}`;
const posLabel = p => p == null ? '?' : p <= 0 ? 'chiusa' : p >= 100 ? 'aperta' : `al ${Math.round(p)}%`;
const ORIGIN = { nido: 'NIDO', utente: 'persona', muro: 'pulsante a muro', automazione: 'automazione di HA', sistema: 'sistema' };
const DAYS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];

async function api(path, body) {
  const r = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  return j;
}
function toast(msg, isError = false) {
  const t = $('#toast'); t.textContent = msg; t.className = isError ? 'error' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, isError ? 6000 : 3000);
}
const run = async (fn, ok) => { try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); return r; } catch (e) { toast(e.message, true); throw e; } };

function openDlg(title, sub, html, wide = false) {
  $('#dlg-title').textContent = title; $('#dlg-sub').innerHTML = sub || '';
  $('#dlg-body').innerHTML = `<div class="dlg-pad">${html}</div>`;
  $('#dlg').classList.toggle('wide', wide);
  if (!$('#dlg').open) $('#dlg').showModal();
  return $('#dlg-body');
}
const closeDlg = () => $('#dlg').close();

let ov = null; // ultima panoramica

/* ---------- schede ---------- */
const loaders = {};
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== `tab-${name}`);
  history.replaceState(null, '', `#${name}`);
  loaders[name]?.();
}
const activeTab = () => document.querySelector('.tabs button[aria-selected="true"]').dataset.tab;

/* ---------- intestazione ---------- */
function header() {
  const o = ov.overview;
  const n = ov.shutters.length;
  const open = ov.shutters.filter(s => (s.position ?? 0) >= 95).length, closed = ov.shutters.filter(s => (s.position ?? 100) <= 5).length;
  $('#subtitle').textContent = `${n} tapparelle · ${open} aperte · ${closed} chiuse${ov.demo ? ' · demo' : ''}`;
  const mp = $('#modepill');
  const eff = o.effective, label = o.modeLabel[o.mode];
  mp.hidden = false;
  mp.innerHTML = `<span class="dot ${o.mode === 'pausa' ? 'spento' : 'on'}"></span> ${esc(label)}${o.mode === 'auto' ? ` · ${eff === 'casa' ? '🏠 in casa' : '🚶 fuori'}` : ''}${o.mode === 'vacanza' && o.vacationUntil ? ` fino al ${new Date(o.vacationUntil).toLocaleDateString('it-IT')}` : ''}`;
  const sp = $('#sunpill');
  if (o.sun) {
    sp.hidden = false;
    sp.innerHTML = `${o.sun.elevation > 0 ? '☀️' : '🌙'} ${o.sun.elevation > 0 ? `${Math.round(o.sun.azimuth)}° · alto ${Math.round(o.sun.elevation)}°` : 'sotto l\'orizzonte'}${o.outdoor.temp != null ? ` · ${n1(o.outdoor.temp)} °C` : ''}${o.storm.wind ? ' · 💨 vento forte' : ''}${o.storm.rain ? ' · 🌧 pioggia' : ''}`;
  }
  $('#footer').textContent = `NIDO Tapparelle ${ov.version} · ${ov.ha.kind === 'demo' ? 'modalità demo' : ov.ha.connected ? 'collegata a Home Assistant' : 'Home Assistant non raggiungibile'}${ov.ha.bridge === 'mqtt' ? ' · entità in Home Assistant via MQTT' : ov.ha.bridge === 'rest' ? ' · sensore in Home Assistant (senza MQTT)' : ''}`;
}

$('#modepill').addEventListener('click', () => modeDialog());
function modeDialog() {
  const o = ov.overview;
  const desc = { auto: 'Casa o fuori in base alla presenza delle persone', casa: 'Come se ci fosse qualcuno', fuori: 'Come se la casa fosse vuota', vacanza: 'Casa vuota per più giorni, con simulazione di presenza', pausa: 'NIDO non muove nessuna tapparella' };
  const until = o.vacationUntil ? new Date(o.vacationUntil).toISOString().slice(0, 10) : new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const body = openDlg('Modalità', 'Vale per automazioni, sole e simulazione di presenza', `
    <div class="list">${Object.entries(o.modeLabel).map(([k, v]) => `
      <label class="check"><input type="radio" name="mode" value="${k}" ${o.mode === k ? 'checked' : ''}><span><b>${esc(v)}</b><small>${desc[k]}</small></span></label>`).join('')}
      <label class="f-row" id="vac-row">Vacanza fino al <input type="date" id="vac-until" class="inp" value="${until}"></label>
    </div>
    <div class="dlg-actions"><button class="btn primary" id="mode-save">Imposta</button></div>`);
  body.querySelector('#mode-save').onclick = async () => {
    const mode = body.querySelector('input[name=mode]:checked').value;
    const d = body.querySelector('#vac-until').value;
    await run(() => api('api/mode', { mode, vacationUntil: mode === 'vacanza' && d ? new Date(d + 'T23:59').getTime() : null }), 'Modalità impostata');
    closeDlg(); refresh();
  };
}

/* ---------- tapparelle ---------- */
function win(s, big = false) {
  const p = s.position ?? 50;
  return `<div class="win" ${big ? 'style="min-height:160px;width:90px"' : ''} title="${esc(posLabel(s.position))}">
    <div class="slats" style="height:${100 - p}%"></div>
    ${s.protect ? '<span class="sunray">☀️</span>' : ''}
    <span class="pct">${s.position == null ? '?' : Math.round(s.position) + '%'}</span></div>`;
}

function badges(s) {
  const b = [];
  if (!s.available) b.push('<span class="badge lock">non raggiungibile</span>');
  if (s.moving) b.push(`<span class="badge on">${s.state === 'opening' ? '▲ sale' : '▼ scende'}</span>`);
  if (!s.settings.enabled) b.push('<span class="badge">automazioni spente</span>');
  if (s.hold) b.push(`<span class="badge hold">✋ a mano fino alle ${hhmm(s.hold.until)}<button data-resume="${s.id}">riprendi</button></span>`);
  if (s.protect) b.push(`<span class="badge sun">☀️ ombra (era ${posLabel(s.protect.prevPos)})</span>`);
  else if (s.sun.want) b.push('<span class="badge sun">☀️ sole sulla finestra</span>');
  if (s.contact?.open) b.push(`<span class="badge lock">🚪 ${esc(s.contact.name)} aperta</span>`);
  if (s.pending) b.push(`<span class="badge lock">in attesa: ${posLabel(s.pending.pos)}</span>`);
  return b.join('');
}

function lastMove(s) {
  const m = s.lastMove;
  if (!m) return '';
  return `${(m.to ?? 0) > (m.from ?? 0) ? '▲' : '▼'} ${when(m.ts)} · ${esc(m.origin === 'nido' ? (m.reason || 'NIDO') : m.who || ORIGIN[m.origin])}`;
}

function card(s) {
  return `<div class="card sh ${s.settings.enabled ? '' : 'off'}" data-id="${s.id}">
    ${win(s)}
    <div class="sh-main">
      <div class="sh-head"><div><h2>${esc(s.name)}</h2><small>${esc(s.area ?? 'senza area')} · ${esc(posLabel(s.position))}${s.indoorTemp != null ? ` · ${n1(s.indoorTemp)} °C` : ''}</small></div>
        <button class="gear" data-gear="${s.id}" aria-label="Impostazioni">⚙︎</button></div>
      <div class="badges">${badges(s)}</div>
      ${s.supportsPosition ? `<input type="range" min="0" max="100" step="5" value="${s.position ?? 0}" data-pos="${s.id}" aria-label="Posizione">` : ''}
      <div class="sh-btns">
        <button class="btn" data-cmd="open" title="Apri">▲</button>
        <button class="btn" data-cmd="stop" title="Ferma">■</button>
        <button class="btn" data-cmd="close" title="Chiudi">▼</button>
        ${s.supportsPosition ? `<button class="btn" data-cmd="favorite" title="Posizione preferita (${s.settings.favorite}%)">★</button>` : ''}
      </div>
      <div class="sh-last">${lastMove(s)}</div>
    </div></div>`;
}

const qgrp = (label, target) => `<span class="qgrp"><span>${esc(label)}</span>
  <button data-q="${esc(target)}" data-a="open" title="Apri">▲</button><button data-q="${esc(target)}" data-a="stop" title="Ferma">■</button>
  <button data-q="${esc(target)}" data-a="close" title="Chiudi">▼</button><button data-q="${esc(target)}" data-a="favorite" title="Preferita">★</button></span>`;

function renderShutters() {
  const el = $('#tapparelle');
  if (!ov.shutters.length) {
    el.innerHTML = `<div class="empty"><b>Nessuna tapparella trovata.</b><br>NIDO usa le entità <code>cover.*</code> di Home Assistant (ad esempio quelle create da Zigbee2MQTT).
      Controlla che la tapparella sia abbinata e non disattivata, oppure indicala nell'opzione <code>tapparelle</code> della configurazione dell'app.</div>`;
    return;
  }
  const o = ov.overview;
  const count = new Map();
  for (const s of ov.shutters) if (s.areaId) count.set(s.areaId, [s.area, (count.get(s.areaId)?.[1] ?? 0) + 1]);
  const multiAreas = [...count].filter(([, [, n]]) => n > 1).map(([id, [name]]) => [id, name]);
  const next = o.next[0];
  el.innerHTML = `
    ${ov.demo ? demoBar() : ''}
    <div class="quick">
      <div class="qrow"><b>Tutte</b>${qgrp(`${ov.shutters.length} tapparelle`, 'all')}
        ${ov.groups.map(g => qgrp(`◈ ${g}`, `gruppo:${g}`)).join('')}</div>
      ${multiAreas.length ? `<div class="qrow"><b>Stanze</b>${multiAreas.map(([id, name]) => qgrp(name, `area:${id}`)).join('')}</div>` : ''}
      ${ov.scenes.length ? `<div class="qrow"><b>Scenari</b>${ov.scenes.map(sc => `<button class="scene-chip" data-scene="${sc.id}">${esc(sc.icon)} ${esc(sc.name)}</button>`).join('')}</div>` : ''}
      <div class="qrow"><b>Prossimo</b><span class="note" style="margin:0">${next ? `${when(next.ts)} · ${esc(next.name)} → ${esc(next.text)} (${next.shutters.length} ${next.shutters.length === 1 ? 'tapparella' : 'tapparelle'})` : 'nessun movimento programmato: crea le automazioni nella scheda <a href="#automazioni" data-tab-link="automazioni">Automazioni</a>'}</span></div>
    </div>
    <div class="shutters">${ov.shutters.map(card).join('')}</div>`;
}

function demoBar() {
  return `<div class="demo-bar">Demo — simula:
    <button class="btn small" data-demo="persona" data-id="person.simone">Simone ${ov.overview.presence.people.find(p => p.id === 'person.simone')?.state === 'home' ? 'esce' : 'rientra'}</button>
    <button class="btn small" data-demo="persona" data-id="person.giulia">Giulia ${ov.overview.presence.people.find(p => p.id === 'person.giulia')?.state === 'home' ? 'esce' : 'rientra'}</button>
    <button class="btn small" data-demo="contatto" data-id="binary_sensor.porta_finestra_soggiorno">Apri/chiudi porta-finestra</button>
    <button class="btn small" data-demo="vento">Vento forte</button>
    <span>· nelle impostazioni di ogni tapparella puoi premere il "pulsante a muro"</span></div>`;
}

$('#tapparelle').addEventListener('click', async e => {
  const t = e.target.closest('button, a[data-tab-link]');
  if (!t) return;
  if (t.dataset.tabLink) { e.preventDefault(); return showTab(t.dataset.tabLink); }
  const cardEl = t.closest('.sh');
  if (t.dataset.resume) { await run(() => api(`api/shutters/${t.dataset.resume}/resume`, {}), 'Automazioni riprese'); return refresh(); }
  if (t.dataset.gear) return shutterDialog(t.dataset.gear);
  if (t.dataset.cmd && cardEl) { await run(() => api(`api/shutters/${cardEl.dataset.id}/command`, { action: t.dataset.cmd }), r => r.message); return refreshSoon(); }
  if (t.dataset.q) { await run(() => api('api/command', { targets: [t.dataset.q], action: t.dataset.a }), 'Comando inviato'); return refreshSoon(); }
  if (t.dataset.scene) { await run(() => api(`api/scenes/${t.dataset.scene}/run`, {}), 'Scenario avviato'); return refreshSoon(); }
  if (t.dataset.demo) return demoAction(t.dataset.demo, t.dataset.id);
});
$('#tapparelle').addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.pos) { await run(() => api(`api/shutters/${t.dataset.pos}/command`, { action: 'position', position: Number(t.value) }), r => r.message); refreshSoon(); }
});

async function demoAction(kind, id) {
  if (kind === 'persona') { const p = ov.overview.presence.people.find(x => x.id === id); await api('api/demo/simulate', { kind, id, value: p?.state !== 'home' }); }
  else if (kind === 'contatto') { await api('api/demo/simulate', { kind, id, value: ov.shutters.find(s => s.contact?.entity === id)?.contact?.open ? 0 : 1 }); }
  else if (kind === 'vento') { const v = (ov.overview.outdoor.wind ?? 0) > 40 ? 8 : 70; await api('api/demo/simulate', { kind: 'valore', id: 'sensor.vento', value: v }); toast(`Vento a ${v} km/h`); }
  refreshSoon(800);
}

/* ---------- impostazioni di una tapparella ---------- */
async function shutterDialog(id) {
  const s = ov.shutters.find(x => x.id === id);
  if (!s) return;
  const [st, hist] = await Promise.all([api('api/settings'), api(`api/shutters/${id}/history?days=3`)]);
  const contacts = st.sensors.filter(x => x.role === 'contatto');
  const luxes = st.sensors.filter(x => x.role === 'luce');
  const cs = s.settings;
  const dirOpt = st.directions.map(d => `<option value="${d.deg}" ${cs.orientation === d.deg ? 'selected' : ''}>${d.label} (${d.deg}°)</option>`).join('');
  const custom = cs.orientation != null && !st.directions.some(d => d.deg === cs.orientation);
  const body = openDlg(s.name, `${esc(s.area ?? 'senza area')} · <code>${esc(s.entity)}</code>`, `
    <div style="display:flex;gap:16px;align-items:center;margin-bottom:6px">${win(s, true)}
      <div style="flex:1"><div class="badges">${badges(s)}</div><p class="note">${esc(s.sun.why)}</p>
      ${ov.demo ? `<div class="f-row">Pulsante a muro: <button class="btn small" data-wall="100">▲</button><button class="btn small" data-wall="0">▼</button></div>` : ''}</div></div>
    <div class="form">
      <label class="frow"><span>Automazioni attive<small>NIDO può muoverla (sole, automazioni, meteo)</small></span><span class="toggle"><input type="checkbox" id="f-enabled" ${cs.enabled ? 'checked' : ''}><span></span></span></label>
      <label class="frow"><span>Nome nell'app<small>Vuoto = "${esc(s.haName)}"</small></span><input type="text" id="f-label" value="${esc(cs.label)}" placeholder="${esc(s.haName)}"></label>
      <label class="frow"><span>Gruppo<small>Per comandarle insieme, es. "Zona giorno"</small></span><input type="text" id="f-group" list="groups" value="${esc(cs.group)}"><datalist id="groups">${ov.groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist></label>
      <label class="frow"><span>Posizione preferita ★</span><input type="number" id="f-fav" min="0" max="100" step="5" value="${cs.favorite}"></label>
      <h3 class="m-sec" style="border:0;padding:0;margin:10px 0 0;font-size:13px;color:var(--muted)">SOLE</h3>
      <label class="frow"><span>La finestra guarda verso<small>Serve per capire quando ci batte il sole</small></span>
        <select id="f-orient"><option value="">Non impostato</option>${dirOpt}<option value="custom" ${custom ? 'selected' : ''}>Altro…</option></select></label>
      <label class="frow" id="f-orient-c-row" ${custom ? '' : 'hidden'}><span>Gradi (0 nord, 90 est, 180 sud, 270 ovest)</span><input type="number" id="f-orient-c" min="0" max="359" value="${custom ? cs.orientation : ''}"></label>
      <label class="frow"><span>Posizione d'ombra<small>Quanto aperta quando il sole batte</small></span><input type="number" id="f-shade" min="0" max="100" step="5" value="${cs.shadePos}"></label>
      <label class="frow"><span>Ampiezza del sole sulla finestra<small>Gradi per lato rispetto alla direzione (70 = quasi tutto il giorno sulla facciata)</small></span><input type="number" id="f-width" min="20" max="90" step="5" value="${cs.sunHalfWidth}"></label>
      <label class="frow"><span>Apri col sole d'inverno<small>Apre del tutto se è già socchiusa e il sole batte</small></span><span class="toggle"><input type="checkbox" id="f-winter" ${cs.winterGain ? 'checked' : ''}><span></span></span></label>
      <label class="frow"><span>Sensore di luce della facciata<small>Facoltativo; altrimenti quello esterno</small></span>
        <select id="f-lux"><option value="">Quello esterno</option>${luxes.map(x => `<option value="${x.entity}" ${cs.lux === x.entity ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <h3 class="m-sec" style="border:0;padding:0;margin:10px 0 0;font-size:13px;color:var(--muted)">PORTA O FINESTRA</h3>
      <label class="frow"><span>Contatto<small>Automatico = quello nella stessa area${cs.contact === 'auto' && s.contact ? `: ${esc(s.contact.name)}` : ''}</small></span>
        <select id="f-contact"><option value="auto" ${cs.contact === 'auto' ? 'selected' : ''}>Automatico</option><option value="" ${cs.contact == null ? 'selected' : ''}>Nessuno</option>
        ${contacts.map(x => `<option value="${x.entity}" ${cs.contact === x.entity ? 'selected' : ''}>${esc(x.name)}${x.areaName ? ` (${esc(x.areaName)})` : ''}</option>`).join('')}</select></label>
      <label class="frow"><span>Con la porta aperta<small>Vale per i comandi automatici; dal pulsante a muro comandi sempre tu</small></span>
        <select id="f-lock"><option value="non_chiudere" ${cs.lockout === 'non_chiudere' ? 'selected' : ''}>Non chiudere</option><option value="limita" ${cs.lockout === 'limita' ? 'selected' : ''}>Non scendere sotto…</option><option value="nessuno" ${cs.lockout === 'nessuno' ? 'selected' : ''}>Nessun blocco</option></select></label>
      <label class="frow" id="f-lockpos-row" ${cs.lockout === 'limita' ? '' : 'hidden'}><span>Posizione minima con la porta aperta</span><input type="number" id="f-lockpos" min="0" max="100" step="5" value="${cs.lockoutPos}"></label>
    </div>
    <h3 style="font-size:13px;color:var(--muted);margin:16px 0 6px">ULTIMI MOVIMENTI</h3>
    <div class="next-list">${hist.moves.slice(-12).reverse().map(m => `<div><time>${when(m.ts)}</time><span>${(m.to ?? 0) > (m.from ?? 0) ? '▲' : '▼'} ${posLabel(m.from)} → ${posLabel(m.to)} · ${esc(m.origin === 'nido' ? m.reason || 'NIDO' : m.who || ORIGIN[m.origin])}</span></div>`).join('') || '<span class="note">Nessun movimento negli ultimi 3 giorni</span>'}</div>
    <div class="dlg-actions"><button class="btn primary" id="f-save">Salva</button></div>`);
  const q = sel => body.querySelector(sel);
  q('#f-orient').onchange = () => q('#f-orient-c-row').hidden = q('#f-orient').value !== 'custom';
  q('#f-lock').onchange = () => q('#f-lockpos-row').hidden = q('#f-lock').value !== 'limita';
  body.querySelectorAll('[data-wall]').forEach(b => b.onclick = async () => { await api('api/demo/simulate', { kind: 'muro', id: s.entity, value: Number(b.dataset.wall) }); toast('Pulsante a muro premuto'); closeDlg(); refreshSoon(800); });
  q('#f-save').onclick = async () => {
    const o = q('#f-orient').value;
    const payload = {
      enabled: q('#f-enabled').checked, label: q('#f-label').value, group: q('#f-group').value, favorite: Number(q('#f-fav').value),
      orientation: o === '' ? null : o === 'custom' ? Number(q('#f-orient-c').value) : Number(o),
      shadePos: Number(q('#f-shade').value), sunHalfWidth: Number(q('#f-width').value), winterGain: q('#f-winter').checked,
      lux: q('#f-lux').value || null, contact: q('#f-contact').value === 'auto' ? 'auto' : q('#f-contact').value || null,
      lockout: q('#f-lock').value, lockoutPos: Number(q('#f-lockpos').value),
    };
    await run(() => api(`api/shutters/${id}/settings`, payload), 'Salvato');
    closeDlg(); refresh();
  };
}

/* ---------- aggiornamento ---------- */
async function refresh() {
  try {
    ov = await api('api/overview');
    header();
    if (activeTab() === 'tapparelle' && !document.activeElement?.matches?.('input[type=range]')) renderShutters();
    window.dispatchEvent(new Event('nido:overview'));
  } catch (e) { $('#subtitle').textContent = `Errore: ${e.message}`; }
}
function refreshSoon(ms = 1500) { setTimeout(refresh, ms); setTimeout(refresh, ms + 4000); }
loaders.tapparelle = () => ov && renderShutters();

refresh().then(() => { const h = location.hash.slice(1); if (h && document.querySelector(`.tabs button[data-tab="${h}"]`)) showTab(h); });
setInterval(() => { if (!$('#dlg').open) refresh(); }, 5000);
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== activeTab() && document.querySelector(`.tabs button[data-tab="${h}"]`)) showTab(h); });
