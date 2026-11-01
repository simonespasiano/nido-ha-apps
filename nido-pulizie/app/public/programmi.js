/* Scheda Programmi: pulizie automatiche a orario o quando la casa resta vuota */
(function () {
  const DAYS = [[1, 'lun'], [2, 'mar'], [3, 'mer'], [4, 'gio'], [5, 'ven'], [6, 'sab'], [0, 'dom']];
  let programs = [];
  let editing = null;

  async function load() {
    try { programs = await api('api/programs'); } catch (e) { $('#programs').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    render();
  }
  App.hooks.programmi = load;

  function peopleNote(ov) {
    if (!ov) return;
    const ppl = ov.people;
    $('#people-note').textContent = !ppl.length ? 'Nessuna persona in Home Assistant: i programmi "quando esco" non possono partire.'
      : `In casa: ${ppl.filter(p => p.home).map(p => p.name).join(', ') || 'nessuno'}${ov.homeEmpty && ov.emptySince ? ` · casa vuota da ${ago(ov.emptySince).replace(' fa', '')}` : ''}`;
  }
  const prevOverview = App.hooks.overview;
  App.hooks.overview = ov => { prevOverview?.(ov); if (App.tab === 'programmi') peopleNote(ov); };

  function render() {
    peopleNote(App.ov);
    const el = $('#programs');
    if (!programs.length) {
      el.innerHTML = `<div class="empty">Nessun programma. Esempi utili:<br>• <b>Quando esco</b>: appena la casa resta vuota da 10 minuti pulisce soggiorno e cucina, saltando le stanze dove c'è qualcuno.<br>• <b>Sabato mattina</b>: alle 10 tutta la casa con aspirazione e lavaggio.<br><br><button class="btn primary" data-new>Crea il primo programma</button></div>`;
      return;
    }
    el.innerHTML = programs.map(p => {
      const pv = p.preview;
      const rooms = p.rooms.length ? p.rooms.map(id => App.ov?.rooms.find(r => r.id === id)?.name ?? `Stanza ${id}`).join(', ') : 'tutta la casa';
      const L = App.ov?.labels;
      return `<div class="card prog ${p.enabled ? '' : 'off'}" data-id="${p.id}">
        <div class="card-head"><h2>${esc(p.name)}</h2><label class="toggle" title="Attivo"><input type="checkbox" data-toggle ${p.enabled ? 'checked' : ''}><span></span></label></div>
        <div class="when">${p.trigger.kind === 'uscita' ? '🚪' : '🕘'} ${esc(p.description)}</div>
        <div class="note">${esc(rooms)} · ${L ? esc(L.mode[p.settings.mode]) : ''}${p.skipOccupied ? ' · salta stanze occupate' : ''}${p.onlyIfEmpty ? ' · solo a casa vuota' : ''}${p.minHoursSinceLast ? ` · non prima di ${p.minHoursSinceLast} h dall'ultima` : ''}</div>
        ${p.next ? `<div class="note">Prossima: ${fmtDate(p.next)} alle ${fmtTime(p.next)}</div>` : ''}
        <div class="preview ${pv.ok ? '' : 'no'}">${pv.ok ? `Se partisse ora pulirebbe: <b>${esc(pv.roomNames.join(', '))}</b>` : `Ora non partirebbe: ${esc(pv.reasons.join('; '))}`}${pv.skipped.length ? `<br><span class="note">Saltate: ${pv.skipped.map(s => `${esc(s.name)} (${esc(s.why)})`).join(', ')}</span>` : ''}</div>
        ${p.lastRun ? `<div class="note">Ultima volta ${ago(p.lastRun)}: ${esc(p.lastResult ?? '')}</div>` : ''}
        <div class="row"><button class="btn small" data-edit>Modifica</button><button class="btn small" data-run>Esegui ora</button><button class="btn small danger" data-del>Elimina</button></div>
      </div>`;
    }).join('');
  }

  $('#programs').addEventListener('click', async ev => {
    if (ev.target.closest('[data-new]')) return open(null);
    const card = ev.target.closest('[data-id]');
    if (!card) return;
    const p = programs.find(x => x.id === card.dataset.id);
    if (ev.target.closest('[data-edit]')) return open(p);
    try {
      if (ev.target.closest('[data-run]')) {
        const r = await post(`api/programs/${p.id}/run`);
        toast(r.result ?? 'Fatto', !r.plan?.ok);
      } else if (ev.target.closest('[data-del]')) {
        if (!confirm(`Eliminare il programma «${p.name}»?`)) return;
        await post(`api/programs/${p.id}/delete`);
      } else return;
    } catch (e) { toast(e.message, true); }
    load();
  });
  $('#programs').addEventListener('change', async ev => {
    const card = ev.target.closest('[data-id]');
    if (!card || !ev.target.matches('[data-toggle]')) return;
    try { await post(`api/programs/${card.dataset.id}/toggle`); } catch (e) { toast(e.message, true); }
    load();
  });
  $('#new-program').addEventListener('click', () => open(null));

  function blank() {
    return {
      name: '', enabled: true, trigger: { kind: 'uscita', days: [1, 2, 3, 4, 5, 6, 0], delayMin: 10, from: '08:00', to: '20:00', time: '10:00' },
      rooms: [], settings: { ...(App.ov?.defaults ?? { mode: 4, fan: 2, water: 2, strength: 1, passes: 1, route: 1 }) },
      onlyIfEmpty: false, skipOccupied: true, minHoursSinceLast: 0, minBattery: 30, onReturn: 'continua', oncePerDay: true,
    };
  }

  function open(p) {
    editing = p ? JSON.parse(JSON.stringify(p)) : blank();
    editing.trigger = { days: [1, 2, 3, 4, 5, 6, 0], delayMin: 10, from: '08:00', to: '20:00', time: '10:00', ...editing.trigger };
    $('#prog-title').textContent = p ? `Modifica «${p.name}»` : 'Nuovo programma';
    form();
    $('#prog-dlg').showModal();
  }

  function form() {
    const e = editing, t = e.trigger, ov = App.ov;
    const rooms = ov?.rooms ?? [];
    $('#prog-form').innerHTML = `
      <div class="f-sec"><h3>Nome</h3><input type="text" name="name" value="${esc(e.name)}" placeholder="${t.kind === 'uscita' ? 'Quando esco' : 'Pulizia del mattino'}" maxlength="60"></div>
      <div class="f-sec"><h3>Quando parte</h3>
        <div class="seg" data-kind><button type="button" data-k="uscita" class="${t.kind === 'uscita' ? 'on' : ''}">Quando la casa resta vuota</button><button type="button" data-k="orario" class="${t.kind === 'orario' ? 'on' : ''}">A un orario</button></div>
        <div class="chips" data-days>${DAYS.map(([d, n]) => `<button type="button" class="chip ${t.days.includes(d) ? 'on' : ''}" data-d="${d}">${n}</button>`).join('')}</div>
        ${t.kind === 'orario'
          ? `<div class="f-row"><label>Alle <input type="time" name="time" value="${t.time}"></label></div>`
          : `<div class="f-row"><label>Dopo <input type="number" name="delayMin" min="0" max="240" value="${t.delayMin}"> minuti senza nessuno</label></div>
             <div class="f-row"><label>Solo tra le <input type="time" name="from" value="${t.from}"></label><label>e le <input type="time" name="to" value="${t.to}"></label></div>
             <label class="check"><input type="checkbox" name="oncePerDay" ${e.oncePerDay ? 'checked' : ''}><span>Al massimo una volta al giorno<small>Se esci più volte, pulisce solo la prima</small></span></label>
             <p class="note">Persone considerate: ${ov?.people.length ? ov.people.map(p => esc(p.name)).join(', ') : 'nessuna trovata'} (opzione <code>persone</code> della configurazione).</p>`}
      </div>
      <div class="f-sec"><h3>Stanze</h3>
        <div class="chips" data-rooms><button type="button" class="chip ${!e.rooms.length ? 'on' : ''}" data-r="all">Tutta la casa</button>${rooms.map(r => `<button type="button" class="chip ${e.rooms.includes(r.id) ? 'on' : ''}" data-r="${r.id}">${esc(r.name)}</button>`).join('')}</div>
      </div>
      <div class="f-sec"><h3>Come pulisce</h3>${ov ? App.settingsControls(e.settings, ov.labels, 'pg') : ''}</div>
      <div class="f-sec"><h3>Condizioni</h3>
        <label class="check"><input type="checkbox" name="skipOccupied" ${e.skipOccupied ? 'checked' : ''}><span>Salta le stanze dove c'è qualcuno<small>Usa i sensori di presenza o movimento dell'area di Home Assistant collegata alla stanza (Impostazioni)</small></span></label>
        ${t.kind === 'orario' ? `<label class="check"><input type="checkbox" name="onlyIfEmpty" ${e.onlyIfEmpty ? 'checked' : ''}><span>Solo se in casa non c'è nessuno</span></label>` : ''}
        <div class="f-row"><label>Salta le stanze pulite da meno di <input type="number" name="minHoursSinceLast" min="0" max="720" value="${e.minHoursSinceLast}"> ore</label></div>
        <div class="f-row"><label>Batteria minima <input type="number" name="minBattery" min="0" max="90" value="${e.minBattery}"> %</label></div>
        <div class="f-row"><label>Se qualcuno rientra durante la pulizia <select name="onReturn">
          <option value="continua" ${e.onReturn === 'continua' ? 'selected' : ''}>continua</option>
          <option value="pausa" ${e.onReturn === 'pausa' ? 'selected' : ''}>metti in pausa</option>
          <option value="base" ${e.onReturn === 'base' ? 'selected' : ''}>torna alla base</option></select></label></div>
      </div>
      <div class="f-sec"><div id="prog-preview" class="note">…</div></div>
      <div class="f-actions"><button type="button" class="btn" data-close-form>Annulla</button><button type="button" class="btn primary" data-save>Salva</button></div>`;
    preview();
  }

  function collect() {
    const f = $('#prog-form'), e = editing;
    const v = n => f.querySelector(`[name="${n}"]`);
    if (v('name')) e.name = v('name').value;
    if (v('time')) e.trigger.time = v('time').value;
    if (v('delayMin')) e.trigger.delayMin = Number(v('delayMin').value);
    if (v('from')) e.trigger.from = v('from').value;
    if (v('to')) e.trigger.to = v('to').value;
    for (const k of ['oncePerDay', 'skipOccupied', 'onlyIfEmpty']) if (v(k)) e[k] = v(k).checked;
    for (const k of ['minHoursSinceLast', 'minBattery']) if (v(k)) e[k] = Number(v(k).value);
    if (v('onReturn')) e.onReturn = v('onReturn').value;
    e.settings = { ...e.settings, ...App.readSettings(f, 'pg') };
  }

  let pvTimer;
  function preview() {
    clearTimeout(pvTimer);
    pvTimer = setTimeout(async () => {
      try {
        const pv = await post('api/programs/preview', editing);
        $('#prog-preview').innerHTML = pv.ok ? `Se partisse adesso pulirebbe: <b>${esc(pv.roomNames.join(', '))}</b>${pv.skipped.length ? ` · saltate ${pv.skipped.map(s => `${esc(s.name)} (${esc(s.why)})`).join(', ')}` : ''}`
          : `Se partisse adesso non pulirebbe: ${esc(pv.reasons.join('; '))}${pv.skipped.length ? ` · saltate ${pv.skipped.map(s => `${esc(s.name)} (${esc(s.why)})`).join(', ')}` : ''}`;
      } catch { /* anteprima non essenziale */ }
    }, 200);
  }

  $('#prog-form').addEventListener('click', async ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    collect();
    const e = editing;
    if (b.dataset.k) { e.trigger.kind = b.dataset.k; form(); return; }
    if (b.dataset.d != null) { const d = Number(b.dataset.d); e.trigger.days = e.trigger.days.includes(d) ? e.trigger.days.filter(x => x !== d) : [...e.trigger.days, d]; form(); return; }
    if (b.dataset.r) {
      if (b.dataset.r === 'all') e.rooms = [];
      else { const id = Number(b.dataset.r); e.rooms = e.rooms.includes(id) ? e.rooms.filter(x => x !== id) : [...e.rooms, id]; }
      form(); return;
    }
    if (b.hasAttribute('data-close-form')) { $('#prog-dlg').close(); return; }
    if (b.hasAttribute('data-save')) {
      if (!e.trigger.days.length) { toast('Scegli almeno un giorno', true); return; }
      try { await post('api/programs', e); $('#prog-dlg').close(); toast('Programma salvato'); load(); }
      catch (err) { toast(err.message, true); }
    }
  });
  $('#prog-form').addEventListener('change', ev => {
    collect();
    if (ev.target.dataset.pg === 'mode') form(); else preview();
  });
})();
