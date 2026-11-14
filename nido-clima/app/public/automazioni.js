// NIDO Clima — Automazioni: un solo pannello per programmi orari, modalità della casa, finestre e umidità.
(() => {
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
  const LEVEL_COLOR = { comfort: 'var(--c2)', eco: 'var(--c1)', notte: 'var(--c7)', fuori: 'var(--c3)', vacanza: 'var(--c4)' };
  const DAYS = [['feriali', 'Lun–Ven'], ['sabato', 'Sabato'], ['domenica', 'Domenica']];
  let data = null, draft = null, open = new Set(), dirty = false;

  window.loadAutomazioni = async () => {
    data = await api('api/automations');
    if (!dirty) draft = JSON.parse(JSON.stringify(data.settings));
    for (const r of data.rooms) if (!draft.rooms[r.id]) draft.rooms[r.id] = JSON.parse(JSON.stringify(r.auto));
    render();
  };
  const setDirty = () => { dirty = true; const b = document.getElementById('au-save'); if (b) { b.disabled = false; b.textContent = 'Salva le modifiche'; } };

  function timeline(blocks) {
    // segmenti della giornata: prima del primo blocco vale l'ultimo
    const m = s => { const [h, mi] = s.split(':').map(Number); return h * 60 + mi; };
    const sorted = [...blocks].sort((a, b) => m(a.at) - m(b.at));
    if (!sorted.length) return '';
    const segs = [];
    let cur = sorted[sorted.length - 1].level, start = 0;
    for (const b of sorted) { if (m(b.at) > start) segs.push([start, m(b.at), cur]); cur = b.level; start = m(b.at); }
    segs.push([start, 1440, cur]);
    const now = new Date(), nowM = now.getHours() * 60 + now.getMinutes();
    return `<div class="tl">${segs.map(([a, b, l]) => `<i style="left:${a / 14.4}%;width:${(b - a) / 14.4}%;background:${LEVEL_COLOR[l]}" title="${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')} ${l}"></i>`).join('')}
      <b style="left:${nowM / 14.4}%" title="adesso"></b></div><div class="tl-h"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>`;
  }

  function render() {
    const d = data, s = draft, L = d.labels;
    const el = document.getElementById('automazioni');
    const h = d.house;
    const modes = ['auto', 'casa', 'fuori', 'notte', 'vacanza'];
    const decisions = Object.fromEntries(d.decisions.map(x => [x.room, x]));
    el.innerHTML = `
      <div class="card au-head">
        <div class="card-head"><h2>NIDO gestisce il riscaldamento</h2><label class="toggle"><input type="checkbox" data-k="enabled" ${s.enabled ? 'checked' : ''}><span></span></label></div>
        <p class="note">${s.enabled ? 'NIDO decide l\'obiettivo di ogni valvola secondo programmi, modalità della casa e regole qui sotto. Un cambio fatto sulla ghiera della valvola viene rispettato fino al prossimo cambio di programma.' : 'Sospeso: le valvole tengono l\'obiettivo che hanno. Attiva per far applicare programmi e regole.'}</p>
        <h3>Modalità della casa</h3>
        <div class="seg wrap">${modes.map(m => `<button class="${s.houseMode === m ? 'on' : ''}" data-mode="${m}">${esc(L.modes[m])}</button>`).join('')}</div>
        ${s.houseMode === 'vacanza' ? `<div class="f-row"><label>Fino al <input type="date" data-vac value="${s.vacationUntil ? new Date(s.vacationUntil).toISOString().slice(0, 10) : ''}"></label><span class="note">poi torna automatica</span></div>` : ''}
        <p class="note">Ora: <b>${esc(L.modes[h.mode])}</b> · ${esc(h.why)}${d.people.length ? ` · ${d.people.map(p => `${esc(p.name)} ${p.state === 'home' ? '🏠' : ['unknown', 'unavailable'].includes(p.state) || !p.trackers ? '❔' : `🚶 (${esc(p.state)})`}`).join(' ')}` : ''}</p>
      </div>

      <div class="au-rooms">${d.rooms.map(r => {
        const x = decisions[r.id], ra = s.rooms[r.id];
        const lvl = x?.level ?? 'eco';
        return `<article class="card au-room ${x?.managed ? '' : 'off'}">
          <div class="card-head"><h2>${esc(r.name)}</h2><label class="toggle" title="Gestita da NIDO"><input type="checkbox" data-room-enabled="${r.id}" ${ra.enabled ? 'checked' : ''}><span></span></label></div>
          <div class="au-now">
            <span class="lvl" style="background:${LEVEL_COLOR[lvl]}">${esc(x?.levelLabel ?? '')}</span>
            <span class="au-t"><b>${x?.target != null ? n1(x.target) : n1(x?.current)}°</b><small>${x?.target != null && x.current != null && Math.abs(x.current - x.target) >= 0.25 ? `valvola ora a ${n1(x.current)}°` : 'obiettivo'}</small></span>
          </div>
          <p class="reason">${esc((x?.reasons ?? []).join(' · '))}${x?.skipped ? `<br><span class="warn-t">${esc(x.skipped)}</span>` : ''}</p>
          ${x?.window.open ? '<span class="badge win">🪟 Finestra aperta</span>' : ''}${x?.mould.risk ? `<span class="badge warm">💧 Condensa sulle pareti ${x.mould.surfaceRH} %</span>` : ''}
          ${x?.next ? `<p class="note">Poi alle ${hhmm(x.next.at)}: ${esc(L.levels[x.next.level])} ${n1(x.next.temp)}°</p>` : ''}
          ${timeline(ra.week[new Date().getDay() === 0 ? 'domenica' : new Date().getDay() === 6 ? 'sabato' : 'feriali'])}
          <div class="au-act">
            <button class="btn small" data-boost="${r.id}" data-v="${(x?.target ?? x?.current ?? 20) + 1}">+1° per un'ora</button>
            <button class="btn small" data-set="${r.id}">Imposta…</button>
            ${x?.override ? `<button class="btn small" data-clear="${r.id}">Torna al programma</button>` : ''}
            <button class="btn small" data-edit="${r.id}">${open.has(r.id) ? 'Chiudi programma' : 'Programma'}</button>
          </div>
          ${open.has(r.id) ? editor(r.id, ra) : ''}
        </article>`;
      }).join('')}</div>

      <div class="au-rules">
        <div class="card"><div class="card-head"><h2>🏠 Presenza</h2></div>
          <p class="note">In modalità <b>Automatica</b>, quando tutte le persone sono fuori la casa passa a <b>Fuori</b> e ogni stanza usa la sua temperatura "fuori casa". Al rientro di qualcuno si torna subito al programma.</p>
          <div class="f-row"><label>Passa a Fuori dopo <input type="number" min="0" max="240" value="${s.awayDelayMin}" data-k="awayDelayMin"> minuti</label></div>
          <h3>Persone considerate</h3>
          <div class="chips">${d.people.length ? d.people.map(p => `<button class="chip ${!s.persons.length || s.persons.includes(p.id) ? 'on' : ''}" data-person="${p.id}">${esc(p.name)}</button>`).join('') : '<span class="note">Nessuna persona in Home Assistant</span>'}</div>
          ${d.people.length ? '<p class="note">Nessuna selezionata = tutte. Contano solo le persone con un dispositivo che ne indica la posizione (app di Home Assistant sul telefono): chi ha ❔ viene ignorato. Togli qui chi non vive in casa o non ha il telefono collegato.</p>' : ''}
        </div>
        <div class="card"><div class="card-head"><h2>🪟 Finestra aperta</h2><label class="toggle"><input type="checkbox" data-w="enabled" ${s.window.enabled ? 'checked' : ''}><span></span></label></div>
          <p class="note">Senza sensori sulle finestre: se la temperatura della stanza scende di colpo, la valvola va al minimo e torna all'obiettivo quando la stanza smette di raffreddarsi.</p>
          <div class="f-row"><label>Calo di almeno <input type="number" step="0.1" min="0.3" max="3" value="${s.window.dropC}" data-w="dropC"> °C in 6 minuti</label></div>
          <div class="f-row"><label>Valvola a <input type="number" step="0.5" min="5" max="15" value="${s.window.temp}" data-w="temp"> °C per almeno <input type="number" min="5" max="90" value="${s.window.minutes}" data-w="minutes"> minuti</label></div>
        </div>
        <div class="card"><div class="card-head"><h2>💧 Umidità intelligente</h2><label class="toggle"><input type="checkbox" data-h="enabled" ${s.humidity.enabled ? 'checked' : ''}><span></span></label></div>
          <label class="check"><input type="checkbox" data-h="antiMould" ${s.humidity.antiMould ? 'checked' : ''}><span>Contro la condensa alza l'obiettivo di <input type="number" step="0.5" min="0" max="1.5" value="${s.humidity.boost}" data-h="boost"> °C<small>Solo quando le pareti più fredde superano l'80 % di umidità: aria più calda vuol dire superfici più calde e meno muffa</small></span></label>
          <label class="check"><input type="checkbox" data-h="notify" ${s.humidity.notify ? 'checked' : ''}><span>Avvisami quando conviene arieggiare<small>Umidità sopra il <input type="number" min="50" max="85" value="${s.humidity.high}" data-h="high"> % da 30 minuti, oppure un aumento di <input type="number" min="5" max="30" value="${s.humidity.spike}" data-h="spike"> punti in pochi minuti (doccia, cucina), e solo se fuori l'aria è più secca</small></span></label>
          <h3>Notifiche a</h3>
          <div class="chips">${d.notify.length ? d.notify.map(n => `<button class="chip ${s.humidity.services.includes(n) ? 'on' : ''}" data-notify="${n}">${esc(n)}</button>`).join('') : '<span class="note">Nessun servizio notify trovato</span>'}</div>
        </div>
      </div>
      <div class="au-bar"><button class="btn primary" id="au-save" ${dirty ? '' : 'disabled'}>${dirty ? 'Salva le modifiche' : 'Tutto salvato'}</button><span class="note">Le modifiche valgono subito dopo il salvataggio.</span></div>`;
  }

  function editor(id, ra) {
    const T = ra.temps;
    const tIn = k => `<label>${({ comfort: 'Comfort', eco: 'Eco', notte: 'Notte', fuori: 'Fuori casa', vacanza: 'Vacanza' })[k]}<input type="number" step="0.5" min="5" max="28" value="${T[k]}" data-temp="${id}" data-tk="${k}"></label>`;
    return `<div class="au-edit">
      <h3>Temperature</h3>
      <div class="au-temps">${['comfort', 'eco', 'notte', 'fuori', 'vacanza'].map(tIn).join('')}</div>
      ${DAYS.map(([dk, dl]) => `<h3>${dl}</h3>${timeline(ra.week[dk])}
        <div class="blocks">${ra.week[dk].map((b, i) => `<div class="blk"><input type="time" value="${b.at}" data-blk="${id}" data-day="${dk}" data-i="${i}" data-f="at">
          <select data-blk="${id}" data-day="${dk}" data-i="${i}" data-f="level">${['comfort', 'eco', 'notte'].map(l => `<option value="${l}" ${l === b.level ? 'selected' : ''}>${({ comfort: 'Comfort', eco: 'Eco', notte: 'Notte' })[l]}</option>`).join('')}</select>
          <button class="icon-btn" data-del="${id}" data-day="${dk}" data-i="${i}" ${ra.week[dk].length <= 1 ? 'disabled' : ''} aria-label="Togli">✕</button></div>`).join('')}
          <button class="btn small" data-add="${id}" data-day="${dk}">+ Cambio</button>
          ${dk !== 'feriali' ? `<button class="btn small" data-copy="${id}" data-day="${dk}">Come Lun–Ven</button>` : ''}</div>`).join('')}
      <div class="f-row"><button class="btn small" data-copyall="${id}">Copia questo programma in tutte le stanze</button></div>
    </div>`;
  }

  const root = () => document.getElementById('automazioni');
  document.addEventListener('click', async e => {
    if (!root()?.contains(e.target)) return;
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const s = draft;
    try {
      if (b.dataset.mode) { s.houseMode = b.dataset.mode; setDirty(); }
      else if (b.dataset.person) { const all = data.people.map(p => p.id); let cur = s.persons.length ? [...s.persons] : [...all]; cur = cur.includes(b.dataset.person) ? cur.filter(x => x !== b.dataset.person) : [...cur, b.dataset.person]; s.persons = cur.length === all.length ? [] : cur; setDirty(); }
      else if (b.dataset.notify) { const n = b.dataset.notify; s.humidity.services = s.humidity.services.includes(n) ? s.humidity.services.filter(x => x !== n) : [...s.humidity.services, n]; setDirty(); }
      else if (b.dataset.edit) { open.has(b.dataset.edit) ? open.delete(b.dataset.edit) : open.add(b.dataset.edit); }
      else if (b.dataset.add) { const w = s.rooms[b.dataset.add].week[b.dataset.day]; const last = w[w.length - 1]?.at ?? '12:00'; const [hh] = last.split(':').map(Number); w.push({ at: `${String(Math.min(23, hh + 1)).padStart(2, '0')}:00`, level: 'eco' }); setDirty(); }
      else if (b.dataset.del) { s.rooms[b.dataset.del].week[b.dataset.day].splice(Number(b.dataset.i), 1); setDirty(); }
      else if (b.dataset.copy) { s.rooms[b.dataset.copy].week[b.dataset.day] = JSON.parse(JSON.stringify(s.rooms[b.dataset.copy].week.feriali)); setDirty(); }
      else if (b.dataset.copyall) { if (!confirm('Copiare temperature e orari di questa stanza in tutte le altre?')) return; const src = s.rooms[b.dataset.copyall]; for (const id of Object.keys(s.rooms)) if (id !== b.dataset.copyall) s.rooms[id] = { ...JSON.parse(JSON.stringify(src)), enabled: s.rooms[id].enabled }; setDirty(); }
      else if (b.dataset.boost) { await post('api/automations/override', { room: b.dataset.boost, value: Number(b.dataset.v), hours: 1 }); toast('Un grado in più per un\'ora'); }
      else if (b.dataset.set) { const v = prompt('Temperatura da tenere fino al prossimo cambio di programma (°C)', '20'); if (v == null) return; await post('api/automations/override', { room: b.dataset.set, value: Number(v.replace(',', '.')) }); toast('Obiettivo impostato'); }
      else if (b.dataset.clear) { await post('api/automations/override', { room: b.dataset.clear, value: null }); toast('Si torna al programma'); }
      else if (b.id === 'au-save') { await post('api/automations', draft); dirty = false; toast('Automazioni salvate'); }
      else return;
    } catch (err) { toast(err.message, true); }
    if (b.dataset.boost || b.dataset.set || b.dataset.clear || b.id === 'au-save') await window.loadAutomazioni(); else render();
  });
  document.addEventListener('change', e => {
    if (!root()?.contains(e.target)) return;
    const t = e.target, s = draft, val = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
    if (t.dataset.k) s[t.dataset.k] = val;
    else if (t.dataset.w) s.window[t.dataset.w] = val;
    else if (t.dataset.h) s.humidity[t.dataset.h] = val;
    else if (t.dataset.roomEnabled) s.rooms[t.dataset.roomEnabled].enabled = t.checked;
    else if (t.dataset.temp) s.rooms[t.dataset.temp].temps[t.dataset.tk] = Number(t.value);
    else if (t.dataset.blk) { const w = s.rooms[t.dataset.blk].week[t.dataset.day]; w[Number(t.dataset.i)][t.dataset.f] = t.value; w.sort((a, b) => a.at.localeCompare(b.at)); }
    else if (t.hasAttribute('data-vac')) s.vacationUntil = t.value ? new Date(t.value + 'T23:59').getTime() : null;
    else return;
    setDirty();
    if (t.dataset.blk || t.dataset.k === 'enabled') render();
  });
})();
