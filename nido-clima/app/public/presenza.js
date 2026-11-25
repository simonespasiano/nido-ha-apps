// NIDO Clima — barra della presenza, sempre visibile sopra le schede: modalità della casa e presenza
// di ogni persona, correggibili a mano subito quando la posizione del telefono sbaglia.
(() => {
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
  const MODES = ['auto', 'casa', 'fuori', 'notte', 'vacanza'];
  const MODE_ICON = { casa: '🏠', fuori: '🚶', notte: '🌙', vacanza: '🧳' };
  const DUR = [['0', 'finché non la cambio'], ['4', 'per 4 ore'], ['12', 'per 12 ore'], ['24', 'per 24 ore'], ['72', 'per 3 giorni'], ['168', 'per 7 giorni']];
  let data = null, hours = '0';
  let open = false; const det = new Set();
  try { open = localStorage.getItem('nido-pz-open') === '1'; } catch { }
  const when = ts => new Date(ts).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  window.loadPresenza = async () => { data = await api('api/presence'); render(); };
  const apply = j => { data = j; render(); if (window.loadAutomazioni && !document.getElementById('tab-automazioni').hidden) window.loadAutomazioni(); };

  function gps(p) {
    if (!p.trackers) return '❔ nessun telefono';
    if (['unknown', 'unavailable'].includes(p.state)) return '❔ posizione sconosciuta';
    return p.gpsHome ? '🏠 in casa' : `🚶 ${p.state === 'not_home' ? 'fuori' : esc(p.state)}`;
  }

  const km = m => m == null ? '–' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  const ago = iso => { if (!iso) return '–'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 1 ? 'adesso' : m < 60 ? `${m} min fa` : m < 1440 ? `${Math.round(m / 60)} h fa` : `${Math.round(m / 1440)} g fa`; };
  const map = (lat, lon) => lat == null ? '' : `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}" target="_blank" rel="noopener">mappa</a>`;
  const stateIt = s => s === 'home' ? '🏠 in casa' : s === 'not_home' ? '🚶 fuori' : ['unknown', 'unavailable', 'non trovato'].includes(s) ? `❔ ${s === 'non trovato' ? 'non trovato' : 'sconosciuta'}` : `📍 ${esc(s)}`;

  /** Da dove arriva la posizione di una persona, con i motivi più comuni di errore. */
  function detail(p) {
    const D = data.detail, d = D?.people.find(x => x.id === p.id);
    if (!d) return '<p class="note">Dettagli della posizione non disponibili.</p>';
    const home = D.home, tips = [];
    const src = d.trackers.find(t => t.isSource);
    const saysHome = d.trackers.filter(t => t.state === 'home');
    if (d.state !== 'home' && saysHome.length && src && src.state !== 'home')
      tips.push(`<b>${esc(saysHome.map(t => t.name).join(', '))}</b> dice "in casa", ma la persona segue <b>${esc(src.name)}</b>, il dispositivo aggiornato più di recente. Se è l'auto, un tablet o un vecchio telefono, toglilo dalla persona in Home Assistant: <i>Impostazioni → Persone → ${esc(p.name)}</i>.`);
    if (d.trackers.length > 1 && !tips.length) tips.push(`Alla persona sono collegati ${d.trackers.length} dispositivi: lo stato lo decide quello aggiornato più di recente (★). Collega solo il telefono che porti sempre con te.`);
    for (const t of d.trackers) {
      if (t.state !== 'home' && home && t.distance != null && t.distance <= home.radius * 2.5) tips.push(`${esc(t.name)} è a ${km(t.distance)} da casa, appena fuori dal raggio della zona Casa (${home.radius} m): allarga la zona in <i>Impostazioni → Aree, etichette e zone → Zone → Casa</i>, per esempio a 150–200 m.`);
      if (t.accuracy != null && home && t.accuracy > home.radius) tips.push(`La precisione di ${esc(t.name)} è di ${t.accuracy} m, peggiore del raggio della zona Casa (${home.radius} m): la posizione può "saltare" fuori.`);
      if (t.state !== 'home' && t.updated && Date.now() - new Date(t.updated).getTime() > 2 * 3600_000) tips.push(`${esc(t.name)} non aggiorna la posizione da ${ago(t.updated).replace(' fa', '')}: nell'app Companion controlla che la posizione sia su <b>Sempre</b> e l'aggiornamento in background attivo.`);
    }
    if (!d.trackers.length) tips.push('Nessun dispositivo collegato: la persona non ha una posizione.');
    return `<div class="pz-det">
      <p class="note">Stato in Home Assistant: <b>${stateIt(d.state)}</b>, aggiornato ${ago(d.updated)}${d.distance != null ? ` · a ${km(d.distance)} da casa` : ''}${home ? ` · zona Casa: raggio ${home.radius} m ${map(home.lat, home.lon)}` : ''}</p>
      <div class="pz-trk">${d.trackers.map(t => `<div class="${t.isSource ? 'src' : ''}">
        <b>${t.isSource ? '★ ' : ''}${esc(t.name)}</b> <small>${esc(t.id)}${t.sourceType ? ` · ${esc(t.sourceType)}` : ''}${t.isSource ? ' · decide lo stato' : ''}</small><br>
        ${stateIt(t.state)} · ${km(t.distance)} da casa · precisione ${t.accuracy != null ? `${t.accuracy} m` : '–'} · ${ago(t.updated)} ${map(t.lat, t.lon)}
        ${t.address ? `<br>📍 ${esc(t.address)}` : ''}</div>`).join('')}</div>
      ${tips.length ? `<ul class="pz-tips">${tips.map(t => `<li>${t}</li>`).join('')}</ul>` : ''}
      <p class="note">L'indirizzo è quello calcolato dal telefono (sensore <i>geocoded location</i> dell'app Companion). Il link "mappa" apre OpenStreetMap solo se lo tocchi. Ogni cambio di stato finisce nel Diario con dispositivo e distanza.</p>
    </div>`;
  }

  function render() {
    const el = document.getElementById('presenza');
    if (!el || !data) return;
    const h = data.house, L = data.labels;
    const manual = h.all.filter(p => p.manual);
    const forcedMode = h.houseMode !== 'auto';
    const meP = h.all.find(p => p.id === data.me);
    // scorciatoia: la casa è su Fuori per la posizione ma chi guarda è a casa
    const quick = h.houseMode === 'auto' && (h.mode === 'fuori' || h.empty) && meP && !meP.home;
    el.innerHTML = `<div class="pz ${h.mode === 'fuori' ? 'away' : ''}">
      <div class="pz-sum">
        <span class="pz-mode">${MODE_ICON[h.mode] ?? ''} ${esc(L.modes[h.mode])}</span>
        <span class="pz-why">${esc(h.why)}</span>
        ${forcedMode ? '<span class="badge warm">✋ modalità a mano</span>' : ''}
        ${manual.length ? `<span class="badge warm">✋ presenza a mano: ${manual.map(p => esc(p.name)).join(', ')}</span>` : ''}
        ${!data.enabled ? '<span class="badge">automazioni sospese</span>' : ''}
        <span class="pz-sp"></span>
        ${quick ? '<button class="btn small primary" data-pz-me="casa">Sono a casa</button>' : ''}
        <button class="btn small" data-pz-toggle>${open ? 'Chiudi' : 'Presenza…'}</button>
      </div>
      ${open ? `<div class="pz-body">
        <h3>Modalità della casa</h3>
        <div class="seg wrap">${MODES.map(m => `<button class="${h.houseMode === m ? 'on' : ''}" data-pz-mode="${m}">${esc(L.modes[m])}</button>`).join('')}</div>
        ${h.houseMode === 'vacanza' ? `<div class="f-row"><label>Fino al <input type="date" data-pz-vac value="${h.vacationUntil ? new Date(h.vacationUntil).toISOString().slice(0, 10) : ''}"></label><span class="note">poi torna automatica</span></div>` : ''}
        <p class="note">${h.houseMode === 'auto' ? 'Automatica: la casa va su Fuori quando tutte le persone che contano sono fuori. Si cambia subito, senza salvare.' : 'Scelta a mano: resta così finché non torni su <b>Automatica</b>.'}</p>
        <h3>Persone</h3>
        ${h.all.length ? `<div class="pz-people">${h.all.map(p => `<div class="pz-p">
          <div><b>${esc(p.name)}</b>${p.id === data.me ? ' <small>(tu)</small>' : ''}<br>
            <small>Home Assistant: ${gps(p)} · <a href="#" data-pz-det="${esc(p.id)}">${det.has(p.id) ? 'nascondi posizione' : 'da dove arriva?'}</a>${p.manual ? ` · <b>a mano: ${esc(L.presence[p.manual.state])}</b> ${p.manual.until ? `fino a ${when(p.manual.until)}` : 'finché non la cambi'}${p.manual.by ? ` (da ${esc(p.manual.by)})` : ''}` : ''}</small></div>
          <div class="seg">${[['auto', 'Dal telefono'], ['casa', 'In casa'], ['fuori', 'Fuori'], ['ignora', 'Non conta']].map(([k, l]) =>
            `<button class="${(p.manual?.state ?? 'auto') === k ? 'on' : ''}" data-pz-person="${esc(p.id)}" data-pz-state="${k}">${l}</button>`).join('')}</div>
          ${det.has(p.id) ? detail(p) : ''}
        </div>`).join('')}</div>
        <div class="f-row"><label>Una scelta a mano vale <select data-pz-hours>${DUR.map(([v, l]) => `<option value="${v}" ${v === hours ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
        <p class="note">Usalo quando la posizione del telefono sbaglia: la scelta a mano vale al posto del telefono. <b>Non conta</b> esclude la persona dal calcolo, come se non avesse il telefono.</p>`
        : '<p class="note">Nessuna persona considerata in Home Assistant.</p>'}
      </div>` : ''}
    </div>`;
  }

  document.addEventListener('click', async e => {
    const el = document.getElementById('presenza');
    if (!el?.contains(e.target)) return;
    const a = e.target.closest('[data-pz-det]');
    if (a) { e.preventDefault(); const id = a.dataset.pzDet; det.has(id) ? det.delete(id) : det.add(id); render(); return; }
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.hasAttribute('data-pz-toggle')) { open = !open; try { localStorage.setItem('nido-pz-open', open ? '1' : '0'); } catch { } render(); }
      else if (b.dataset.pzMode) apply(await post('api/automations/mode', { mode: b.dataset.pzMode }));
      else if (b.dataset.pzPerson) {
        const st = b.dataset.pzState;
        apply(await post('api/presence', { person: b.dataset.pzPerson, state: st === 'auto' ? null : st, hours: Number(hours) || null }));
        toast(st === 'auto' ? 'Di nuovo dalla posizione del telefono' : 'Presenza impostata a mano');
      } else if (b.dataset.pzMe) { apply(await post('api/presence', { person: data.me, state: 'casa', hours: 12 })); toast('Sei in casa per le prossime 12 ore: il riscaldamento torna al programma'); }
    } catch (err) { toast(err.message, true); }
  });
  document.addEventListener('change', async e => {
    const t = e.target;
    if (t.hasAttribute('data-pz-hours')) hours = t.value;
    else if (t.hasAttribute('data-pz-vac')) {
      try { apply(await post('api/automations/mode', { mode: 'vacanza', vacationUntil: t.value ? new Date(t.value + 'T23:59').getTime() : null })); } catch (err) { toast(err.message, true); }
    }
  });
  window.loadPresenza().catch(() => { });
})();
