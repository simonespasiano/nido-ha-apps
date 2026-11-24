// Sensori, diario, statistiche e impostazioni.

/* ---------- sensori ---------- */
const ROLE = { contatto: '🚪 Porte e finestre', luce: '🔆 Luce', temperatura: '🌡️ Temperatura', vento: '💨 Vento', pioggia: '🌧 Pioggia', presenza: '🚶 Presenza e movimento', meteo: '🌤 Meteo', umidita: '💧 Umidità' };

async function renderSensors() {
  const el = $('#sensori');
  const [d, st] = await Promise.all([api('api/sensors'), api('api/settings')]);
  const g = st.global, oe = d.outdoor;
  const byRole = {};
  for (const s of d.sensors) (byRole[s.role] ??= []).push(s);
  const sel = (key, role, label, unit) => {
    const list = d.sensors.filter(s => s.role === role);
    const cur = g.outdoor[key];
    const autoName = oe.auto[key] && oe[key] ? d.sensors.find(s => s.entity === oe[key])?.name ?? oe[key] : null;
    return `<label class="frow"><span>${label}<small>${oe[key] ? `in uso: ${esc(d.sensors.find(s => s.entity === oe[key])?.name ?? oe[key])}${oe.auto[key] ? ' (trovato da solo)' : ''}` : 'nessuno'}</small></span>
      <select data-out="${key}"><option value="">Automatico${autoName ? ` (${esc(autoName)})` : ''}</option>${list.map(s => `<option value="${s.entity}" ${cur === s.entity ? 'selected' : ''}>${esc(s.name)}${s.areaName ? ` · ${esc(s.areaName)}` : ''}</option>`).join('')}</select></label>`;
  };
  el.innerHTML = `
    <p class="note">NIDO trova da solo i sensori utili alle tapparelle: appena ne aggiungi uno in Home Assistant compare qui (e nel Diario).
      Il contatto di una porta-finestra viene collegato alla tapparella della stessa area; i sensori senza area o in un'area come "Esterno", "Giardino" o "Balcone" valgono per fuori.</p>
    <div class="two">
      <div class="card"><h2>Sensori esterni</h2><div class="form">
        ${sel('temp', 'temperatura', 'Temperatura esterna')}${sel('lux', 'luce', 'Luce esterna')}${sel('wind', 'vento', 'Vento')}${sel('rain', 'pioggia', 'Pioggia')}${sel('weather', 'meteo', 'Previsioni meteo')}
      </div><div class="dlg-actions"><button class="btn primary" id="out-save">Salva</button></div></div>
      <div class="card"><h2>Porte e finestre collegate</h2>
        <div class="scroll"><table class="mini"><tr><th>Tapparella</th><th>Contatto</th><th></th></tr>
        ${ov.shutters.map(s => `<tr><td>${esc(s.name)}</td><td>${s.contact ? `${s.contact.open ? '🔓' : '🔒'} ${esc(s.contact.name)}${s.contact.auto ? ' <span class="pill">auto</span>' : ''}` : '<span class="note">nessuno</span>'}</td>
          <td><button class="btn small" data-sh="${s.id}">Cambia</button></td></tr>`).join('')}</table></div>
        <p class="note">Con la porta aperta le automazioni non chiudono la tapparella (si cambia nelle impostazioni della tapparella).</p></div>
    </div>
    ${Object.entries(ROLE).filter(([r]) => byRole[r]?.length).map(([r, label]) => `
      <div class="group"><h3>${label} <span class="note">(${byRole[r].length})</span></h3>
      ${byRole[r].map(s => `<div class="ent"><span>${esc(s.name)} ${s.areaName ? `<span class="pill">${esc(s.areaName)}</span>` : '<span class="pill">senza area</span>'}
        ${s.linked.length ? `<span class="pill" style="color:var(--valve)">→ ${esc(s.linked.join(', '))}</span>` : ''}</span>
        <span class="val">${esc(s.state)}${s.unit ? ' ' + esc(s.unit) : ''}</span><span class="id">${esc(s.entity)}</span></div>`).join('')}</div>`).join('')}`;
  el.querySelector('#out-save').onclick = async () => {
    const outdoor = {};
    el.querySelectorAll('[data-out]').forEach(s => outdoor[s.dataset.out] = s.value || null);
    await run(() => api('api/settings', { ...g, outdoor }), 'Sensori salvati'); settingsCache = null; refresh(); renderSensors();
  };
  el.querySelectorAll('[data-sh]').forEach(b => b.onclick = () => shutterDialog(b.dataset.sh));
}
loaders.sensori = () => renderSensors().catch(e => toast(e.message, true));

/* ---------- diario ---------- */
const KIND_IC = { movimento: '↕️', regola: '⏱', scenario: '🎬', sole: '☀️', blocco: '🚪', pausa: '✋', meteo: '🌧', modalita: '🏠', comando: '👆', dispositivi: '🆕', errore: '⚠️', impostazioni: '⚙️', sistema: 'ℹ️' };
async function renderEvents() {
  const sel = $('#ev-shutter');
  if (sel.options.length <= 1 && ov) sel.innerHTML = '<option value="">Tutte</option>' + ov.shutters.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const qs = new URLSearchParams({ limit: 400 });
  if (sel.value) qs.set('shutter', sel.value);
  if ($('#ev-kind').value) qs.set('kind', $('#ev-kind').value);
  const ev = await api(`api/events?${qs}`);
  const name = id => ov?.shutters.find(s => s.id === id)?.name ?? id;
  let day = '', html = '';
  ev.forEach((e, i) => {
    const d = new Date(e.ts).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    if (d !== day) { day = d; html += `<div class="day">${d}</div>`; }
    const last = i === ev.length - 1 || new Date(ev[i + 1].ts).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }) !== d;
    html += `<div class="ev ${last ? 'last' : ''}"><time>${hhmm(e.ts)}</time><span class="ic">${KIND_IC[e.kind] ?? '•'}</span><span>${e.shutter ? `<span class="room">${esc(name(e.shutter))}</span>` : ''}${esc(e.message)}</span></div>`;
  });
  $('#events').innerHTML = html || '<div class="empty">Nessun evento.</div>';
}
$('#ev-shutter').onchange = renderEvents; $('#ev-kind').onchange = renderEvents;
loaders.diario = () => renderEvents().catch(e => toast(e.message, true));

/* ---------- statistiche ---------- */
const OLABEL = { nido: 'NIDO', utente: 'Persone (app, pannello)', muro: 'Pulsante a muro', automazione: 'Automazioni di HA' };
let statDays = 14;
async function renderStats() {
  const s = await api(`api/stats?days=${statDays}`);
  const max = Math.max(1, ...s.perDay.map(d => d.nido + d.utente + d.muro + d.automazione));
  const hmax = Math.max(1, ...s.byHour.map(h => h.su + h.giu));
  const omax = Math.max(1, ...Object.values(s.byOrigin));
  $('#statistiche').innerHTML = `
    <div class="seg casa-range" id="st-range">${[7, 14, 30, 90].map(d => `<button data-d="${d}" class="${d === statDays ? 'on' : ''}">${d} giorni</button>`).join('')}</div>
    <div class="kpis" style="margin:14px 0">
      <div class="kpi"><span>Movimenti</span><b>${s.total}</b><small>${(s.total / s.days).toFixed(1).replace('.', ',')} al giorno</small></div>
      <div class="kpi"><span>Fatti da NIDO</span><b>${s.total ? Math.round(s.byOrigin.nido / s.total * 100) : 0}<small>%</small></b></div>
      <div class="kpi"><span>A mano</span><b>${s.byOrigin.muro + s.byOrigin.utente}</b><small>pulsante a muro e app</small></div>
      <div class="kpi"><span>Più usata</span><b style="font-size:18px">${esc(s.shutters.slice().sort((a, b) => b.moves - a.moves)[0]?.name ?? '–')}</b></div>
    </div>
    <div class="two">
      <div class="card"><h2>Movimenti al giorno</h2>
        <div class="daychart">${s.perDay.map(d => `<div title="${d.day}: ${d.nido + d.utente + d.muro + d.automazione}">${['nido', 'utente', 'muro', 'automazione'].map(o => d[o] ? `<i class="o-${o}" style="height:${d[o] / max * 100}%"></i>` : '').join('')}</div>`).join('')}</div>
        <div class="dayaxis"><span>${s.perDay[0]?.day.slice(5)}</span><span>oggi</span></div>
        <p class="lg">${Object.entries(OLABEL).map(([k, v]) => `<span><i class="o-${k}" style="height:10px;width:10px;border-radius:3px"></i>${v}</span>`).join('')}</p></div>
      <div class="card"><h2>Chi le muove</h2>
        <div class="bars">${Object.entries(OLABEL).map(([k, v]) => `<div class="bar"><span>${v}</span><i class="o-${k}" style="width:${s.byOrigin[k] / omax * 100}%"></i><b>${s.byOrigin[k]}</b></div>`).join('')}</div>
        ${s.byWho.length ? `<p class="note">A mano: ${s.byWho.slice(0, 6).map(w => `${esc(w.who)} (${w.n})`).join(', ')}</p>` : ''}</div>
    </div>
    <div class="card" style="margin-top:14px"><h2>A che ora</h2>
      <div class="daychart" style="height:90px">${s.byHour.map((h, i) => `<div title="${i}:00 — ▲ ${h.su} ▼ ${h.giu}"><i style="height:${h.su / hmax * 100}%;background:var(--c3)"></i><i style="height:${h.giu / hmax * 100}%;background:var(--valve)"></i></div>`).join('')}</div>
      <div class="dayaxis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>
      <p class="lg"><span><i style="background:var(--c3)"></i>salite</span><span><i style="background:var(--valve)"></i>discese</span></p></div>
    <div class="card scroll" style="margin-top:14px"><h2>Per tapparella</h2>
      <table class="mini"><tr><th>Tapparella</th><th>Movimenti</th><th>▲ / ▼</th><th>NIDO</th><th>A mano</th><th>Ore chiusa al giorno</th><th>Posizione media</th></tr>
      ${s.shutters.map(x => `<tr><td>${esc(x.name)}</td><td>${x.moves}</td><td>${x.up} / ${x.down}</td><td>${x.byOrigin.nido}</td><td>${x.byOrigin.muro + x.byOrigin.utente}</td>
        <td>${x.closedHoursPerDay != null ? n1(x.closedHoursPerDay) : '–'}</td><td>${x.avgPosition != null ? x.avgPosition + '%' : '–'}</td></tr>`).join('')}</table></div>`;
  $('#st-range').onclick = e => { const b = e.target.closest('[data-d]'); if (b) { statDays = Number(b.dataset.d); renderStats(); } };
}
loaders.statistiche = () => renderStats().catch(e => toast(e.message, true));

/* ---------- impostazioni ---------- */
async function renderSettings() {
  const [st, data] = await Promise.all([api('api/settings'), api('api/data')]);
  const g = st.global;
  const el = $('#impostazioni');
  el.innerHTML = `
    <div class="two">
      <div class="card"><h2>Comandi a mano</h2>
        <p class="note" style="margin:0">Quando una tapparella viene mossa dal pulsante a muro, dall'app o da Home Assistant, NIDO la lascia stare per un po'.</p>
        <div class="form">
          <label class="frow"><span>Le automazioni riprendono</span><select id="i-hold">
            <option value="prossimo" ${g.holdMode === 'prossimo' ? 'selected' : ''}>al prossimo movimento programmato</option>
            <option value="minuti" ${g.holdMode === 'minuti' ? 'selected' : ''}>dopo un certo tempo</option>
            <option value="mai" ${g.holdMode === 'mai' ? 'selected' : ''}>subito (nessuna pausa)</option></select></label>
          <label class="frow" id="i-min-row" ${g.holdMode === 'minuti' ? '' : 'hidden'}><span>Minuti</span><input type="number" id="i-min" min="5" max="1440" step="5" value="${g.holdMinutes}"></label>
        </div></div>
      <div class="card"><h2>Presenza</h2>
        <p class="note" style="margin:0">In modalità Automatica la casa è "fuori" quando tutte queste persone sono fuori. Chi non ha un dispositivo che ne indica la posizione non viene contato.</p>
        <div class="chips" id="i-people" style="margin-top:8px">${st.allPeople.map(p => `<button type="button" class="chip ${g.people.includes(p.id) ? 'on' : ''}" data-p="${p.id}">${esc(p.name)}</button>`).join('') || '<span class="note">Nessuna persona in Home Assistant</span>'}</div>
        <p class="note">Nessuna selezionata = tutte. Ora: ${st.people.map(p => `${p.state === 'home' ? '🏠' : p.counted ? '🚶' : '❔'} ${esc(p.name)}`).join(' · ') || '—'}</p></div>
      <div class="card"><h2>Vacanza</h2>
        <div class="form">
          <label class="frow"><span>Simula la presenza<small>In vacanza gli orari delle automazioni cambiano ogni giorno</small></span><span class="toggle"><input type="checkbox" id="i-sim" ${g.simulate.enabled ? 'checked' : ''}><span></span></span></label>
          <label class="frow"><span>Variazione massima</span><span><input type="number" id="i-jit" min="0" max="90" step="5" value="${g.simulate.jitter}"> min</span></label>
        </div>
        <p class="note">La modalità Vacanza si attiva dal pulsante della modalità in alto.</p></div>
      <div class="card"><h2>Notifiche</h2>
        <div class="form">
          <label class="frow"><span>Invia a</span><select id="i-svc"><option value="">Nessuna notifica</option>${st.notifyServices.map(s => `<option value="${s}" ${g.notify.service === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="frow"><span>Tapparella non chiusa per porta aperta</span><span class="toggle"><input type="checkbox" id="i-nl" ${g.notify.lockout ? 'checked' : ''}><span></span></span></label>
          <label class="frow"><span>Vento forte e pioggia</span><span class="toggle"><input type="checkbox" id="i-nw" ${g.notify.weather ? 'checked' : ''}><span></span></span></label>
          <label class="frow"><span>Tapparella che non arriva dove deve</span><span class="toggle"><input type="checkbox" id="i-nf" ${g.notify.failure ? 'checked' : ''}><span></span></span></label>
          <label class="frow"><span>Ogni automazione eseguita</span><span class="toggle"><input type="checkbox" id="i-nr" ${g.notify.rules ? 'checked' : ''}><span></span></span></label>
        </div></div>
    </div>
    <div class="au-bar"><button class="btn primary" id="i-save">Salva</button></div>
    <div class="card" style="margin-top:14px"><h2>Dati raccolti</h2>
      <p class="note">${data.moves} movimenti e ${data.events} eventi${data.since ? ` dal ${new Date(data.since).toLocaleDateString('it-IT')}` : ''}. Le impostazioni, gli scenari e le automazioni non vengono toccati.</p>
      <div><button class="btn danger" id="i-reset">Cancella storico e diario</button></div></div>`;
  const q = s => el.querySelector(s);
  q('#i-hold').onchange = () => q('#i-min-row').hidden = q('#i-hold').value !== 'minuti';
  el.querySelectorAll('[data-p]').forEach(b => b.onclick = () => b.classList.toggle('on'));
  q('#i-save').onclick = async () => {
    const ng = { ...g, holdMode: q('#i-hold').value, holdMinutes: Number(q('#i-min').value),
      people: [...el.querySelectorAll('[data-p].on')].map(b => b.dataset.p),
      simulate: { enabled: q('#i-sim').checked, jitter: Number(q('#i-jit').value) },
      notify: { service: q('#i-svc').value || null, lockout: q('#i-nl').checked, weather: q('#i-nw').checked, failure: q('#i-nf').checked, rules: q('#i-nr').checked } };
    await run(() => api('api/settings', ng), 'Impostazioni salvate'); settingsCache = null; refresh(); renderSettings();
  };
  q('#i-reset').onclick = async () => {
    if (!confirm('Cancellare tutti i movimenti e il diario? Non si può annullare.')) return;
    await run(() => api('api/data/reset', { confirm: 'CANCELLA' }), 'Storico cancellato'); renderSettings();
  };
}
loaders.impostazioni = () => renderSettings().catch(e => toast(e.message, true));
