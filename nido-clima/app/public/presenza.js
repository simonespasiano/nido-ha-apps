// NIDO Clima — barra della presenza, sempre visibile sopra le schede: modalità della casa e presenza
// di ogni persona, correggibili a mano subito quando la posizione del telefono sbaglia.
(() => {
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
  const MODES = ['auto', 'casa', 'fuori', 'notte', 'vacanza'];
  const MODE_ICON = { casa: '🏠', fuori: '🚶', notte: '🌙', vacanza: '🧳' };
  const DUR = [['0', 'finché non la cambio'], ['4', 'per 4 ore'], ['12', 'per 12 ore'], ['24', 'per 24 ore'], ['72', 'per 3 giorni'], ['168', 'per 7 giorni']];
  let data = null, hours = '0';
  let open = false;
  try { open = localStorage.getItem('nido-pz-open') === '1'; } catch { }
  const when = ts => new Date(ts).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  window.loadPresenza = async () => { data = await api('api/presence'); render(); };
  const apply = j => { data = j; render(); if (window.loadAutomazioni && !document.getElementById('tab-automazioni').hidden) window.loadAutomazioni(); };

  function gps(p) {
    if (!p.trackers) return '❔ nessun telefono';
    if (['unknown', 'unavailable'].includes(p.state)) return '❔ posizione sconosciuta';
    return p.gpsHome ? '🏠 in casa' : `🚶 ${p.state === 'not_home' ? 'fuori' : esc(p.state)}`;
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
            <small>Telefono: ${gps(p)}${p.manual ? ` · <b>a mano: ${esc(L.presence[p.manual.state])}</b> ${p.manual.until ? `fino a ${when(p.manual.until)}` : 'finché non la cambi'}${p.manual.by ? ` (da ${esc(p.manual.by)})` : ''}` : ''}</small></div>
          <div class="seg">${[['auto', 'Dal telefono'], ['casa', 'In casa'], ['fuori', 'Fuori'], ['ignora', 'Non conta']].map(([k, l]) =>
            `<button class="${(p.manual?.state ?? 'auto') === k ? 'on' : ''}" data-pz-person="${esc(p.id)}" data-pz-state="${k}">${l}</button>`).join('')}</div>
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
