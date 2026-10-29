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
      `<span class="badge ${heat ? 'on' : ''}">${heat ? '🔥 Termosifone caldo' : 'Termosifone freddo'}</span>`,
      st?.window ? `<span class="badge win">Finestra aperta?</span>` : '',
    ].join('');
    const want = st?.requesting ? ' · chiede calore' : '';
    return `<article class="card">
      <div class="card-head"><h2>${esc(v.room.name)}</h2><div>${badges}</div></div>
      <div class="figures">
        <div class="big">${n1(s.tRoom)}<small>°C</small></div>
        <div class="fig">Umidità<b>${s.hRoom == null ? '–' : Math.round(s.hRoom) + ' %'}</b></div>
        <div class="fig">Obiettivo<b>${n1(s.setpoint)}°</b></div>
        <div class="fig">Termosifone<b>${n1(s.tValve)}°</b></div>
      </div>
      <p class="reason">${esc(st?.reason ?? '')}${want}</p>
      ${chart(histories[i])}
      <div class="meta"><span>Caldo oggi: <b>${dur(v.todayMinutes)}</b></span><span>${st ? (heat ? 'acceso ' : 'spento ') + ago(st.since) : ''} · affidabilità ${st?.confidence ?? '–'}</span></div>
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
  calorifero_on: '🔥', calorifero_off: '❄️', impianto_on: '🏢', impianto_off: '⏸️',
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

const loaders = { stanze: loadRooms, diario: loadEvents, statistiche: loadStats, dispositivi: loadEntities };

const refresh = () => {
  const active = document.querySelector('.tabs button[aria-selected="true"]').dataset.tab;
  if (active !== 'dispositivi') loaders[active]().catch(err => { $('#subtitle').textContent = `Errore di collegamento (${err.message})`; });
};
loadRooms().then(() => api('api/settings')).then(s => {
  $('#footer').textContent = `NIDO Clima ${overview.version} · soglie calorifero: acceso sopra +${n1(s.soglia_accensione)} °C, spento sotto +${n1(s.soglia_spegnimento)} °C · stanze ${s.stanze_manuali ? 'configurate a mano' : 'riconosciute dalle aree'}`;
}).catch(err => { $('#subtitle').textContent = `Errore di collegamento (${err.message})`; });
setInterval(refresh, 30000);
