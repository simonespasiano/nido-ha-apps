// Scenari: insiemi di posizioni da richiamare con un tocco, da un'automazione o da Home Assistant.
const ICONS = ['🪟', '🌅', '🌙', '☀️', '🎬', '🍽️', '🛏️', '🏖️', '🔒', '💨', '🌤️', '🏠'];

function renderScenes() {
  const el = $('#scenari');
  if (!ov) return;
  const name = id => ov.shutters.find(s => s.id === id)?.name ?? id;
  el.innerHTML = `
    <p class="note">Uno scenario porta più tapparelle ognuna nella sua posizione, ad esempio "Film" o "Pranzo". Si avvia da qui, dalla scheda Tapparelle,
      da un'automazione di NIDO oppure da Home Assistant${ov.ha.bridge === 'mqtt' ? ' (ogni scenario è un pulsante <i>NIDO Tapparelle</i>)' : ''}.</p>
    <div class="list">${ov.scenes.map(sc => `
      <div class="card rule">
        <span style="font-size:26px">${esc(sc.icon)}</span>
        <div><b>${esc(sc.name)}</b>
          <div class="sc-pos">${Object.entries(sc.positions).map(([id, p]) => `<span class="pill">${esc(name(id))}: ${posLabel(p)}</span>`).join('')}</div></div>
        <div class="acts"><button class="btn primary small" data-run="${sc.id}">Avvia</button>
          <button class="btn small" data-edit="${sc.id}">Modifica</button></div>
      </div>`).join('') || '<div class="empty">Nessuno scenario. Creane uno con le posizioni che usi più spesso.</div>'}</div>
    <div class="dlg-actions" style="justify-content:flex-start"><button class="btn primary" id="sc-new">+ Nuovo scenario</button></div>`;
}

$('#scenari').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'sc-new') return sceneDialog(null);
  if (b.dataset.edit) return sceneDialog(ov.scenes.find(s => s.id === b.dataset.edit));
  if (b.dataset.run) { await run(() => api(`api/scenes/${b.dataset.run}/run`, {}), 'Scenario avviato'); refreshSoon(); }
});

function sceneDialog(sc) {
  const pos = { ...(sc?.positions ?? {}) };
  const rows = ov.shutters.map(s => {
    const on = s.id in pos, v = on ? pos[s.id] : (s.position ?? 100);
    return `<div class="sc-row" data-id="${s.id}"><input type="checkbox" ${on ? 'checked' : ''}><span>${esc(s.name)}<small class="note" style="display:block;margin:0">${esc(s.area ?? '')}</small></span>
      <input type="range" class="rng" min="0" max="100" step="5" value="${v}" ${on ? '' : 'disabled'}><b>${v}%</b></div>`;
  }).join('');
  const body = openDlg(sc ? `Scenario: ${sc.name}` : 'Nuovo scenario', '0% = chiusa, 100% = aperta', `
    <div class="form">
      <label class="frow"><span>Nome</span><input type="text" id="sc-name" value="${esc(sc?.name ?? '')}" placeholder="es. Film"></label>
      <div class="frow"><span>Icona</span><div class="chips">${ICONS.map(i => `<button type="button" class="chip small ${(sc?.icon ?? '🪟') === i ? 'on' : ''}" data-icon="${i}">${i}</button>`).join('')}</div></div>
    </div>
    <div class="f-row"><button class="btn small" id="sc-now">Usa le posizioni attuali</button><span class="note">spunta le tapparelle che fanno parte dello scenario</span></div>
    <div>${rows}</div>
    <div class="dlg-actions">${sc ? '<button class="btn danger left" id="sc-del">Elimina</button>' : ''}<button class="btn" id="sc-try">Prova</button><button class="btn primary" id="sc-save">Salva</button></div>`, true);
  let icon = sc?.icon ?? '🪟';
  body.querySelectorAll('[data-icon]').forEach(b => b.onclick = () => { icon = b.dataset.icon; body.querySelectorAll('[data-icon]').forEach(x => x.classList.toggle('on', x === b)); });
  body.querySelectorAll('.sc-row').forEach(r => {
    const cb = r.querySelector('input[type=checkbox]'), rg = r.querySelector('input[type=range]'), lb = r.querySelector('b');
    cb.onchange = () => rg.disabled = !cb.checked;
    rg.oninput = () => lb.textContent = `${rg.value}%`;
  });
  const collect = () => {
    const positions = {};
    body.querySelectorAll('.sc-row').forEach(r => { if (r.querySelector('input[type=checkbox]').checked) positions[r.dataset.id] = Number(r.querySelector('input[type=range]').value); });
    return { id: sc?.id, name: body.querySelector('#sc-name').value, icon, positions };
  };
  body.querySelector('#sc-now').onclick = () => body.querySelectorAll('.sc-row').forEach(r => {
    const s = ov.shutters.find(x => x.id === r.dataset.id);
    const cb = r.querySelector('input[type=checkbox]'), rg = r.querySelector('input[type=range]');
    cb.checked = true; rg.disabled = false; rg.value = Math.round((s.position ?? 0) / 5) * 5; r.querySelector('b').textContent = `${rg.value}%`;
  });
  body.querySelector('#sc-try').onclick = async () => {
    const c = collect();
    for (const [id, p] of Object.entries(c.positions)) await api(`api/shutters/${id}/command`, { action: 'position', position: p }).catch(() => undefined);
    toast('Posizioni inviate'); refreshSoon();
  };
  body.querySelector('#sc-save').onclick = async () => { await run(() => api('api/scenes', collect()), 'Scenario salvato'); closeDlg(); await refresh(); renderScenes(); };
  body.querySelector('#sc-del')?.addEventListener('click', async () => {
    if (!confirm(`Eliminare lo scenario "${sc.name}"?`)) return;
    await run(() => api(`api/scenes/${sc.id}/delete`, {}), 'Scenario eliminato'); closeDlg(); await refresh(); renderScenes();
  });
}

loaders.scenari = renderScenes;
