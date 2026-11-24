// Automazioni: quando (orario, sole, presenza, sensori…), a quali condizioni, cosa fare.
let rulesData = null;
let settingsCache = null;
const OPS = { sopra: 'sopra', sotto: 'sotto' };

function targetLabel(t) {
  if (t === 'all') return 'tutte';
  if (t.startsWith('area:')) return ov.areas.find(a => a.id === t.slice(5))?.name ?? t.slice(5);
  if (t.startsWith('gruppo:')) return t.slice(7);
  return ov.shutters.find(s => s.id === t)?.name ?? t;
}
const entName = e => settingsCache?.sensors.find(s => s.entity === e)?.name ?? e;

function describeTrigger(t) {
  switch (t.type) {
    case 'orario': return `alle ${t.time}`;
    case 'sole': return `${t.offset ? `${Math.abs(t.offset)} min ${t.offset < 0 ? 'prima' : 'dopo'} ${t.event === 'alba' ? "l'alba" : 'il tramonto'}` : t.event === 'alba' ? "all'alba" : 'al tramonto'}`;
    case 'elevazione': return `quando il sole ${t.op === 'sopra' ? 'sale sopra' : 'scende sotto'} ${t.value}°`;
    case 'presenza': return t.event === 'tutti_fuori' ? 'quando escono tutti' : 'quando rientra qualcuno';
    case 'sensore': return `quando ${entName(t.entity)} è ${OPS[t.op]} ${t.value}${t.forMin ? ` per ${t.forMin} min` : ''}`;
    case 'stato': return `quando ${entName(t.entity)} diventa "${t.to}"${t.forMin ? ` per ${t.forMin} min` : ''}`;
    case 'modalita': return `quando la modalità diventa ${ov.overview.modeLabel[t.to]}`;
  }
  return '';
}
function describeAction(a) {
  if (a.type === 'scenario') return `scenario ${ov.scenes.find(s => s.id === a.scene)?.name ?? '?'}`;
  const who = a.targets.map(targetLabel).join(', ');
  return a.type === 'preferita' ? `${who}: posizione preferita` : `${who}: ${posLabel(a.position)}`;
}
function describeRule(r) {
  const c = r.conditions, parts = [];
  if (r.days.length && r.days.length < 7) parts.push(r.days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(d => DAYS[d]).join(' '));
  if (c.after || c.before) parts.push(`${c.after ? `dopo le ${c.after}` : ''}${c.after && c.before ? ' e ' : ''}${c.before ? `prima delle ${c.before}` : ''}`);
  if (c.modes.length) parts.push(`modalità ${c.modes.map(m => ov.overview.modeLabel[m]).join('/')}`);
  if (c.seasons.length) parts.push(c.seasons.join('/'));
  if (c.presence) parts.push(c.presence === 'casa' ? 'con qualcuno in casa' : 'con la casa vuota');
  if (c.entity) parts.push(`${entName(c.entity)} = ${c.entityState}`);
  const dir = r.onlyDirection === 'solo_apri' ? ' (solo se deve aprirsi)' : r.onlyDirection === 'solo_chiudi' ? ' (solo se deve chiudersi)' : '';
  return `${describeTrigger(r.trigger)} → ${describeAction(r.action)}${dir}${parts.length ? ` · ${parts.join(' · ')}` : ''}${r.overrideManual ? ' · anche se mossa a mano' : ''}`;
}

async function renderRules() {
  const el = $('#automazioni');
  [rulesData, settingsCache] = await Promise.all([api('api/rules'), settingsCache ? Promise.resolve(settingsCache) : api('api/settings')]);
  el.innerHTML = `
    <div class="two">
      <div class="card"><h2>Prossimi movimenti</h2>
        <div class="next-list">${rulesData.next.slice(0, 10).map(n => `<div><time>${when(n.ts)}</time><span>${esc(n.name)} → ${esc(n.text)} <span class="note">(${n.shutters.length})</span></span></div>`).join('') || '<span class="note">Nessuno nelle prossime 30 ore</span>'}</div>
        ${ov.overview.effective === 'vacanza' && settingsCache.global.simulate.enabled ? `<p class="note">🎲 Vacanza: gli orari variano ogni giorno di ±${settingsCache.global.simulate.jitter} minuti per simulare la presenza.</p>` : ''}
      </div>
      <div class="card"><h2>Come si comportano</h2>
        <p class="note" style="margin:0">Se muovi una tapparella a mano (pulsante a muro, app, Home Assistant) le automazioni la lasciano stare
          ${settingsCache.global.holdMode === 'prossimo' ? 'fino al prossimo movimento programmato' : settingsCache.global.holdMode === 'minuti' ? `per ${settingsCache.global.holdMinutes} minuti` : '— no: con l\'impostazione attuale agiscono sempre'}.
          Con la porta aperta non vengono chiuse. Se il sole batte sulla finestra, un'apertura si ferma alla posizione d'ombra.</p>
        <p class="note">Ultime decisioni:</p>
        <div class="next-list">${ov.overview.decisions.slice(0, 5).map(d => `<div><time>${hhmm(d.ts)}</time><span>${esc(d.text)}</span></div>`).join('') || '<span class="note">—</span>'}</div>
      </div>
    </div>
    <h3 class="area-title">Automazioni</h3>
    <div class="list">${rulesData.rules.map(r => `
      <div class="card rule">
        <span class="toggle"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''}><span></span></span>
        <div><b>${esc(r.name)}</b><p>${esc(describeRule(r))}</p>${r.enabled && r.next ? `<p>⏱ prossima: ${when(r.next)}</p>` : ''}</div>
        <div class="acts"><button class="btn small" data-runr="${r.id}">Esegui ora</button><button class="btn small" data-editr="${r.id}">Modifica</button></div>
      </div>`).join('') || '<div class="empty">Nessuna automazione.</div>'}</div>
    <div class="dlg-actions" style="justify-content:flex-start"><button class="btn primary" id="r-new">+ Nuova automazione</button></div>`;
}

$('#automazioni').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.id === 'r-new') return templateDialog();
  if (b.dataset.editr) return ruleDialog(rulesData.rules.find(r => r.id === b.dataset.editr));
  if (b.dataset.runr) { await run(() => api(`api/rules/${b.dataset.runr}/run`, {}), r => r.message || 'Eseguita'); refreshSoon(); renderRules(); }
});
$('#automazioni').addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.toggle) { await run(() => api(`api/rules/${t.dataset.toggle}/toggle`, { enabled: t.checked }), t.checked ? 'Automazione attivata' : 'Automazione spenta'); renderRules(); }
});

const emptyCond = () => ({ after: null, before: null, modes: [], seasons: [], presence: null, entity: null, entityState: null });
const TEMPLATES = [
  { icon: '🌅', name: 'Apri al mattino', rule: { trigger: { type: 'orario', time: '07:30' }, days: [1, 2, 3, 4, 5], action: { type: 'posizione', targets: ['all'], position: 100 }, onlyDirection: 'solo_apri' } },
  { icon: '🌇', name: 'Chiudi al tramonto', rule: { trigger: { type: 'sole', event: 'tramonto', offset: 15 }, days: [], action: { type: 'posizione', targets: ['all'], position: 0 }, onlyDirection: 'solo_chiudi' } },
  { icon: '🚶', name: 'Chiudi quando usciamo', rule: { trigger: { type: 'presenza', event: 'tutti_fuori' }, days: [], action: { type: 'posizione', targets: ['all'], position: 0 }, onlyDirection: 'solo_chiudi', overrideManual: true } },
  { icon: '🏠', name: 'Apri quando rientriamo (di giorno)', rule: { trigger: { type: 'presenza', event: 'primo_rientro' }, days: [], action: { type: 'preferita', targets: ['all'] }, conditions: { ...emptyCond(), after: '08:00', before: '19:00' }, onlyDirection: 'solo_apri', overrideManual: true } },
  { icon: '🌡️', name: 'Abbassa se fuori fa molto caldo', rule: { trigger: { type: 'sensore', entity: '', op: 'sopra', value: 30, forMin: 15 }, days: [], action: { type: 'posizione', targets: ['all'], position: 30 }, onlyDirection: 'solo_chiudi' } },
  { icon: '🔅', name: 'Abbassa quando fa buio', rule: { trigger: { type: 'sensore', entity: '', op: 'sotto', value: 50, forMin: 10 }, days: [], action: { type: 'posizione', targets: ['all'], position: 0 }, conditions: { ...emptyCond(), after: '16:00' }, onlyDirection: 'solo_chiudi' } },
  { icon: '✳️', name: 'Vuota', rule: { trigger: { type: 'orario', time: '08:00' }, days: [], action: { type: 'posizione', targets: [], position: 100 }, onlyDirection: 'tutte' } },
];
function templateDialog() {
  const body = openDlg('Nuova automazione', 'Parti da un modello, poi adattalo', `<div class="list">${TEMPLATES.map((t, i) => `
    <button class="btn" style="text-align:left;padding:10px 14px" data-tpl="${i}">${t.icon} ${esc(t.name)}</button>`).join('')}</div>`);
  body.querySelectorAll('[data-tpl]').forEach(b => b.onclick = () => {
    const t = TEMPLATES[Number(b.dataset.tpl)];
    const r = { id: null, name: t.name === 'Vuota' ? '' : t.name, enabled: true, conditions: emptyCond(), overrideManual: false, notify: false, ...structuredClone(t.rule) };
    if (r.trigger.type === 'sensore' && !r.trigger.entity) {
      const want = t.icon === '🔅' ? 'luce' : 'temperatura';
      const o = settingsCache.outdoor; r.trigger.entity = (want === 'luce' ? o.lux : o.temp) ?? '';
    }
    ruleDialog(r);
  });
}

function ruleDialog(r) {
  const sensors = settingsCache.sensors;
  const numeric = sensors.filter(s => s.domain === 'sensor');
  const stateful = sensors.filter(s => s.domain === 'binary_sensor' || s.domain === 'weather');
  const t = r.trigger, a = r.action, c = r.conditions;
  const targetChips = [['all', 'Tutte'], ...ov.areas.map(x => [`area:${x.id}`, `▣ ${x.name}`]), ...ov.groups.map(g => [`gruppo:${g}`, `◈ ${g}`]), ...ov.shutters.map(s => [s.id, s.name])];
  const sensOpt = (list, sel) => list.map(s => `<option value="${s.entity}" ${s.entity === sel ? 'selected' : ''}>${esc(s.name)}${s.unit ? ` (${esc(s.unit)})` : ''}${s.areaName ? ` · ${esc(s.areaName)}` : ''}</option>`).join('');
  const body = openDlg(r.id ? 'Modifica automazione' : 'Nuova automazione', '', `
    <div class="form">
      <label class="frow"><span>Nome</span><input type="text" id="r-name" value="${esc(r.name)}"></label>
      <label class="frow"><span>Attiva</span><span class="toggle"><input type="checkbox" id="r-enabled" ${r.enabled ? 'checked' : ''}><span></span></span></label>
      <h3 class="area-title">Quando</h3>
      <label class="frow"><span>Avvio</span><select id="r-type">
        ${[['orario', 'A un orario'], ['sole', 'Alba o tramonto'], ['elevazione', 'Altezza del sole'], ['presenza', 'Presenza in casa'], ['sensore', 'Valore di un sensore'], ['stato', 'Stato di un sensore (porta, pioggia…)'], ['modalita', 'Cambio di modalità']]
          .map(([k, v]) => `<option value="${k}" ${t.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <div id="r-trig"></div>
      <div class="frow col"><span>Giorni <small>nessuno = tutti</small></span><div class="chips" id="r-days">${[1, 2, 3, 4, 5, 6, 0].map(d => `<button type="button" class="chip small ${r.days.includes(d) ? 'on' : ''}" data-day="${d}">${DAYS[d]}</button>`).join('')}</div></div>
      <h3 class="area-title">Cosa fare</h3>
      <label class="frow"><span>Azione</span><select id="r-atype">
        <option value="posizione" ${a.type === 'posizione' ? 'selected' : ''}>Porta a una posizione</option>
        <option value="preferita" ${a.type === 'preferita' ? 'selected' : ''}>Porta alla posizione preferita di ognuna</option>
        <option value="scenario" ${a.type === 'scenario' ? 'selected' : ''} ${ov.scenes.length ? '' : 'disabled'}>Avvia uno scenario</option></select></label>
      <div class="frow col" id="r-targets-row"><span>Tapparelle</span><div class="chips" id="r-targets">${targetChips.map(([k, v]) => `<button type="button" class="chip small ${(a.targets ?? []).includes(k) ? 'on' : ''}" data-t="${esc(k)}">${esc(v)}</button>`).join('')}</div></div>
      <label class="frow" id="r-pos-row"><span>Posizione <small>0 chiusa · 100 aperta</small></span><span><input type="range" class="rng" id="r-pos" min="0" max="100" step="5" value="${a.position ?? 0}" style="width:160px"> <b id="r-posv">${a.position ?? 0}%</b></span></label>
      <label class="frow" id="r-scene-row"><span>Scenario</span><select id="r-scene">${ov.scenes.map(s => `<option value="${s.id}" ${a.scene === s.id ? 'selected' : ''}>${esc(s.icon)} ${esc(s.name)}</option>`).join('')}</select></label>
      <label class="frow"><span>Muovi solo se<small>Utile per non riaprire chi è già più chiusa (o il contrario)</small></span><select id="r-dir">
        <option value="tutte" ${r.onlyDirection === 'tutte' ? 'selected' : ''}>sempre</option>
        <option value="solo_apri" ${r.onlyDirection === 'solo_apri' ? 'selected' : ''}>deve aprirsi di più</option>
        <option value="solo_chiudi" ${r.onlyDirection === 'solo_chiudi' ? 'selected' : ''}>deve chiudersi di più</option></select></label>
      <h3 class="area-title">Solo se</h3>
      <label class="frow"><span>Dopo le / prima delle</span><span><input type="time" id="c-after" value="${c.after ?? ''}" class="inp"> – <input type="time" id="c-before" value="${c.before ?? ''}" class="inp"></span></label>
      <div class="frow col"><span>Modalità <small>nessuna = qualsiasi</small></span><div class="chips" id="c-modes">${['casa', 'fuori', 'vacanza'].map(m => `<button type="button" class="chip small ${c.modes.includes(m) ? 'on' : ''}" data-m="${m}">${ov.overview.modeLabel[m]}</button>`).join('')}</div></div>
      <div class="frow col"><span>Stagione <small>nessuna = sempre</small></span><div class="chips" id="c-seasons">${[['estate', 'Estate'], ['mezza', 'Mezza stagione'], ['inverno', 'Inverno']].map(([k, v]) => `<button type="button" class="chip small ${c.seasons.includes(k) ? 'on' : ''}" data-s="${k}">${v}</button>`).join('')}</div></div>
      <label class="frow"><span>Presenza</span><select id="c-pres"><option value="">qualsiasi</option><option value="casa" ${c.presence === 'casa' ? 'selected' : ''}>qualcuno in casa</option><option value="fuori" ${c.presence === 'fuori' ? 'selected' : ''}>casa vuota</option></select></label>
      <label class="frow"><span>Un'entità è in uno stato<small>es. finestra chiusa, meteo "sunny"</small></span><span><select id="c-ent"><option value="">—</option>${sensOpt(stateful, c.entity)}</select> = <input type="text" id="c-state" class="inp" style="width:80px" value="${esc(c.entityState ?? '')}" placeholder="off"></span></label>
      <h3 class="area-title">Altro</h3>
      <label class="frow"><span>Anche se mossa a mano<small>Altrimenti salta le tapparelle comandate di recente a mano</small></span><span class="toggle"><input type="checkbox" id="r-over" ${r.overrideManual ? 'checked' : ''}><span></span></span></label>
      <label class="frow"><span>Avvisami quando scatta</span><span class="toggle"><input type="checkbox" id="r-notify" ${r.notify ? 'checked' : ''}><span></span></span></label>
    </div>
    <div class="dlg-actions">${r.id ? '<button class="btn danger left" id="r-del">Elimina</button>' : ''}<button class="btn primary" id="r-save">Salva</button></div>`, true);
  const q = s => body.querySelector(s);
  const trigFields = () => {
    const ty = q('#r-type').value, cur = ty === t.type ? t : {};
    const f = {
      orario: `<label class="frow"><span>Ora</span><input type="time" id="t-time" value="${cur.time ?? '07:30'}"></label>`,
      sole: `<label class="frow"><span>Momento</span><select id="t-event"><option value="alba" ${cur.event === 'alba' ? 'selected' : ''}>Alba</option><option value="tramonto" ${cur.event !== 'alba' ? 'selected' : ''}>Tramonto</option></select></label>
        <label class="frow"><span>Spostamento in minuti<small>negativo = prima</small></span><input type="number" id="t-offset" min="-240" max="240" step="5" value="${cur.offset ?? 0}"></label>`,
      elevazione: `<label class="frow"><span>Il sole</span><span><select id="t-op"><option value="sopra" ${cur.op !== 'sotto' ? 'selected' : ''}>sale sopra</option><option value="sotto" ${cur.op === 'sotto' ? 'selected' : ''}>scende sotto</option></select> <input type="number" id="t-value" min="-10" max="70" value="${cur.value ?? 10}" style="width:70px"> °</span></label>`,
      presenza: `<label class="frow"><span>Evento</span><select id="t-pevent"><option value="tutti_fuori" ${cur.event !== 'primo_rientro' ? 'selected' : ''}>Escono tutti</option><option value="primo_rientro" ${cur.event === 'primo_rientro' ? 'selected' : ''}>Rientra il primo</option></select></label>`,
      sensore: `<label class="frow"><span>Sensore</span><select id="t-ent">${sensOpt(numeric, cur.entity)}</select></label>
        <label class="frow"><span>Quando è</span><span><select id="t-op"><option value="sopra" ${cur.op !== 'sotto' ? 'selected' : ''}>sopra</option><option value="sotto" ${cur.op === 'sotto' ? 'selected' : ''}>sotto</option></select> <input type="number" id="t-value" step="any" value="${cur.value ?? 0}" style="width:90px"></span></label>
        <label class="frow"><span>Per almeno (minuti)</span><input type="number" id="t-for" min="0" max="240" value="${cur.forMin ?? 5}"></label>`,
      stato: `<label class="frow"><span>Entità</span><select id="t-ent">${sensOpt(stateful, cur.entity)}</select></label>
        <label class="frow"><span>Diventa<small>on/off per i sensori, es. "rainy" per il meteo</small></span><input type="text" id="t-to" value="${esc(cur.to ?? 'on')}"></label>
        <label class="frow"><span>Per almeno (minuti)</span><input type="number" id="t-for" min="0" max="240" value="${cur.forMin ?? 0}"></label>`,
      modalita: `<label class="frow"><span>Nuova modalità</span><select id="t-mode">${['casa', 'fuori', 'vacanza', 'pausa'].map(m => `<option value="${m}" ${cur.to === m ? 'selected' : ''}>${ov.overview.modeLabel[m]}</option>`).join('')}</select></label>`,
    };
    q('#r-trig').innerHTML = f[ty];
  };
  const actFields = () => {
    const ty = q('#r-atype').value;
    q('#r-targets-row').hidden = ty === 'scenario'; q('#r-pos-row').hidden = ty !== 'posizione'; q('#r-scene-row').hidden = ty !== 'scenario';
  };
  trigFields(); actFields();
  q('#r-type').onchange = trigFields; q('#r-atype').onchange = actFields;
  q('#r-pos').oninput = () => q('#r-posv').textContent = `${q('#r-pos').value}%`;
  body.querySelectorAll('.chip[data-day], .chip[data-t], .chip[data-m], .chip[data-s]').forEach(b => b.onclick = () => b.classList.toggle('on'));
  const on = (sel, attr) => [...body.querySelectorAll(sel)].filter(b => b.classList.contains('on')).map(b => b.dataset[attr]);
  q('#r-save').onclick = async () => {
    const ty = q('#r-type').value;
    const val = id => q(id)?.value;
    const trigger = { type: ty, time: val('#t-time'), event: ty === 'presenza' ? val('#t-pevent') : val('#t-event'), offset: Number(val('#t-offset') ?? 0),
      op: val('#t-op'), value: Number(val('#t-value') ?? 0), entity: val('#t-ent'), forMin: Number(val('#t-for') ?? 0), to: ty === 'modalita' ? val('#t-mode') : val('#t-to') };
    const at = q('#r-atype').value;
    const payload = {
      id: r.id, name: q('#r-name').value, enabled: q('#r-enabled').checked, trigger,
      days: on('.chip[data-day]', 'day').map(Number),
      action: at === 'scenario' ? { type: 'scenario', scene: q('#r-scene').value } : { type: at, targets: on('.chip[data-t]', 't'), position: Number(q('#r-pos').value) },
      onlyDirection: q('#r-dir').value, overrideManual: q('#r-over').checked, notify: q('#r-notify').checked,
      conditions: { after: q('#c-after').value || null, before: q('#c-before').value || null, modes: on('.chip[data-m]', 'm'), seasons: on('.chip[data-s]', 's'),
        presence: q('#c-pres').value || null, entity: q('#c-ent').value || null, entityState: q('#c-state').value || null },
    };
    await run(() => api('api/rules', payload), 'Automazione salvata');
    closeDlg(); renderRules(); refresh();
  };
  q('#r-del')?.addEventListener('click', async () => {
    if (!confirm(`Eliminare "${r.name}"?`)) return;
    await run(() => api(`api/rules/${r.id}/delete`, {}), 'Eliminata'); closeDlg(); renderRules();
  });
}

loaders.automazioni = () => renderRules().catch(e => toast(e.message, true));
