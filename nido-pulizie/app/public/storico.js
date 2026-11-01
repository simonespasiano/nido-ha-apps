/* Schede Storico, Statistiche e Impostazioni */
(function () {
  // ── Storico ──
  let histView = 'pulizie';
  async function loadHistory() {
    const days = $('#hist-days').value;
    const el = $('#history');
    try {
      if (histView === 'pulizie') renderSessions(await api(`api/sessions?days=${days}`));
      else renderEvents(await api(`api/events?days=${days}`));
    } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; }
  }
  App.hooks.storico = loadHistory;
  $('#hist-days').addEventListener('change', loadHistory);
  $('#hist-view').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    histView = b.dataset.v;
    $('#hist-view').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    loadHistory();
  });

  function byDay(items, ts) {
    const groups = new Map();
    for (const it of items) {
      const k = new Date(ts(it)).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    return groups;
  }

  function renderSessions(list) {
    const el = $('#history');
    if (!list.length) { el.innerHTML = '<p class="empty">Nessuna pulizia nel periodo. Le pulizie vengono registrate da quando l\'app è collegata al robot, anche quelle avviate dall\'app Narwal.</p>'; return; }
    let html = '';
    for (const [day, ss] of byDay(list, s => s.start)) {
      html += `<div class="day">${esc(day)}</div><div class="list">` + ss.map(s => {
        const rooms = (s.visitedLabel.length ? s.visitedLabel : s.roomsLabel);
        return `<div class="item click" data-sess="${s.id}">
          <time>${fmtTime(s.start)}</time>
          <div class="main"><b>${rooms.length ? esc(rooms.join(', ')) : 'Pulizia'}</b><small>${esc(s.source)}${s.modeLabel ? ` · ${esc(s.modeLabel)}` : ''} · ${s.end ? esc(s.result ?? '') : 'in corso'}</small></div>
          <div class="num"><b>${s.area != null ? nf1.format(s.area) + ' m²' : '–'}</b>${fmtMin(s.duration)}${s.batteryStart != null && s.batteryEnd != null ? ` · −${Math.max(0, Math.round(s.batteryStart - s.batteryEnd))}%` : ''}</div>
        </div>`;
      }).join('') + '</div>';
    }
    el.innerHTML = html;
  }

  const ICON = { pulizia: '🧹', comando: '▸', programma: '🗓', casa: '🏠', robot: '🤖', impostazioni: '⚙' };
  function renderEvents(list) {
    const el = $('#history');
    if (!list.length) { el.innerHTML = '<p class="empty">Diario vuoto nel periodo.</p>'; return; }
    let html = '';
    for (const [day, es] of byDay(list, e => e.ts)) {
      html += `<div class="day">${esc(day)}</div><div class="list">` + es.map(e => `<div class="item"><time>${fmtTime(e.ts)}</time><div class="main">${ICON[e.kind] ?? '·'} ${esc(e.message)}${e.user ? `<small>da ${esc(e.user)}</small>` : ''}</div><div></div></div>`).join('') + '</div>';
    }
    el.innerHTML = html;
  }

  $('#history').addEventListener('click', async ev => {
    const it = ev.target.closest('[data-sess]');
    if (!it) return;
    try {
      const s = await api(`api/sessions/${it.dataset.sess}`);
      $('#sess-title').textContent = `Pulizia di ${fmtDate(s.start)} alle ${fmtTime(s.start)}`;
      $('#sess-sub').textContent = `${s.source}${s.end ? ` · ${s.result ?? ''}` : ' · in corso'}`;
      const L = App.ov?.labels;
      $('#sess-body').innerHTML = `<div class="sess-grid">
        <div class="map-wrap"><canvas id="sess-map"></canvas>${!App.map ? '<p class="note">Mappa non disponibile</p>' : ''}${App.map && !s.path.length ? '<p class="note">Percorso non registrato per questa pulizia</p>' : ''}</div>
        <dl class="kv">
          <dt>Inizio</dt><dd>${fmtTime(s.start)}</dd><dt>Fine</dt><dd>${s.end ? fmtTime(s.end) : 'in corso'}</dd>
          <dt>Durata</dt><dd>${fmtMin(s.duration)}</dd><dt>Superficie</dt><dd>${s.area != null ? nf1.format(s.area) + ' m²' : '–'}</dd>
          <dt>Velocità</dt><dd>${s.area && s.duration ? nf1.format(s.area / (s.duration / 60)) + ' m²/min' : '–'}</dd>
          <dt>Batteria</dt><dd>${s.batteryStart != null ? Math.round(s.batteryStart) + '%' : '–'} → ${s.batteryEnd != null ? Math.round(s.batteryEnd) + '%' : '–'}</dd>
          <dt>Modalità</dt><dd>${s.mode && L ? esc(L.mode[s.mode]) : '–'}</dd>
          <dt>Richieste</dt><dd>${s.roomsLabel.length ? esc(s.roomsLabel.join(', ')) : 'non note'}</dd>
          <dt>Pulite</dt><dd>${s.visitedLabel.length ? esc(s.visitedLabel.join(', ')) : '–'}</dd>
        </dl></div>`;
      $('#sess-dlg').showModal();
      if (App.map) NidoMap.draw($('#sess-map'), App.map, { path: s.path, selected: new Set(s.visited), maxHeight: 460 });
    } catch (e) { toast(e.message, true); }
  });

  // ── Statistiche ──
  let statDays = 30;
  $('#stats-days').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    statDays = Number(b.dataset.d);
    $('#stats-days').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    loadStats();
  });
  App.hooks.statistiche = loadStats;

  const delta = (a, b, unit = '') => {
    if (!b) return '<small>nessun confronto</small>';
    const d = a - b, pct = Math.round((d / b) * 100);
    return `<small>${d >= 0 ? '+' : ''}${pct}% rispetto ai ${statDays} giorni prima</small>`;
  };

  function bars(data, { w = 640, h = 180, label, value, fmt, color = 'var(--c1)', every = 1 }) {
    const pad = { l: 34, r: 8, t: 10, b: 22 };
    const max = Math.max(1, ...data.map(value));
    const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p) * p; })();
    const bw = (w - pad.l - pad.r) / data.length;
    const y = v => pad.t + (h - pad.t - pad.b) * (1 - v / nice);
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
    for (const t of [0, nice / 2, nice]) s += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`;
    data.forEach((d, i) => {
      const v = value(d), x = pad.l + i * bw;
      s += `<rect class="b" style="fill:${color}" x="${x + bw * 0.15}" y="${y(v)}" width="${Math.max(1, bw * 0.7)}" height="${Math.max(0, h - pad.b - y(v))}" rx="2"><title>${esc(label(d))}: ${esc(fmt(v))}</title></rect>`;
      if (i % every === 0) s += `<text x="${x + bw / 2}" y="${h - 6}" text-anchor="middle">${esc(label(d, true))}</text>`;
    });
    return s + '</svg>';
  }

  function line(points, { w = 640, h = 160 }) {
    if (points.length < 2) return '<p class="note">Dati non ancora sufficienti.</p>';
    const pad = { l: 34, r: 8, t: 10, b: 22 };
    const t0 = points[0].ts, t1 = points.at(-1).ts;
    const x = t => pad.l + (w - pad.l - pad.r) * (t - t0) / Math.max(1, t1 - t0);
    const y = v => pad.t + (h - pad.t - pad.b) * (1 - v / 100);
    let s = `<svg viewBox="0 0 ${w} ${h}" role="img">`;
    for (const t of [0, 50, 100]) s += `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${t}%</text>`;
    const step = (t1 - t0) / 4;
    for (let i = 0; i <= 4; i++) { const t = t0 + step * i; s += `<text x="${x(t)}" y="${h - 6}" text-anchor="middle">${new Date(t).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</text>`; }
    s += `<path class="ln" d="${points.filter(p => p.battery != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.battery).toFixed(1)}`).join('')}"/>`;
    return s + '</svg>';
  }

  async function loadStats() {
    const el = $('#stats');
    let st;
    try { st = await api(`api/stats?days=${statDays}`); } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    const T = st.totals, B = st.before;
    const every = Math.ceil(st.byDay.length / Math.max(4, Math.floor((el.clientWidth || 600) / 90)));
    const dayLbl = (d, short) => { const dt = new Date(d.day + 'T12:00'); return short ? dt.toLocaleDateString('it-IT', { day: 'numeric', month: 'numeric' }) : dt.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }); };
    const maxCount = Math.max(1, ...st.rooms.map(r => r.count));
    // il viewBox segue la larghezza reale così il testo resta della stessa misura
    const full = Math.max(300, el.clientWidth - 34);
    const half = el.clientWidth > 700 ? Math.max(300, (el.clientWidth - 14) / 2 - 34) : full;
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Pulizie</span><b>${T.sessions}</b>${delta(T.sessions, B.sessions)}</div>
        <div class="kpi"><span>Superficie pulita</span><b>${nf1.format(T.area)}<small>m²</small></b>${delta(T.area, B.area)}</div>
        <div class="kpi"><span>Tempo di lavoro</span><b>${fmtMin(T.minutes * 60)}</b>${delta(T.minutes, B.minutes)}</div>
        <div class="kpi"><span>Velocità media</span><b>${st.speed != null ? nf1.format(st.speed) : '–'}<small>m²/min</small></b><small>${T.battery != null ? `batteria media per pulizia −${T.battery}%` : ''}</small></div>
        <div class="kpi"><span>Ogni quanto</span><b>${st.avgGapH != null ? (st.avgGapH < 48 ? `${st.avgGapH}<small>h</small>` : `${nf1.format(st.avgGapH / 24)}<small>giorni</small>`) : '–'}</b><small>intervallo medio fra due pulizie</small></div>
      </div>
      <div class="card" style="margin-bottom:14px"><div class="card-head"><h2>Superficie pulita al giorno</h2><span class="note">m²</span></div>
        <div class="chart">${bars(st.byDay, { w: full, h: Math.round(Math.min(220, full * 0.32)), label: dayLbl, value: d => d.area, fmt: v => nf1.format(v), every })}</div></div>
      <div class="two">
        <div class="card"><div class="card-head"><h2>Stanze</h2><span class="note">nel periodo</span></div><div class="scroll"><table>
          <thead><tr><th>Stanza</th><th class="n">Pulizie</th><th class="n">a settimana</th><th>Ultima</th><th></th></tr></thead>
          <tbody>${st.rooms.map(r => `<tr><td>${esc(r.name)}</td><td class="n">${r.count}</td><td class="n">${nf1.format(r.perWeek)}</td><td class="${r.daysSince != null && r.daysSince > 7 ? 'late' : ''}">${r.last ? ago(r.last) : 'mai'}</td><td style="width:30%"><div class="hbar" style="width:${(r.count / maxCount) * 100}%"></div></td></tr>`).join('')}</tbody></table></div></div>
        <div class="card"><div class="card-head"><h2>A che ora pulisce</h2><span class="note">numero di pulizie per ora di partenza</span></div>
          <div class="chart">${bars(st.byHour.map((n, h) => ({ h, n })), { w: half, h: 160, label: (d, s) => s ? String(d.h) : `ore ${d.h}`, value: d => d.n, fmt: v => String(Math.round(v)), every: 3, color: 'var(--c7)' })}</div>
          <h3>Chi le ha avviate</h3>
          <table><tbody>${Object.entries(st.bySource).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('') || '<tr><td class="note">–</td></tr>'}</tbody></table>
        </div>
      </div>
      <div class="two">
        <div class="card"><div class="card-head"><h2>Batteria</h2><span class="note">ultime 48 ore</span></div><div class="chart">${line(st.battery, { w: half })}</div></div>
        <div class="card"><div class="card-head"><h2>Esito</h2></div><table><tbody>${Object.entries(st.results).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v}</td></tr>`).join('') || '<tr><td class="note">–</td></tr>'}</tbody></table></div>
      </div>`;
  }

  // ── Impostazioni ──
  App.hooks.impostazioni = loadSettings;
  async function loadSettings() {
    const el = $('#settings');
    let rooms, diag;
    try { [rooms, diag] = await Promise.all([api('api/rooms'), api('api/diagnosis')]); } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
    const L = App.ov?.labels;
    const R = diag.robot;
    el.innerHTML = `<div class="settings">
      <div class="card"><div class="card-head"><h2>Robot</h2><span class="pill ${R.online ? 'ok' : 'warn'}">${R.online ? 'collegato' : 'non collegato'}</span></div>
        <dl class="kv">
          <dt>Indirizzo</dt><dd>${diag.host ? `${esc(diag.host)}:${diag.port}` : 'non impostato'}</dd>
          <dt>Modello</dt><dd>${esc(R.model ?? '–')}</dd><dt>Firmware</dt><dd>${esc(R.firmware ?? '–')}</dd>
          <dt>Product key</dt><dd>${esc(R.productKey ?? '–')}</dd><dt>ID dispositivo</dt><dd>${esc(R.deviceId ?? '–')}</dd>
          <dt>Ultimo messaggio</dt><dd>${R.lastBroadcast ? ago(R.lastBroadcast) : '–'}</dd>
          ${R.lastError ? `<dt>Errore</dt><dd>${esc(R.lastError)}</dd>` : ''}
          ${R.maintain?.length || R.replace?.length ? `<dt>Manutenzione</dt><dd>${R.maintain.length ? `da pulire: codici ${R.maintain.join(', ')}` : ''} ${R.replace.length ? `da sostituire: codici ${R.replace.join(', ')}` : ''}</dd>` : ''}
          <dt>Home Assistant</dt><dd>${diag.ha.kind === 'demo' ? 'casa simulata' : diag.ha.connected ? 'collegato' : 'non collegato'} · ${diag.ha.bridge === 'mqtt' ? 'entità via MQTT' : diag.ha.bridge === 'rest' ? 'sensori via REST (senza comandi)' : 'nessuna entità'}</dd>
        </dl>
        <div class="go"><button class="btn small" data-act="aggiorna_mappa">Aggiorna la mappa</button><button class="btn small" data-reid>Riconosci di nuovo il robot</button></div>
      </div>

      <div class="card"><div class="card-head"><h2>Pulizia predefinita</h2></div>
        <p class="note">Usata dai pulsanti di Home Assistant, da "Pulisci" senza scelte e come punto di partenza per i nuovi programmi.</p>
        <div id="def-form">${L ? App.settingsControls(rooms.defaults, L, 'df') : ''}</div>
        <div class="go"><button class="btn small primary" data-save-def>Salva</button></div>
      </div>

      <div class="card" style="grid-column:1/-1"><div class="card-head"><h2>Stanze e aree di Home Assistant</h2></div>
        <p class="note">Collegando una stanza del robot a un'area, i programmi possono saltarla quando i sensori di presenza o movimento di quell'area sono attivi.</p>
        <div class="scroll"><table><thead><tr><th>Stanza del robot</th><th>Superficie</th><th>Area di Home Assistant</th><th>Sensori di presenza</th><th>Ultima pulizia</th></tr></thead><tbody>
        ${rooms.rooms.map(r => `<tr><td>${esc(r.name)}</td><td>${r.area ? nf1.format(r.area) + ' m²' : '–'}</td>
          <td><select data-room-area="${r.id}"><option value="">— nessuna —</option>${rooms.areas.map(a => `<option value="${esc(a.id)}" ${r.haArea === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></td>
          <td>${r.presenceSensors.length ? r.presenceSensors.map(s => `${s.on ? '●' : '○'} ${esc(s.name)}`).join('<br>') : '<span class="note">nessuno</span>'}</td>
          <td>${ago(r.lastCleaned)}</td></tr>`).join('') || '<tr><td colspan="5" class="note">Mappa non ancora ricevuta</td></tr>'}
        </tbody></table></div>
      </div>

      <div class="card"><div class="card-head"><h2>Dati</h2></div>
        <p class="note">${diag.counts.sessions} pulizie, ${diag.counts.events} voci di diario. Lo storico è nella cartella dati dell'app ed è incluso nei backup di Home Assistant.</p>
        <div class="go"><button class="btn small danger" data-reset>Cancella storico e diario</button></div>
      </div>

      <div class="card"><div class="card-head"><h2>Diagnosi</h2></div>
        <details><summary>Ultimi messaggi ricevuti dal robot</summary><pre class="raw">${esc(JSON.stringify(diag.raw, null, 1))}</pre></details>
        <details><summary>Registro</summary><div class="log">${diag.log.map(l => `<div><time>${fmtTime(l.ts)}</time>${esc(l.msg)}</div>`).join('')}</div></details>
      </div>
    </div>`;
  }

  $('#settings').addEventListener('change', async ev => {
    const s = ev.target.closest('[data-room-area]');
    if (!s) return;
    try { await post(`api/rooms/${s.dataset.roomArea}`, { haArea: s.value || null }); toast('Collegamento salvato'); } catch (e) { toast(e.message, true); }
    loadSettings();
  });
  $('#settings').addEventListener('click', async ev => {
    const b = ev.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.act) { const r = await post('api/action', { name: b.dataset.act }); toast(r.message, !r.ok); App.mapFetchedAt = null; }
      else if (b.hasAttribute('data-reid')) { await post('api/reconnect'); toast('Riconnessione in corso'); }
      else if (b.hasAttribute('data-save-def')) {
        const d = await post('api/defaults', App.readSettings($('#def-form'), 'df'));
        App.clean = { ...d }; toast('Salvato');
      } else if (b.hasAttribute('data-reset')) {
        if (prompt('Scrivi CANCELLA per eliminare storico e diario') !== 'CANCELLA') return;
        await post('api/data/reset', { confirm: 'CANCELLA' }); toast('Storico cancellato');
      } else return;
    } catch (e) { toast(e.message, true); }
    App.refresh(); loadSettings();
  });
  $('#settings').addEventListener('change', ev => {
    if (ev.target.dataset.df === 'mode' && App.ov) {
      const s = App.readSettings($('#def-form'), 'df');
      $('#def-form').innerHTML = App.settingsControls(s, App.ov.labels, 'df');
    }
  });
})();
