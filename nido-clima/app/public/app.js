// NIDO Clima — interfaccia. Tutti gli URL sono relativi: funziona dentro l'ingress di Home Assistant.
const $ = sel => document.querySelector(sel);
const api = path => fetch(path, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
const n1 = v => v == null ? '–' : Number(v).toFixed(1).replace('.', ',');
const hhmm = ts => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = min => min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
const ago = ts => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'adesso';
  if (m < 60) return `da ${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `da ${h} h ${String(m % 60).padStart(2, '0')}` : `dal ${new Date(ts).toLocaleDateString('it-IT')} ${hhmm(ts)}`;
};

let overview = null;
const roomNames = {};

/* ---------- schede ---------- */
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== `tab-${b.dataset.tab}`);
  loaders[b.dataset.tab]?.();
}));

/* ---------- grafico 24 ore ---------- */
function chart(hist) {
  const W = 320, H = 130, L = 26, R = 6, T = 8, B = 18;
  if (hist.length < 2) return `<svg class="chart" viewBox="0 0 ${W} ${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle">Dati in raccolta…</text></svg>`;
  const t0 = Date.now() - 24 * 3600e3, t1 = Date.now();
  const vals = hist.flatMap(s => [s.tRoom, s.tValve, s.setpoint]).filter(v => v != null);
  let lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
  if (hi - lo < 4) hi = lo + 4;
  const x = ts => L + ((ts - t0) / (t1 - t0)) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = (key, step = false) => {
    let d = '', prev = null;
    for (const s of hist) {
      if (s[key] == null) { prev = null; continue; }
      const X = x(s.ts).toFixed(1), Y = y(s[key]).toFixed(1);
      if (prev == null) d += `M${X},${Y}`;
      else d += step ? `H${X}V${Y}` : `L${X},${Y}`;
      prev = s;
    }
    return d;
  };
  // fasce di accensione
  let bands = '', start = null;
  hist.forEach((s, i) => {
    if (s.heating && start == null) start = s.ts;
    const end = !s.heating || i === hist.length - 1;
    if (start != null && end) {
      bands += `<rect x="${x(start)}" y="${T}" width="${Math.max(1, x(s.ts) - x(start))}" height="${H - T - B}" fill="var(--heat)"/>`;
      start = null;
    }
  });
  const ticks = [];
  const step = (hi - lo) > 10 ? 5 : 2;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const hours = [];
  const first = new Date(t0); first.setMinutes(0, 0, 0);
  for (let t = first.getTime() + 3600e3; t < t1; t += 3600e3) if (new Date(t).getHours() % 6 === 0) hours.push(t);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Andamento 24 ore">
    ${bands}
    ${ticks.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}°</text>`).join('')}
    ${hours.map(t => `<text x="${x(t)}" y="${H - 4}" text-anchor="middle">${String(new Date(t).getHours()).padStart(2, '0')}:00</text>`).join('')}
    <path d="${line('setpoint', true)}" fill="none" stroke="var(--set)" stroke-width="1.2" stroke-dasharray="3 3"/>
    <path d="${line('tValve')}" fill="none" stroke="var(--valve)" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="${line('tRoom')}" fill="none" stroke="var(--room)" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}

/* ---------- stanze ---------- */
// valore di temperatura della scheda; quello usato per capire se il termosifone scalda è evidenziato
const tempFig = (label, value, used, help) =>
  `<div class="fig ${used ? 'used' : ''}" title="${esc(help)}${used ? ' · usata per capire se il termosifone scalda' : ''}">${label}<b>${n1(value)}°${used ? ' <i class="det" aria-label="usata per il rilevamento">◉</i>' : ''}</b></div>`;

async function loadRooms() {
  overview = await api('api/overview');
  overview.rooms.forEach(v => roomNames[v.room.id] = v.room.name);
  $('#subtitle').textContent = `${overview.rooms.length} stanze${overview.demo ? ' · modalità demo (dati simulati)' : ''} · aggiornato alle ${hhmm(overview.updated)}`;

  const p = overview.plant;
  if (p) {
    const el = $('#plant');
    el.hidden = false;
    const cls = p.state === 'acceso' ? 'on' : p.state === 'spento' ? 'spento' : '';
    const txt = p.state === 'acceso' ? 'Impianto acceso' : p.state === 'spento' ? 'Impianto probabilmente spento' : 'Impianto a riposo';
    el.innerHTML = `<span class="dot ${cls}"></span><span title="${esc(p.label)}"><b>${txt}</b> · ${ago(p.since)}</span>`;
  }

  if (!overview.rooms.length) {
    const d = await api('api/diagnosis').catch(() => null);
    const ok = v => v ? `<span title="${esc(v)}">✅ ${esc(v)}</span>` : '<span style="color:var(--warn)">❌ manca</span>';
    const rows = (d?.areas ?? []).map(a => `<tr><td><b>${esc(a.area)}</b></td><td>${ok(a.valve)}</td><td>${a.thermostat ? '✅ ' + esc(a.thermostat) : '–'}</td><td>${ok(a.temp)}</td><td>${a.hum ? '✅ ' + esc(a.hum) : '–'}</td></tr>`).join('');
    const un = d?.unassigned?.length
      ? `<p><b>Senza area</b> (assegnali a una stanza): ${d.unassigned.map(e => `<code>${esc(e)}</code>`).join(', ')}</p>` : '';
    $('#rooms').innerHTML = `<div class="empty"><b>Nessuna stanza trovata.</b> Una stanza nasce quando nella stessa area ci sono una <b>valvola</b> e un <b>sensore di temperatura</b>.
      Assegna i dispositivi in <i>Impostazioni → Dispositivi e servizi → Dispositivi</i> (campo Area), oppure indica le stanze a mano nella configurazione dell'app. Controllo di nuovo ogni minuto finché non trova stanze.
      ${un}
      ${rows ? `<div class="scroll" style="margin-top:12px"><table><thead><tr><th>Area</th><th>Valvola</th><th>Termostato virtuale</th><th>Temperatura</th><th>Umidità</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p>Non ci sono aree in Home Assistant.</p>'}
    </div>`;
    return;
  }

  const histories = await Promise.all(overview.rooms.map(v => api(`api/rooms/${v.room.id}/history?hours=24`).catch(() => [])));
  $('#rooms').innerHTML = overview.rooms.map((v, i) => {
    const s = v.sample || {}, st = v.status;
    const heat = st?.heating;
    const badges = [
      `<span class="badge ${heat ? 'on' : st?.supplyHot ? 'warm' : ''}">${heat ? '🔥 Termosifone caldo' : st?.supplyHot ? 'Valvola chiusa · stanza in temperatura' : 'Termosifone freddo'}</span>`,
      st?.window ? `<span class="badge win">Finestra aperta?</span>` : '',
    ].join('');
    const want = st?.requesting ? ' · chiede calore' : '';
    return `<article class="card">
      <div class="card-head"><h2>${esc(v.room.name)}</h2><div>${badges}</div></div>
      <div class="figures">
        <div class="big" title="Sensore della stanza"><span>${n1(s.tRoom)}<small>°C</small></span><span class="big-lbl">${v.room.valveExternal ? 'Sensore stanza · usato dalla valvola' : 'Sensore stanza'}</span></div>
        <div class="fig-grid">
        <div class="fig">Umidità<b>${s.hRoom == null ? '–' : Math.round(s.hRoom) + ' %'}</b></div>
        <div class="fig">Obiettivo<b>${n1(s.setpoint)}°</b></div>
        ${v.room.valveExternal ? '' : tempFig('Valvola', s.tValveLocal ?? (v.room.valveTempSource === 'valvola' ? s.tValve : null), v.room.valveTempSource === 'valvola', 'Temperatura misurata dalla valvola')}
        ${s.tValveInternal != null || v.room.valveTempSource === 'interna' ? tempFig('Interna valvola', s.tValveInternal ?? s.tValve, v.room.valveTempSource === 'interna', 'Temperatura interna del corpo valvola, vicino al termosifone') : ''}
        ${v.room.valveTempSource === 'manuale' ? tempFig('Sonda', s.tValve, true, 'Sonda indicata nella configurazione') : ''}
        </div>
      </div>
      <p class="reason">${esc(st?.reason ?? '')}${want}</p>
      <div class="chart-wrap" data-zoom="${esc(v.room.id)}" title="Tocca per ingrandire">${chart(histories[i])}<span class="zoom-hint">⤢ Ingrandisci</span></div>
      <div class="meta"><span>Caldo oggi: <b>${dur(v.todayMinutes)}</b></span><span>${st ? (heat ? 'acceso ' : 'spento ') + ago(st.since) : ''} · affidabilità ${st?.confidence ?? '–'}</span></div>
      <div class="card-actions">
        ${s.mode === 'off' ? '<span class="badge">Riscaldamento spento</span>' : '<span></span>'}
        <button class="btn" data-manage="${esc(v.room.id)}">Gestisci</button>
      </div>
    </article>`;
  }).join('');
  fillRoomSelect();
}

function fillRoomSelect() {
  const sel = $('#event-room');
  if (sel.options.length > 1) return;
  Object.entries(roomNames).forEach(([id, name]) => sel.add(new Option(name, id)));
}

/* ---------- diario ---------- */
const ICON = {
  calorifero_on: '🔥', calorifero_off: '❄️', comando: '👆', impianto_on: '🏢', impianto_off: '⏸️',
  finestra: '🪟', obiettivo: '🎯', modalita: '⚙️', sistema: 'ℹ️',
};
async function loadEvents() {
  const room = $('#event-room').value, kind = $('#event-kind').value;
  let evs = await api(`api/events?limit=400${room ? `&room=${room}` : ''}`);
  if (kind) evs = evs.filter(e => kind === 'obiettivo' ? ['obiettivo', 'modalita'].includes(e.kind) : e.kind.startsWith(kind));
  if (!evs.length) { $('#events').innerHTML = `<div class="empty">Nessun evento registrato.</div>`; return; }
  let html = '', lastDay = '';
  evs.forEach((e, i) => {
    const day = new Date(e.ts).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
    const nextDay = evs[i + 1] && new Date(evs[i + 1].ts).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    html += `<div class="ev ${nextDay !== day ? 'last' : ''}"><time>${hhmm(e.ts)}</time><span class="ic">${ICON[e.kind] ?? '•'}</span>
      <span>${e.room ? `<span class="room">${esc(roomNames[e.room] ?? e.room)}</span>` : ''}${esc(e.message)}</span></div>`;
  });
  $('#events').innerHTML = html;
}
$('#event-room').addEventListener('change', loadEvents);
$('#event-kind').addEventListener('change', loadEvents);

/* ---------- statistiche ---------- */
async function loadStats() {
  const stats = await api('api/stats');
  if (!stats.length) { $('#stats').innerHTML = `<div class="empty">Nessuna stanza.</div>`; return; }
  const rate = (v, sign) => v == null ? '<span title="Servono più dati">–</span>' : `${sign && v > 0 ? '+' : ''}${n1(v)} °C/h`;
  $('#stats').innerHTML = `<div class="scroll"><table>
    <thead><tr><th>Stanza</th><th>Caldo oggi</th><th>Ieri</th><th>Ultimi 7 giorni</th><th>Media oggi</th><th>Min / max oggi</th><th>Si scalda</th><th>Si raffredda</th></tr></thead>
    <tbody>${stats.map(s => `<tr>
      <td><b>${esc(s.name)}</b></td>
      <td>${dur(s.minutes.today)}</td><td>${dur(s.minutes.yesterday)}</td><td>${dur(s.minutes.week)}</td>
      <td>${n1(s.today.avgTemp)}°</td><td>${n1(s.today.minTemp)}° / ${n1(s.today.maxTemp)}°</td>
      <td>${rate(s.heatRate, true)}</td><td>${rate(s.coolRate)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

/* ---------- dispositivi ---------- */
async function loadEntities() {
  const ents = await api('api/entities');
  if (!ents.length) { $('#entities').innerHTML = `<div class="empty">Nessun dispositivo climatico trovato.</div>`; return; }
  const groups = {};
  ents.forEach(e => (groups[e.area ?? 'Senza area'] ??= []).push(e));
  $('#entities').innerHTML = Object.entries(groups).map(([area, list]) => `<div class="group"><h3>${esc(area)}</h3>
    ${list.map(e => `<div class="ent"><span><b>${esc(e.name)}</b> <span class="role">· ${esc(e.role)}</span></span>
      <span class="val">${esc(e.state)}${e.unit ? ' ' + esc(e.unit) : ''}</span><span class="id">${esc(e.entity_id)}</span></div>`).join('')}
  </div>`).join('');
}

/* ---------- gestione valvola ---------- */
const PRESET_IT = { none: 'Nessuno', eco: 'Eco', comfort: 'Comfort', boost: 'Boost', away: 'Fuori casa', frost: 'Antigelo', sleep: 'Notte', home: 'A casa', activity: 'Attività', manual: 'Manuale', schedule: 'Programma' };
const MODE_IT = { heat: 'Riscaldamento', off: 'Spento', auto: 'Automatico', cool: 'Raffrescamento', heat_cool: 'Caldo/freddo' };
let managing = null, pendingTemp = null, tempTimer = null;

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = isError ? 'error' : ''; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3500);
}

async function send(action) {
  try {
    const r = await fetch(`api/rooms/${managing}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    toast(j.message);
    setTimeout(() => { renderManage(); loadRooms().catch(() => {}); }, 1500);
  } catch (e) { toast(`Comando non eseguito: ${e.message}`, true); renderManage(); }
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-manage]');
  if (b) { managing = b.dataset.manage; renderManage(true); }
});

function batteryText(v) {
  if (v == null) return '';
  const cls = v < 20 ? 'low' : v < 40 ? 'mid' : '';
  return `<span class="pill ${cls}">🔋 ${Math.round(v)} %</span>`;
}

async function renderManage(open = false) {
  const dlg = $('#manage');
  if (open) { $('#manage-body').innerHTML = '<p class="note">Caricamento…</p>'; dlg.showModal(); }
  let c;
  try { c = await api(`api/rooms/${managing}/controls`); }
  catch (e) { $('#manage-body').innerHTML = `<div class="empty">Impossibile leggere i comandi (${esc(e.message)}).</div>`; return; }
  const t = c.thermostat ?? c.valve;
  $('#manage-title').textContent = roomNames[managing] ?? managing;
  $('#manage-sub').innerHTML = [c.deviceName ? esc(c.deviceName) : '', batteryText(c.battery),
    c.linkquality != null ? `<span class="pill">📶 ${c.linkquality}</span>` : ''].filter(Boolean).join(' ');

  let html = '';
  if (t) {
    const sp = pendingTemp ?? t.setpoint;
    html += `<section class="m-sec">
      <h3>Temperatura desiderata</h3>
      <div class="stepper">
        <button class="btn round" data-step="-1" aria-label="Diminuisci">−</button>
        <div class="sp"><b id="sp-val">${n1(sp)}</b><small>°C</small></div>
        <button class="btn round" data-step="1" aria-label="Aumenta">+</button>
      </div>
      <p class="note center">Ora in stanza ${n1(t.current)} °C · regolata da <b>${esc(t.name)}</b>${c.thermostat ? ' (termostato virtuale)' : ''}</p>
      <h3>Modalità</h3>
      <div class="seg">${t.modes.map(m => `<button class="${m === t.mode ? 'on' : ''}" data-mode="${esc(m)}">${esc(MODE_IT[m] ?? m)}</button>`).join('')}</div>
      ${t.presets.length ? `<h3>Preset</h3><div class="chips">${t.presets.map(p => `<button class="chip ${p === t.preset ? 'on' : ''}" data-preset="${esc(p)}">${esc(PRESET_IT[p] ?? p)}</button>`).join('')}</div>` : ''}
    </section>`;
  }
  if (c.thermostat && c.valve) {
    html += `<section class="m-sec"><h3>Valvola</h3>
      <p class="note">La valvola riceve gli ordini dal termostato virtuale: ora punta a <b>${n1(c.valve.setpoint)} °C</b> e misura <b>${n1(c.valve.current)} °C</b> sul termosifone.
      Non serve regolarla a mano: verrebbe corretta di nuovo.</p></section>`;
  }
  const groups = { principale: 'Funzioni della valvola', configurazione: 'Configurazione', diagnostica: 'Stato e diagnostica' };
  for (const [cat, title] of Object.entries(groups)) {
    const list = c.device.filter(d => d.category === cat);
    if (!list.length) continue;
    html += `<section class="m-sec"><h3>${title}</h3>${list.map(controlRow).join('')}</section>`;
  }
  if (!c.device.length) html += `<p class="note">Nessun'altra funzione esposta dal dispositivo della valvola.</p>`;
  $('#manage-body').innerHTML = html;
}

function controlRow(d) {
  const id = esc(d.entity_id);
  let input = '';
  if (d.kind === 'switch' || d.kind === 'lock') {
    const on = d.state === 'on' || d.state === 'locked';
    input = `<label class="toggle"><input type="checkbox" data-entity="${id}" data-kind="${d.kind}" ${on ? 'checked' : ''} ${['unavailable', 'unknown'].includes(d.state) ? 'disabled' : ''}><span></span></label>`;
  } else if (d.kind === 'select') {
    input = `<select data-entity="${id}" data-kind="select">${(d.options ?? []).map(o => `<option ${o === d.state ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (d.kind === 'number') {
    input = `<span class="numset"><input type="number" value="${esc(d.state)}" ${d.min != null ? `min="${d.min}"` : ''} ${d.max != null ? `max="${d.max}"` : ''} step="${d.step ?? 'any'}" id="n-${id}">
      <button class="btn small" data-number="${id}">Imposta</button></span>`;
  } else if (d.kind === 'button') {
    input = `<button class="btn small" data-press="${id}" data-name="${esc(d.name)}">Avvia</button>`;
  } else {
    input = `<span class="val">${esc(d.state)}${d.unit ? ' ' + esc(d.unit) : ''}</span>`;
  }
  return `<div class="ctl"><div><b>${esc(d.name)}</b>${d.help ? `<small>${esc(d.help)}</small>` : ''}<code>${id}</code></div>${input}</div>`;
}

$('#manage').addEventListener('click', e => {
  const step = e.target.closest('[data-step]');
  if (step) {
    const cur = Number(($('#sp-val').textContent || '0').replace(',', '.'));
    pendingTemp = Math.round((cur + Number(step.dataset.step) * 0.5) * 10) / 10;
    $('#sp-val').textContent = n1(pendingTemp);
    clearTimeout(tempTimer);
    tempTimer = setTimeout(() => { const v = pendingTemp; pendingTemp = null; send({ action: 'set_temperature', value: v }); }, 900);
    return;
  }
  const mode = e.target.closest('[data-mode]');
  if (mode) return send({ action: 'set_mode', value: mode.dataset.mode });
  const preset = e.target.closest('[data-preset]');
  if (preset) return send({ action: 'set_preset', value: preset.dataset.preset });
  const num = e.target.closest('[data-number]');
  if (num) return send({ action: 'entity', entity_id: num.dataset.number, value: Number(document.getElementById(`n-${num.dataset.number}`).value) });
  const press = e.target.closest('[data-press]');
  if (press && confirm(`Avviare "${press.dataset.name}"?`)) return send({ action: 'entity', entity_id: press.dataset.press });
});
$('#manage').addEventListener('change', e => {
  const el = e.target;
  if (!el.dataset.entity) return;
  const value = el.dataset.kind === 'select' ? el.value : el.checked;
  send({ action: 'entity', entity_id: el.dataset.entity, value });
});
$('#manage').addEventListener('close', () => { managing = null; pendingTemp = null; });

const loaders = { stanze: loadRooms, diario: loadEvents, statistiche: loadStats, dispositivi: loadEntities, soglie: () => window.loadThresholds?.() };

const refresh = () => {
  const active = document.querySelector('.tabs button[aria-selected="true"]').dataset.tab;
  if (active !== 'dispositivi' && active !== 'soglie') loaders[active]().catch(err => { $('#subtitle').textContent = `Errore di collegamento (${err.message})`; });
};
loadRooms().then(() => api('api/settings')).then(s => {
  $('#footer').textContent = `NIDO Clima ${overview.version} · soglie calorifero: acceso sopra +${n1(s.soglia_accensione)} °C, spento sotto +${n1(s.soglia_spegnimento)} °C · stanze ${s.stanze_manuali ? 'configurate a mano' : 'riconosciute dalle aree'}`;
}).catch(err => { $('#subtitle').textContent = `Errore di collegamento (${err.message})`; });
setInterval(refresh, 30000);
