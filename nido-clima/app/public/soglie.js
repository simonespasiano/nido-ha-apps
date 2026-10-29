// NIDO Clima — soglie di rilevamento modificabili dall'interfaccia, con prova sullo storico.
(() => {
  const FIELDS = [
    { key: 'onDelta', label: 'Caldo quando il termosifone supera la stanza di', help: 'Differenza tra temperatura misurata dalla valvola e temperatura della stanza', unit: '°C', step: 0.1 },
    { key: 'offDelta', label: 'Torna freddo quando la differenza scende sotto', help: 'Deve essere più bassa della precedente: lo scarto evita che lo stato cambi in continuazione', unit: '°C', step: 0.1 },
    { key: 'onSlope', label: 'Accensione anticipata se la valvola sale di almeno', help: 'Riconosce l\'accensione prima che la differenza arrivi alla soglia', unit: '°C/h', step: 0.5 },
    { key: 'offSlope', label: 'Spegnimento anticipato se la valvola scende di almeno', help: 'Riconosce lo spegnimento mentre il termosifone si sta raffreddando', unit: '°C/h', step: 0.5 },
    { key: 'windowSlope', label: 'Possibile finestra aperta se la stanza perde almeno', help: 'Con il termosifone acceso basta il 75% di questo valore', unit: '°C/h', step: 0.5 },
    { key: 'satisfiedMargin', label: 'Valvola chiusa se la stanza è entro dall\'obiettivo', help: 'Se la stanza ha raggiunto l\'obiettivo, il caldo alla valvola è acqua in arrivo: non conta come termosifone acceso', unit: '°C', step: 0.1 },
    { key: 'valveWindowMin', label: 'Minuti su cui calcolare salite e discese', help: 'Più lungo = più stabile ma più lento a reagire', unit: 'min', step: 1 },
  ];
  let state = null;      // { global, rooms, source, limits, rooms_list }
  let draft = null;      // copia in modifica
  let scope = '';        // '' = tutte le stanze, altrimenti id stanza

  const toNum = v => v === '' || v == null ? null : Number(String(v).replace(',', '.'));
  const show = v => v == null ? '' : String(v).replace('.', ',');

  window.loadThresholds = async () => {
    state = await api('api/thresholds');
    draft = { global: { ...state.global }, rooms: JSON.parse(JSON.stringify(state.rooms)) };
    const sel = $('#th-scope');
    sel.innerHTML = '<option value="">Tutte le stanze</option>' + state.rooms_list.map(r =>
      `<option value="${esc(r.id)}">${esc(r.name)}${state.rooms[r.id] ? ' •' : ''}</option>`).join('');
    sel.value = scope;
    renderForm();
  };

  function renderForm() {
    const room = scope ? draft.rooms[scope] ?? {} : null;
    $('#th-scope-note').textContent = scope
      ? 'Lascia vuoto un campo per usare il valore comune (in grigio). I campi compilati valgono solo per questa stanza.'
      : 'Valori comuni a tutte le stanze. Puoi poi impostare valori diversi per una singola stanza.';
    $('#th-form').innerHTML = FIELDS.map(f => {
      const [lo, hi] = state.limits[f.key];
      const g = draft.global[f.key];
      const val = scope ? room[f.key] : g;
      return `<div class="th-row"><div><b>${f.label}</b><small>${f.help}</small></div>
        <span class="num"><input inputmode="decimal" data-key="${f.key}" value="${show(val)}" placeholder="${scope ? show(g) : ''}"
          class="${scope && val != null ? 'over' : ''}" aria-label="${esc(f.label)}" title="Tra ${show(lo)} e ${show(hi)}"><span class="unit">${f.unit}</span></span></div>`;
    }).join('');
    $('#th-source').textContent = state.source === 'interfaccia'
      ? 'Valori salvati da questa pagina' : 'Valori presi dalla configurazione dell\'app';
  }

  $('#th-form').addEventListener('input', e => {
    const key = e.target.dataset.key; if (!key) return;
    const v = toNum(e.target.value);
    if (scope) {
      draft.rooms[scope] ??= {};
      if (v == null || Number.isNaN(v)) delete draft.rooms[scope][key]; else draft.rooms[scope][key] = v;
      if (!Object.keys(draft.rooms[scope]).length) delete draft.rooms[scope];
      e.target.classList.toggle('over', v != null);
    } else if (v != null && !Number.isNaN(v)) {
      draft.global[key] = v;
    }
  });

  $('#th-scope').addEventListener('change', e => { scope = e.target.value; renderForm(); });

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    return j;
  }

  $('#th-save').addEventListener('click', async () => {
    try {
      await post('api/thresholds', draft);
      toast('Soglie salvate: valgono da subito');
      await window.loadThresholds();
    } catch (e) { toast(e.message, true); }
  });

  $('#th-reset').addEventListener('click', async () => {
    if (!confirm('Tornare ai valori della configurazione dell\'app e cancellare quelli per singola stanza?')) return;
    try { await post('api/thresholds', { reset: true }); toast('Soglie riportate ai valori della configurazione'); scope = ''; await window.loadThresholds(); }
    catch (e) { toast(e.message, true); }
  });

  $('#th-sim').addEventListener('click', async () => {
    $('#th-result').innerHTML = '<p class="note">Calcolo in corso…</p>';
    try {
      const res = await post('api/thresholds/simulate', { ...draft, hours: Number($('#th-hours').value) });
      const d = v => v == null ? '–' : (v >= 0 ? '+' : '') + n1(v);
      $('#th-result').innerHTML = `<table><thead><tr><th>Stanza</th><th>Accensioni</th><th>Tempo caldo</th><th>Prima</th><th>Differenza mediana / 90% / max</th></tr></thead>
        <tbody>${res.map(r => `<tr><td><b>${esc(r.name)}</b></td><td>${r.accensioni}</td><td>${dur(r.minutes)}</td><td>${dur(r.currentMinutes)}</td>
          <td>${d(r.delta.p50)} / ${d(r.delta.p90)} / <b>${d(r.delta.max)}</b> °C</td></tr>`).join('')}</tbody></table>
        <p class="note">"Prima" è il tempo caldo con le soglie in uso finora. Se la differenza <b>max</b> di una stanza resta sotto la soglia di accensione,
        con quelle soglie il termosifone non verrà mai visto acceso: abbassala sotto quel valore, lasciando margine sopra la mediana.</p>`;
    } catch (e) { $('#th-result').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  });
})();
