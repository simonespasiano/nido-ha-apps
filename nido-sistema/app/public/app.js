/* NIDO Sistema: interfaccia */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = p => fetch(p, { cache: 'no-store' }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
const post = (p, b = {}) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
let tt; const toast = (m, err = false) => { const t = $('#toast'); t.textContent = m; t.className = err ? 'error' : ''; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), err ? 6000 : 3000); };
const n1 = v => v == null ? '–' : Number(v).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const n0 = v => v == null ? '–' : Math.round(v).toLocaleString('it-IT');
const S = { ov: null, tab: 'stato', hours: 24, draft: null };

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.tab').forEach(s => (s.hidden = s.id !== `tab-${b.dataset.tab}`));
  S.tab = b.dataset.tab; S.draft = null; render(); if (S.tab === 'stato') loadHistory(); if (S.tab === 'diario') loadDiary();
}));

async function refresh() {
  try { S.ov = await api('api/overview'); render(); } catch (e) { $('#subtitle').textContent = `Server non raggiungibile (${e.message})`; }
  setTimeout(refresh, 5000);
}
function render() {
  const o = S.ov; if (!o) return;
  const s = o.snap, f = o.fan;
  $('#subtitle').textContent = `${s.model ?? 'Raspberry Pi'}${o.demo ? ' · demo simulata' : ''}`;
  const t = s.temps.cpu, pill = $('#status-pill'); pill.hidden = false;
  pill.innerHTML = `<span class="dot ${t >= o.alertTemp ? 'bad' : t >= 65 ? 'warn' : 'on'}"></span>CPU ${n1(t)} °C · ventola ${s.fan.percent ?? '–'}%`;
  $('#footer').textContent = `NIDO Sistema ${o.version} · ${o.bridge === 'mqtt' ? 'sensori e comandi via MQTT' : o.bridge === 'rest' ? 'sensori via REST' : 'nessuna entità in Home Assistant'}`;
  if (S.tab === 'stato') renderTiles();
  if (S.tab === 'ventola') renderFan();
}

function renderTiles() {
  const o = S.ov, s = o.snap;
  const warn = [];
  if (s.power.undervoltage) warn.push('<b>Sottotensione</b>L\'alimentatore non regge: per il Pi 5 serve quello ufficiale da 27 W (5 V 5 A).');
  if (s.power.throttledFlags.length) warn.push(`<b>Il firmware segnala</b>${s.power.throttledFlags.map(esc).join(', ')}`);
  if (o.fan.note) warn.push(`<b>Ventola</b>${esc(o.fan.note)}`);
  $('#banner').innerHTML = warn.map(w => `<div class="banner">${w}</div>`).join('');
  const cls = v => v == null ? '' : v >= o.alertTemp ? 'hot' : v >= 65 ? 'warm' : '';
  const up = s.uptime != null ? (s.uptime > 86400 ? `${Math.floor(s.uptime / 86400)} g ${Math.floor((s.uptime % 86400) / 3600)} h` : `${Math.floor(s.uptime / 3600)} h ${Math.floor((s.uptime % 3600) / 60)} min`) : '–';
  const tile = (label, val, unit, sub = '', c = '', bar = null) => `<div class="tile ${c}"><span>${label}</span><b>${val}${unit ? `<small>${unit}</small>` : ''}</b>${bar != null ? `<div class="bar"><i style="width:${Math.min(100, bar)}%"></i></div>` : ''}${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('#tiles').innerHTML = [
    tile('CPU', n1(s.temps.cpu), '°C', o.day.cpuMax != null ? `24 h: ${n1(o.day.cpuMin)}–${n1(o.day.cpuMax)} °C` : '', cls(s.temps.cpu)),
    s.temps.rp1 != null ? tile('Chip RP1', n1(s.temps.rp1), '°C', 'controller USB, rete, GPIO', cls(s.temps.rp1)) : '',
    s.temps.ssd != null ? tile('SSD', n1(s.temps.ssd), '°C', s.ssd?.model ? esc(s.ssd.model) : '', s.temps.ssd >= 70 ? 'hot' : s.temps.ssd >= 60 ? 'warm' : '') : '',
    o.fan.hasFan ? tile('Ventola', n0(s.fan.rpm), 'giri/min', `${s.fan.percent ?? '–'}% · ${esc(o.modes.find(m => m.id === o.fan.mode)?.label ?? '')}${o.fan.boostUntil ? ' · al massimo' : ''}`, '', s.fan.percent) : tile('Ventola', '–', '', 'non trovata'),
    tile('Uso CPU', n0(s.cpu.usage), '%', `${s.cpu.freqMHz ?? '–'} MHz di ${s.cpu.maxMHz ?? '–'} · carico ${s.cpu.load1?.toFixed(2) ?? '–'}`, '', s.cpu.usage),
    s.memory ? tile('Memoria', n0(s.memory.percent), '%', `${(s.memory.usedMB / 1024).toFixed(1)} di ${(s.memory.totalMB / 1024).toFixed(1)} GB`, '', s.memory.percent) : '',
    s.disk ? tile('Disco', n0(s.disk.percent), '%', `${n1(s.disk.usedGB)} di ${n1(s.disk.totalGB)} GB`, s.disk.percent > 90 ? 'hot' : '', s.disk.percent) : '',
    tile('Acceso da', up, '', s.power.undervoltage === false ? 'alimentazione ok' : ''),
  ].join('');
}

$('#hours').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; S.hours = Number(b.dataset.h); $('#hours').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); loadHistory(); });

function lineChart(series, { w, h = 220, keys, min, max, unit, fmtY }) {
  const pad = { l: 40, r: 10, t: 10, b: 24 };
  if (series.length < 2) return '<p class="note">Dati in raccolta: il grafico compare dopo qualche minuto.</p>';
  const t0 = series[0].ts, t1 = series.at(-1).ts;
  const vals = series.flatMap(p => keys.map(k => p[k.key])).filter(v => v != null);
  let lo = min ?? Math.floor(Math.min(...vals) / 5) * 5, hi = max ?? Math.ceil(Math.max(...vals) / 5) * 5;
  if (hi - lo < 10) hi = lo + 10;
  const x = t => pad.l + (w - pad.l - pad.r) * (t - t0) / Math.max(1, t1 - t0);
  const y = v => pad.t + (h - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
  const stepY = [5, 10, 20, 25, 50].find(st => (hi - lo) / st <= 6) ?? 50;
  for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) s += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtY(v)}</text>`;
  const span = t1 - t0, ticks = Math.max(3, Math.floor(w / 130));
  for (let i = 0; i <= ticks; i++) { const t = t0 + span * i / ticks; s += `<text x="${x(t)}" y="${h - 6}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${new Date(t).toLocaleString('it-IT', span > 2 * 86400_000 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' })}</text>`; }
  for (const k of keys) {
    let d = '', pen = false;
    for (const p of series) { const v = p[k.key]; if (v == null) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }
    s += `<path d="${d}" fill="none" stroke="${k.color}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  return s + '</svg>';
}

async function loadHistory() {
  let h; try { h = await api(`api/history?hours=${S.hours}`); } catch { return; }
  const w = Math.max(300, $('#ch-temp').clientWidth || 600);
  const tk = [{ key: 'cpu', label: 'CPU', color: 'var(--c2)' }, { key: 'rp1', label: 'RP1', color: 'var(--c4)' }, { key: 'ssd', label: 'SSD', color: 'var(--c1)' }].filter(k => h.series.some(p => p[k.key] != null));
  $('#leg-t').innerHTML = tk.map(k => `<span><i style="background:${k.color}"></i>${k.label}</span>`).join('');
  $('#ch-temp').innerHTML = lineChart(h.series, { w, keys: tk, unit: '°C', fmtY: v => `${Math.round(v)}°` });
  const fk = [{ key: 'fan', label: 'Ventola %', color: 'var(--c3)' }, { key: 'load', label: 'Uso CPU %', color: 'var(--c7)' }];
  $('#leg-f').innerHTML = fk.map(k => `<span><i style="background:${k.color}"></i>${k.label}</span>`).join('');
  $('#ch-fan').innerHTML = lineChart(h.series, { w, h: 180, keys: fk, min: 0, max: 100, fmtY: v => `${Math.round(v)}%` });
}

// ── Ventola ──
function curveChart(curve, ref, now, safety, w) {
  const h = 240, pad = { l: 38, r: 10, t: 10, b: 26 };
  const x = t => pad.l + (w - pad.l - pad.r) * (t - 30) / 60, y = v => pad.t + (h - pad.t - pad.b) * (1 - v / 100);
  const path = (pts, step) => {
    if (!pts?.length) return '';
    const P = [[30, pts[0][0] <= 30 ? pts[0][1] : pts[0][1]], ...pts.filter(p => p[0] >= 30 && p[0] <= 90), [90, pts.at(-1)[1]]];
    let d = `M${x(30)},${y(pts[0][1])}`;
    for (let i = 0; i < P.length; i++) d += step && i ? `H${x(P[i][0])}V${y(P[i][1])}` : `L${x(P[i][0])},${y(P[i][1])}`;
    return d;
  };
  let s = `<svg viewBox="0 0 ${w} ${h}" role="img"><rect class="safety" x="${x(safety)}" y="${pad.t}" width="${x(90) - x(safety)}" height="${h - pad.t - pad.b}"/>`;
  for (const v of [0, 25, 50, 75, 100]) s += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  for (let t = 30; t <= 90; t += 10) s += `<text x="${x(t)}" y="${h - 8}" text-anchor="middle">${t}°</text>`;
  s += `<path class="ref" d="${path(ref, true)}"/>`;
  if (curve) s += `<path class="cv" d="${path(curve, false)}"/>` + curve.filter(p => p[0] >= 30).map(p => `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="3.5" fill="var(--accent)"/>`).join('');
  if (now) s += `<circle class="now" cx="${x(Math.min(90, Math.max(30, now.t)))}" cy="${y(now.v)}" r="7"/>`;
  return s + '</svg>';
}
const FW = [[30, 0], [50, 29], [60, 49], [67.5, 69], [75, 98]];

function renderFan() {
  const o = S.ov, f = o.fan, s = o.snap;
  const mode = S.draft?.mode ?? f.mode;
  $('#fan-note').innerHTML = !f.hasFan ? '<div class="banner"><b>Ventola non trovata</b>L\'Active Cooler non risulta collegato, oppure il sistema non espone il driver della ventola.</div>'
    : f.note ? `<div class="banner bad"><b>Non posso comandare la ventola</b>${esc(f.note)}${f.supervisor ? `<br><span class="note">Secondo Home Assistant: Modalità protezione <b>${f.supervisor.protected ? 'attiva' : 'disattivata'}</b>; accesso completo ${f.fullAccess ? 'presente' : 'assente'} nel processo dell'app.${f.supervisor.protected === false && !f.fullAccess ? ' La protezione risulta spenta ma l\'app non ha ricevuto i permessi: premi Arresta e poi Avvia (non Riavvia), o riavvia il sistema.' : ''}</span>` : ''}</div>` : '';
  $('#modes').innerHTML = o.modes.map(m => `<button class="mode ${m.id === mode ? 'on' : ''}" data-mode="${m.id}"><b>${esc(m.label)}</b><small>${esc(m.help)}</small></button>`).join('');
  const sel = o.modes.find(m => m.id === mode);
  const curve = mode === 'personalizzata' ? (S.draft?.custom ?? f.custom) : sel?.curve;
  const w = Math.max(300, $('#ch-curve').clientWidth || 500);
  $('#ch-curve').innerHTML = curveChart(curve, FW, s.temps.cpu != null ? { t: s.temps.cpu, v: s.fan.percent ?? 0 } : null, o.safety, w);
  $('#curve-note').textContent = `Adesso: CPU ${n1(s.temps.cpu)} °C, ventola ${s.fan.percent ?? '–'}%${f.target != null ? ` (comandata ${f.target}%)` : ' (decide il firmware)'}. Oltre ${o.safety} °C (zona rossa) la ventola va sempre al massimo. La linea tratteggiata è il comportamento del firmware.`;
  if (S.draft && document.activeElement?.closest?.('#fan-side')) return; // non ridisegnare mentre si scrive
  const d = S.draft ?? { mode: f.mode, custom: f.custom.map(p => [...p]), hyst: f.hyst, useHottest: f.useHottest };
  $('#fan-side').innerHTML = `
    <div class="card-head"><h2>${esc(sel?.label ?? '')}</h2>${f.inControl ? '<span class="pill on">comandata dall\'app</span>' : '<span class="pill">firmware</span>'}</div>
    ${mode === 'personalizzata' ? `<div class="pts">${d.custom.map((p, i) => `<div class="row" data-i="${i}"><label>a <input type="number" step="0.5" min="20" max="90" value="${p[0]}" data-pt="0"> °C</label><label><input type="number" min="0" max="100" value="${p[1]}" data-pt="1"> %</label><button class="btn small danger" data-del ${d.custom.length <= 2 ? 'disabled' : ''}>Togli</button></div>`).join('')}
      <div class="row"><button class="btn small" data-add ${d.custom.length >= 10 ? 'disabled' : ''}>+ Punto</button></div></div>` : ''}
    ${mode !== 'auto' ? `<div class="f-row"><label>Scende solo dopo un calo di <input type="number" min="1" max="10" value="${d.hyst}" data-hyst> °C</label></div>
      <label class="check"><input type="checkbox" data-hot ${d.useHottest ? 'checked' : ''}><span>Guida con la temperatura più alta fra CPU e chip RP1<small>Utile se usi molto USB o rete</small></span></label>` : '<p class="note">Il Raspberry gestisce la ventola da solo. L\'app la legge soltanto.</p>'}
    <div class="go"><button class="btn primary" data-apply ${mode === f.mode && !S.draft?.dirty ? 'disabled' : ''}>Applica</button>${S.draft ? '<button class="btn small" data-cancel>Annulla</button>' : ''}</div>
    <h3>Raffredda ora</h3>
    <div class="go">${f.boostUntil ? `<span class="note">Al massimo fino alle ${new Date(f.boostUntil).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span><button class="btn small" data-boost="0">Ferma</button>` : '<button class="btn small" data-boost="15">Massimo 15 minuti</button><button class="btn small" data-boost="60">1 ora</button>'}</div>`;
  S.draftBase = d;
}

$('#modes').addEventListener('click', ev => {
  const b = ev.target.closest('[data-mode]'); if (!b) return;
  const f = S.ov.fan;
  S.draft = { ...(S.draft ?? { custom: f.custom.map(p => [...p]), hyst: f.hyst, useHottest: f.useHottest }), mode: b.dataset.mode, dirty: true };
  if (b.dataset.mode === 'personalizzata' && !S.draft.customTouched) {
    // si parte dalla curva attualmente scelta, se ce n'è una
    const cur = S.ov.modes.find(m => m.id === f.mode)?.curve;
    if (cur && f.mode !== 'personalizzata') S.draft.custom = cur.filter(p => p[0] >= 20).map(p => [...p]);
    if (S.draft.custom.length < 2) S.draft.custom = [[45, 0], [55, 40], [70, 100]];
  }
  renderFan();
});
$('#fan-side').addEventListener('input', ev => {
  const t = ev.target, d = S.draft = { ...(S.draft ?? S.draftBase), dirty: true };
  d.mode = d.mode ?? S.ov.fan.mode;
  const row = t.closest('[data-i]');
  if (row && t.dataset.pt != null) { d.custom = d.custom.map(p => [...p]); d.custom[row.dataset.i][Number(t.dataset.pt)] = Number(t.value); d.customTouched = true; }
  else if (t.hasAttribute('data-hyst')) d.hyst = Number(t.value);
  else if (t.hasAttribute('data-hot')) d.useHottest = t.checked;
  const sel = S.ov.modes.find(m => m.id === d.mode);
  const curve = d.mode === 'personalizzata' ? [...d.custom].sort((a, b) => a[0] - b[0]) : sel?.curve;
  $('#ch-curve').innerHTML = curveChart(curve, FW, S.ov.snap.temps.cpu != null ? { t: S.ov.snap.temps.cpu, v: S.ov.snap.fan.percent ?? 0 } : null, S.ov.safety, Math.max(300, $('#ch-curve').clientWidth || 500));
  const ap = $('#fan-side [data-apply]'); if (ap) ap.disabled = false;
});
$('#fan-side').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b || b.disabled) return;
  const d = S.draft ?? { ...S.draftBase };
  try {
    if (b.hasAttribute('data-add')) { const last = d.custom.at(-1); d.custom = [...d.custom, [Math.min(90, (last?.[0] ?? 60) + 5), 100]]; S.draft = { ...d, dirty: true, customTouched: true }; return renderFan(); }
    if (b.hasAttribute('data-del')) { const i = Number(b.closest('[data-i]').dataset.i); d.custom = d.custom.filter((_, k) => k !== i); S.draft = { ...d, dirty: true, customTouched: true }; return renderFan(); }
    if (b.hasAttribute('data-cancel')) { S.draft = null; return renderFan(); }
    if (b.hasAttribute('data-apply')) { await post('api/fan', { mode: d.mode, custom: d.custom, hyst: d.hyst, useHottest: d.useHottest }); S.draft = null; toast('Ventola aggiornata'); }
    else if (b.dataset.boost != null) { await post('api/boost', { minutes: Number(b.dataset.boost) }); toast(Number(b.dataset.boost) ? 'Ventola al massimo' : 'Fine del massimo'); }
    else return;
  } catch (e) { toast(e.message, true); }
  S.ov = await api('api/overview'); render();
});

// ── Diario ──
async function loadDiary() {
  let l; try { l = await api('api/log'); } catch (e) { $('#diary').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const o = S.ov;
  $('#diary').innerHTML = `<div class="settings">
    <div class="card"><div class="card-head"><h2>Avvisi</h2></div>
      <p class="note">Avvisa se la CPU resta sopra ${o?.alertTemp ?? 75} °C per oltre 2 minuti, se c'è sottotensione o se la ventola risulta ferma quando dovrebbe girare.</p>
      <p class="note">${o?.notify.length ? `Notifiche a ${o.notify.map(esc).join(', ')}` : 'Nessun servizio di notifica: aggiungilo nell\'opzione <code>notifiche</code> (es. mobile_app_iphone_di_simone).'}</p>
      ${o?.notify.length ? '<div class="go"><button class="btn small" id="test">Manda una notifica di prova</button></div>' : ''}</div>
    <div class="card" style="grid-column:1/-1"><div class="card-head"><h2>Diario</h2></div>
      <div class="log">${l.log.map(x => `<div><time>${new Date(x.ts).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>${esc(x.message)}${x.user ? ` · ${esc(x.user)}` : ''}</div>`).join('') || '<div>vuoto</div>'}</div>
      <details><summary>Registro dell'app</summary><div class="log">${l.app.map(x => `<div><time>${new Date(x.ts).toLocaleTimeString('it-IT')}</time>${esc(x.msg)}</div>`).join('')}</div></details></div></div>`;
}
$('#diary').addEventListener('click', async ev => { if (ev.target.id !== 'test') return; try { await post('api/notify/test'); toast('Notifica inviata'); } catch (e) { toast(e.message, true); } });

refresh(); loadHistory(); setInterval(() => { if (S.tab === 'stato') loadHistory(); }, 60_000);
