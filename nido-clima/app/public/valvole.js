// NIDO Clima — Valvole: tutte le impostazioni di ogni valvola in una tabella, con "applica a tutte" e il sensore esterno.
(() => {
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
  let data = null;
  window.loadValvole = async () => { data = await api('api/valves'); render(); };

  function cell(room, d, managed) {
    if (!d) return '<td class="na">–</td>';
    // sensore e valore inviato li gestisce NIDO quando il sensore esterno è attivo
    if (managed && ['sensor', 'external_temperature_input'].includes(d.key)) return `<td class="val" title="Gestito da NIDO">${esc(d.state)}${d.unit ? ' ' + esc(d.unit) : ''} 🤖</td>`;
    const id = esc(d.entity_id), na = ['unavailable', 'unknown'].includes(d.state);
    if (d.kind === 'switch' || d.kind === 'lock') {
      const on = d.state === 'on' || d.state === 'locked';
      return `<td><label class="toggle"><input type="checkbox" data-vr="${room}" data-e="${id}" ${on ? 'checked' : ''} ${na ? 'disabled' : ''}><span></span></label></td>`;
    }
    if (d.kind === 'select') return `<td><select data-vr="${room}" data-e="${id}">${(d.options ?? []).map(o => `<option ${o === d.state ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></td>`;
    if (d.kind === 'number') return `<td><input class="num" type="number" value="${esc(d.state)}" ${d.min != null ? `min="${d.min}"` : ''} ${d.max != null ? `max="${d.max}"` : ''} step="${d.step ?? 'any'}" data-vr="${room}" data-e="${id}"></td>`;
    if (d.kind === 'button') return `<td><button class="btn small" data-press="${id}" data-vr="${room}" data-name="${esc(d.name)}">Avvia</button></td>`;
    return `<td class="val">${esc(d.state)}${d.unit ? ' ' + esc(d.unit) : ''}</td>`;
  }

  function render() {
    const el = document.getElementById('valvole'), d = data;
    // colonne: tutte le impostazioni presenti su almeno una valvola, nell'ordine principale → configurazione → diagnostica
    const order = { principale: 0, configurazione: 1, diagnostica: 2 };
    const cols = new Map();
    for (const v of d.valves) for (const c of v.controls?.device ?? []) if (!cols.has(c.key)) cols.set(c.key, c);
    const keys = [...cols.values()].sort((a, b) => order[a.category] - order[b.category] || a.name.localeCompare(b.name)).map(c => c.key);
    const editable = k => ['switch', 'lock', 'select', 'number'].includes(cols.get(k).kind) && !['external_temperature_input', 'sensor'].includes(k);
    const feed = d.feed;
    el.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>Sensore della stanza per le valvole</h2><label class="toggle"><input type="checkbox" id="feed-all" ${feed.enabled ? 'checked' : ''}><span></span></label></div>
        <p class="note">${feed.enabled ? 'NIDO mette le valvole su <b>external</b> e invia loro la temperatura del sensore della stanza a ogni variazione e almeno ogni 5 minuti: la valvola regola sulla temperatura vera della stanza e non su quella vicino al termosifone. Le vecchie automazioni di Home Assistant che facevano lo stesso vanno lasciate spente.' : 'Disattivato: le valvole usano il proprio sensore interno.'}</p>
        <div class="scroll"><table><thead><tr><th>Stanza</th><th>Usa NIDO</th><th>Sensore valvola</th><th>Inviato</th><th>La valvola usa</th><th>Stato</th></tr></thead><tbody>
        ${d.valves.map(v => { const f = v.feed; const l = f.link; return `<tr>
          <td><b>${esc(v.name)}</b></td>
          <td><label class="toggle"><input type="checkbox" data-feed="${v.room}" ${f.active ? 'checked' : ''} ${feed.enabled ? '' : 'disabled'}><span></span></label></td>
          <td>${l?.mode ? esc(l.mode) : '–'}</td>
          <td>${f.sent != null ? `${n1(f.sent)}° alle ${hhmm(f.at)}` : '–'}</td>
          <td>${l?.local != null ? `${n1(l.local)}°` : '–'}</td>
          <td>${f.error ? `<span class="warn-t">${esc(f.error)}</span>` : !f.active ? '<span class="note">sensore interno</span>' : f.ok === true ? '✅ ricevuto' : f.ok === false ? '<span class="warn-t">la valvola non conferma il valore</span>' : 'in attesa di conferma'}</td></tr>`; }).join('')}
        </tbody></table></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><h2>Impostazioni di ogni valvola</h2><button class="btn small" id="vv-reload">Aggiorna</button></div>
        <p class="note">Ogni colonna è una funzione del dispositivo (Zigbee2MQTT). Le modifiche valgono subito. Con <b>Applica a tutte</b> copi il valore della prima riga, o quello scelto, su tutte le valvole.</p>
        <div class="scroll"><table class="vtable"><thead><tr><th>Stanza</th>${keys.map(k => `<th title="${esc(cols.get(k).help ?? '')}">${esc(cols.get(k).name)}${cols.get(k).unit ? ` <small>${esc(cols.get(k).unit)}</small>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${d.valves.map(v => `<tr><td><b>${esc(v.name)}</b><small>${esc(v.controls?.deviceName ?? '')}</small></td>${keys.map(k => cell(v.room, v.controls?.device.find(x => x.key === k), v.feed.active)).join('')}</tr>`).join('')}
        <tr class="bulk"><td><b>Applica a tutte</b></td>${keys.map(k => editable(k) ? `<td><button class="btn small" data-bulk="${esc(k)}">↧ Copia</button></td>` : '<td></td>').join('')}</tr></tbody></table></div>
        <p class="note">Il <b>sensore</b> della valvola e la <b>temperatura esterna inviata</b> li gestisce il riquadro sopra.</p>
      </div>`;
  }

  const root = () => document.getElementById('valvole');
  const act = (room, entity_id, value) => post(`api/rooms/${room}/action`, { action: 'entity', entity_id, value });
  document.addEventListener('change', async e => {
    if (!root()?.contains(e.target)) return;
    const t = e.target;
    try {
      if (t.id === 'feed-all') { await post('api/valves/feed', { enabled: t.checked }); toast(t.checked ? 'NIDO invia la temperatura alle valvole' : 'Valvole sul sensore interno'); }
      else if (t.dataset.feed) { await post('api/valves/feed', { rooms: { [t.dataset.feed]: t.checked } }); toast('Fatto'); }
      else if (t.dataset.e) { const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value; const r = await act(t.dataset.vr, t.dataset.e, v); toast(r.message); }
      else return;
    } catch (err) { toast(`Non eseguito: ${err.message}`, true); }
    setTimeout(() => window.loadValvole().catch(() => {}), 1500);
  });
  document.addEventListener('click', async e => {
    if (!root()?.contains(e.target)) return;
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.id === 'vv-reload') return window.loadValvole();
      if (b.dataset.press) { if (!confirm(`Avviare "${b.dataset.name}"?`)) return; const r = await act(b.dataset.vr, b.dataset.press); toast(r.message); return; }
      if (b.dataset.bulk) {
        const key = b.dataset.bulk;
        const first = data.valves.map(v => v.controls?.device.find(x => x.key === key)).find(Boolean);
        let value = first.kind === 'switch' ? first.state === 'on' : first.kind === 'lock' ? first.state === 'locked' : first.state;
        if (first.kind === 'number' || first.kind === 'select') {
          const ans = prompt(`Valore di "${first.name}" per tutte le valvole${first.options ? ` (${first.options.join(', ')})` : ''}`, String(value));
          if (ans == null) return;
          value = first.kind === 'number' ? Number(ans.replace(',', '.')) : ans;
        } else if (!confirm(`${first.name}: ${value ? 'attivo' : 'disattivo'} su tutte le valvole?`)) return;
        const r = await post('api/valves/bulk', { key, value });
        const bad = r.results.filter(x => !x.ok);
        toast(bad.length ? `Fatto, tranne: ${bad.map(x => x.room).join(', ')}` : 'Applicato a tutte le valvole', !!bad.length);
        setTimeout(() => window.loadValvole().catch(() => {}), 1500);
      }
    } catch (err) { toast(`Non eseguito: ${err.message}`, true); }
  });
})();
