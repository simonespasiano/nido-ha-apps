// NIDO Clima — dashboard "Casa": media della casa, confronto con i modelli meteo, modello termico, umidità.
(() => {
  // colori dei modelli in ordine fisso (palette categoriale validata); non cambiano se un modello manca
  const MODEL_COLORS = {
    icon_seamless: 'var(--c1)', ecmwf_ifs025: 'var(--c2)', gfs_seamless: 'var(--c3)',
    meteofrance_seamless: 'var(--c4)', ukmo_seamless: 'var(--c5)', italia_meteo_arpae_icon_2i: 'var(--c6)',
  };
  let hours = 48, data = null, hidden = new Set();
  const fmtH = ts => new Date(ts).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const sign = v => v == null ? '–' : (v > 0 ? '+' : '') + n1(v);

  window.loadCasa = async () => {
    data = await api(`api/house?hours=${hours}`);
    render();
  };

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-casa-hours]');
    if (b) { hours = Number(b.dataset.casaHours); window.loadCasa(); return; }
    const s = e.target.closest('[data-toggle-model]');
    if (s) { const id = s.dataset.toggleModel; hidden.has(id) ? hidden.delete(id) : hidden.add(id); render(); }
    if (e.target.closest('#wx-refresh')) {
      e.target.closest('#wx-refresh').disabled = true;
      fetch('api/weather/refresh', { method: 'POST' }).then(() => window.loadCasa()).catch(() => toast('Aggiornamento meteo non riuscito', true));
    }
  });

  /* ---------- grafico temporale generico (SVG, un solo asse y) ---------- */
  function tsChart(el, { lines = [], bands = [], unit = '°', height = 240, t0, t1, nowTs, yPad = 0.5 }) {
    const W = Math.max(320, el.clientWidth || 800), H = height, L = 38, R = 10, T = 12, B = 24;
    const vals = [];
    lines.forEach(l => l.pts.forEach(p => p[1] != null && vals.push(p[1])));
    bands.forEach(b => b.pts.forEach(p => { if (p[1] != null) vals.push(p[1]); if (p[2] != null) vals.push(p[2]); }));
    if (!vals.length) { el.innerHTML = '<div class="empty">Dati in raccolta…</div>'; return; }
    let lo = Math.floor(Math.min(...vals) - yPad), hi = Math.ceil(Math.max(...vals) + yPad);
    if (hi - lo < 4) { const m = (hi + lo) / 2; lo = Math.floor(m - 2); hi = Math.ceil(m + 2); }
    const x = ts => L + ((ts - t0) / (t1 - t0)) * (W - L - R);
    const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const path = (pts, k = 1, step) => {
      let d = '', open = false;
      for (const p of pts) {
        if (p[k] == null || p[0] < t0 || p[0] > t1) { open = false; continue; }
        d += open ? (step ? `H${x(p[0]).toFixed(1)}V${y(p[k]).toFixed(1)}` : `L${x(p[0]).toFixed(1)},${y(p[k]).toFixed(1)}`) : `M${x(p[0]).toFixed(1)},${y(p[k]).toFixed(1)}`;
        open = true;
      }
      return d;
    };
    const area = pts => {
      const v = pts.filter(p => p[1] != null && p[2] != null && p[0] >= t0 && p[0] <= t1);
      if (v.length < 2) return '';
      return 'M' + v.map(p => `${x(p[0]).toFixed(1)},${y(p[2]).toFixed(1)}`).join('L') + 'L' + v.reverse().map(p => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('L') + 'Z';
    };
    const stepY = (hi - lo) > 16 ? 5 : (hi - lo) > 8 ? 2 : 1;
    let grid = '';
    for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY)
      grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}${unit}</text>`;
    const span = t1 - t0, steps = [3, 6, 12, 24, 48].map(h => h * 3600e3);
    const st = steps.find(s => span / s <= Math.max(3, Math.floor((W - L - R) / 70))) ?? steps[steps.length - 1];
    const off = new Date().getTimezoneOffset() * 60e3;
    for (let t = Math.ceil((t0 - off) / st) * st + off; t <= t1; t += st) {
      const d = new Date(t);
      const lab = d.getHours() === 0 ? d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' }) : `${String(d.getHours()).padStart(2, '0')}:00`;
      grid += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke-opacity=".45"/><text x="${x(t)}" y="${H - 7}" text-anchor="middle">${lab}</text>`;
    }
    const now = nowTs >= t0 && nowTs <= t1 ? `<line class="now" x1="${x(nowTs)}" x2="${x(nowTs)}" y1="${T}" y2="${H - B}"/><text class="now-lbl" x="${x(nowTs) + 4}" y="${T + 10}">adesso</text>` : '';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
      ${grid}${bands.map(b => `<path d="${area(b.pts)}" fill="${b.color}" opacity="${b.opacity ?? 0.14}"/>`).join('')}
      ${now}
      ${lines.map(l => `<path d="${path(l.pts, 1, l.step)}" fill="none" stroke="${l.color}" stroke-width="${l.width ?? 2}" ${l.dash ? `stroke-dasharray="${l.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
      <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="hit"/>
    </svg><div class="tip" hidden></div>`;
    const svg = el.querySelector('svg'), tip = el.querySelector('.tip'), cross = el.querySelector('.cross');
    const show = ev => {
      const r = svg.getBoundingClientRect(); const px = (ev.clientX - r.left) * (W / r.width);
      const ts = t0 + ((px - L) / (W - L - R)) * span;
      if (ts < t0 || ts > t1) return hide();
      const rows = [];
      for (const l of lines.filter(l => l.tip !== false)) {
        let best = null;
        for (const p of l.pts) if (p[1] != null && (!best || Math.abs(p[0] - ts) < Math.abs(best[0] - ts))) best = p;
        if (best && Math.abs(best[0] - ts) < (l.tol ?? 2 * 3600e3)) rows.push(`<div><i style="background:${l.color}"></i>${esc(l.label)}: <b>${n1(best[1])}${unit}</b></div>`);
      }
      if (!rows.length) return hide();
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>${fmtH(ts)}</b>${rows.join('')}`; tip.hidden = false;
      const left = (px / W) * r.width; tip.style.left = `${left + 14 + tip.offsetWidth > r.width ? left - tip.offsetWidth - 14 : left + 14}px`; tip.style.top = '8px';
    };
    const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show); svg.addEventListener('pointerleave', hide);
  }

  const legend = items => `<div class="lg">${items.map(i => `<span class="${i.off ? 'off' : ''}" ${i.toggle ? `data-toggle-model="${i.toggle}" role="button" tabindex="0"` : ''}>
    <i style="${i.area ? `background:${i.color};opacity:.35;height:10px` : `background:${i.color}`}${i.dash ? ';background:none;border-top:2px dashed ' + i.color + ';height:0' : ''}"></i>${esc(i.label)}</span>`).join('')}</div>`;

  /* ---------- pagina ---------- */
  function render() {
    const d = data, n = d.now, o = d.outdoor, f = d.forecast, ind = d.indoor;
    const t0 = d.updated - hours * 3600e3, now = d.updated;
    const tEnd = now + 24 * 3600e3, tEndWx = now + 48 * 3600e3;
    const trend = n.slope3h == null ? '–' : Math.abs(n.slope3h) < 0.1 ? '→ stabile' : n.slope3h > 0 ? `↗ ${sign(n.slope3h)} °C/h` : `↘ ${sign(n.slope3h)} °C/h`;
    const deltaYest = n.tAvg != null && n.sameTimeYesterday != null ? n.tAvg - n.sameTimeYesterday : null;
    const kpi = (label, value, sub, title = '') => `<div class="kpi" title="${esc(title)}"><span>${label}</span><b>${value}</b><small>${sub ?? ''}</small></div>`;
    const loc = d.location?.name ? esc(d.location.name) : 'posizione da Home Assistant';
    const wxAge = f.updated ? Math.round((Date.now() - f.updated) / 60000) : null;

    $('#casa').innerHTML = `
      <div class="kpis">
        ${kpi('Media casa', `${n1(n.tAvg)}<small>°C</small>`, `${trend} · ieri a quest'ora ${n1(n.sameTimeYesterday)}° (${sign(deltaYest)})`, 'Media dei sensori di tutte le stanze')}
        ${kpi('Umidità media', `${n.hAvg == null ? '–' : Math.round(n.hAvg)}<small>%</small>`, `rugiada ${n1(n.dew)} °C · ${n1(n.ah)} g/m³`, 'Punto di rugiada: temperatura sotto cui le superfici si bagnano di condensa')}
        ${kpi('Esterno', `${n1(o.now.temp)}<small>°C</small>`, `${o.now.hum ?? '–'} % · ${o.source === 'sensore' ? 'sensore esterno' : 'modello Open-Meteo'}`)}
        ${kpi('Dentro − fuori', `${n.tAvg != null && o.now.temp != null ? sign(n.tAvg - o.now.temp) : '–'}<small>°C</small>`, `oggi media ${n1(n.todayAvg)}° · ieri ${n1(n.yesterdayAvg)}°`)}
        ${kpi('Escursione stanze', `${n1(n.spread)}<small>°C</small>`, n.rooms.length ? `${esc(n.rooms[0].name)} → ${esc(n.rooms[n.rooms.length - 1].name)}` : '')}
      </div>
      ${d.advice.length ? `<div class="advice">${d.advice.map(a => `<p class="${a.level}">${a.level === 'warn' ? '⚠' : 'ℹ'} ${esc(a.text)}</p>`).join('')}</div>` : ''}
      <div class="seg casa-range">${[24, 48, 168, 720].map(h => `<button data-casa-hours="${h}" class="${h === hours ? 'on' : ''}">${h < 168 ? h + ' h' : h / 24 + ' gg'}</button>`).join('')}</div>

      <section class="card wide-card">
        <div class="card-head"><h2>Temperatura della casa</h2><span class="note">storico e previsione 24 h</span></div>
        <div id="ch-house" class="ts-chart"></div>
        ${legend([{ label: 'Media casa', color: 'var(--ink)' }, { label: 'Stanze (min–max)', color: 'var(--room)', area: true },
          { label: 'Previsione casa (90 %)', color: 'var(--ink)', dash: true }, { label: 'Esterno', color: 'var(--set)' }])}
      </section>

      <div class="two">
        <section class="card">
          <div class="card-head"><h2>Modello della casa</h2>${ind.model.ok ? `<span class="badge">${ind.model.n} ore di dati</span>` : ''}</div>
          ${ind.model.ok ? `
            <div class="mstats">
              <div><span>Costante di tempo</span><b>${n1(ind.model.tau)} h</b><small>quanto lentamente la casa segue l'esterno</small></div>
              <div><span>Dispersione</span><b>${n1(ind.model.lossPer10)} °C/h</b><small>persi ogni ora con 10 °C di differenza</small></div>
              <div><span>Effetto termosifoni</span><b>${ind.model.usesHeat ? sign(ind.model.heatGain) + ' °C/h' : '–'}</b><small>${ind.model.usesHeat ? 'con tutti i termosifoni caldi' : 'nessuna accensione nei dati'}</small></div>
              <div><span>Precisione</span><b>±${n1(ind.model.sigma)} °C</b><small>errore tipico a 1 ora · R² ${ind.model.r2 ?? '–'}</small></div>
            </div>
            ${ind.prediction.length ? `<p class="note">Fra 6 ore: <b>${n1(ind.prediction[5]?.t)} °C</b> · fra 12: <b>${n1(ind.prediction[11]?.t)} °C</b> · fra 24: <b>${n1(ind.prediction[23]?.t)} °C</b>, con la previsione esterna di consenso e le accensioni tipiche di ogni ora.</p>` : ''}
            ${ind.backtest?.n ? `<table class="mini"><thead><tr><th>Previsione a 6 h (ultime 24 h)</th><th>Errore medio</th></tr></thead><tbody>
              <tr><td>Modello della casa</td><td>${n1(ind.backtest.model)} °C</td></tr>
              <tr><td>"Resta com'è"</td><td>${n1(ind.backtest.persistenza)} °C</td></tr>
              <tr><td>"Come ieri alla stessa ora"</td><td>${n1(ind.backtest.ieri)} °C</td></tr></tbody></table>
              <p class="note">Il modello è utile quando sbaglia meno dei due metodi semplici.</p>` : ''}`
          : `<div class="empty">${esc(ind.model.reason)}. Il modello impara da solo come la casa si scalda e si raffredda in base all'esterno e ai termosifoni.</div>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>Stanze rispetto alla media</h2></div>
          <table class="mini"><thead><tr><th>Stanza</th><th>°C</th><th>vs media</th><th>Umidità</th><th>Rugiada</th></tr></thead><tbody>
            ${n.rooms.map(r => `<tr><td>${r.heating ? '🔥 ' : ''}<b>${esc(r.name)}</b></td><td>${n1(r.t)}</td><td>${sign(r.diff)}</td><td>${r.h ?? '–'} %</td><td>${n1(r.dew)}°</td></tr>`).join('')}
          </tbody></table>
        </section>
      </div>

      <section class="card wide-card">
        <div class="card-head"><h2>Esterno: confronto fra modelli</h2>
          <span class="note">${loc} · aggiornato ${wxAge == null ? '–' : wxAge < 2 ? 'ora' : `${wxAge} min fa`} <button class="btn small" id="wx-refresh">Aggiorna</button></span></div>
        ${f.errors.length ? `<p class="note warn">⚠ ${esc(f.errors.join(' · '))}</p>` : ''}
        <div id="ch-wx" class="ts-chart"></div>
        ${legend([{ label: 'Consenso', color: 'var(--ink)' }, { label: 'Dispersione modelli', color: 'var(--ink)', area: true },
          { label: o.source === 'sensore' ? 'Sensore esterno' : 'Osservato (analisi)', color: 'var(--set)' },
          ...f.models.map(m => ({ label: m.name, color: MODEL_COLORS[m.id] ?? 'var(--c7)', toggle: m.id, off: hidden.has(m.id) }))])}
        <p class="note hint">Tocca un modello nella legenda per nasconderlo o mostrarlo.</p>
        <div class="scroll"><table class="mini models"><thead><tr><th>Modello</th><th>Adesso</th><th>Min 24 h</th><th>Max 24 h</th><th>Scarto dal consenso</th><th>Errore medio 7 gg</th><th>Tendenza</th></tr></thead><tbody>
          ${f.table.map(m => {
            const a = f.accuracy.find(x => x.model === m.id);
            const rank = a ? f.accuracy.indexOf(a) + 1 : null;
            return `<tr><td><i class="sw-dot" style="background:${MODEL_COLORS[m.id] ?? 'var(--c7)'}"></i><b>${esc(m.name)}</b>${m.error ? ' <span class="warn" title="' + esc(m.error) + '">⚠</span>' : ''}</td>
              <td>${n1(m.now)}°</td><td>${n1(m.min24)}°</td><td>${n1(m.max24)}°</td><td>${n1(m.devFromConsensus)}°</td>
              <td>${a ? `${rank === 1 ? '🏆 ' : ''}${n1(a.mae)}° <small>(${a.n})</small>` : '<small>in raccolta</small>'}</td>
              <td>${a ? (Math.abs(a.bias) < 0.3 ? 'centrato' : a.bias > 0 ? `troppo caldo ${sign(a.bias)}°` : `troppo freddo ${sign(a.bias)}°`) : '–'}</td></tr>`;
          }).join('')}
        </tbody></table></div>
        <p class="note">L'errore medio confronta le previsioni fatte da 1 a 24 ore prima con ${o.source === 'sensore' ? 'il tuo sensore esterno' : 'l\'analisi oraria di Open-Meteo (con un sensore esterno il confronto diventa reale: opzione <code>sensore_esterno</code>)'}. Dati: <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>.</p>
      </section>

      <section class="card wide-card">
        <div class="card-head"><h2>Umidità</h2><span class="note">relativa, dentro e fuori</span></div>
        <div id="ch-hum" class="ts-chart"></div>
        ${legend([{ label: 'Media casa', color: 'var(--room)' }, { label: 'Esterno', color: 'var(--set)' }, { label: 'Previsione esterna', color: 'var(--set)', dash: true }])}
        <p class="note">Fuori l'umidità relativa è quasi sempre più alta, ma l'aria fredda contiene poca acqua: conta l'umidità assoluta, nei consigli in alto.</p>
      </section>`;

    // grafico casa
    const hist = d.history;
    const outPts = o.obs.map(p => [p.ts, p.temp]);
    const cons = f.consensus.filter(c => c.ts > now - 3600e3);
    tsChart($('#ch-house'), {
      t0, t1: tEnd, nowTs: now,
      bands: [{ pts: hist.map(p => [p.ts, p.tmin, p.tmax]), color: 'var(--room)', opacity: 0.18 },
              { pts: ind.prediction.map(p => [p.ts, p.lo, p.hi]), color: 'var(--ink)', opacity: 0.08 }],
      lines: [
        { label: 'Esterno', color: 'var(--set)', width: 1.5, pts: [...outPts, ...cons.map(c => [c.ts, c.mean])] },
        { label: 'Media casa', color: 'var(--ink)', width: 2.2, pts: hist.map(p => [p.ts, p.t]), tol: 30 * 60e3 },
        { label: 'Previsione casa', color: 'var(--ink)', width: 2, dash: '5 4', pts: hist.length && ind.prediction.length ? [[now, n.tAvg], ...ind.prediction.map(p => [p.ts, p.t])] : [] },
      ],
    });
    // grafico modelli
    const obsStart = Math.max(t0, now - 48 * 3600e3);
    tsChart($('#ch-wx'), {
      t0: obsStart, t1: tEndWx, nowTs: now, yPad: 1,
      bands: [{ pts: f.consensus.map(c => [c.ts, c.min, c.max]), color: 'var(--ink)', opacity: 0.08 }],
      lines: [
        ...f.models.filter(m => !hidden.has(m.id)).map(m => ({ label: m.name, color: MODEL_COLORS[m.id] ?? 'var(--c7)', width: 1.4, pts: m.points.filter(p => p.ts >= now - 3600e3).map(p => [p.ts, p.temp]) })),
        { label: o.source === 'sensore' ? 'Sensore esterno' : 'Osservato', color: 'var(--set)', width: 2, pts: outPts },
        { label: 'Consenso', color: 'var(--ink)', width: 2.4, pts: f.consensus.filter(c => c.ts >= now - 3600e3).map(c => [c.ts, c.mean]) },
      ],
    });
    // grafico umidità
    tsChart($('#ch-hum'), {
      t0, t1: tEnd, nowTs: now, unit: '%', yPad: 3,
      lines: [
        { label: 'Esterno', color: 'var(--set)', width: 1.5, pts: o.obs.map(p => [p.ts, p.hum]) },
        { label: 'Previsione esterna', color: 'var(--set)', width: 1.5, dash: '5 4', pts: cons.map(c => [c.ts, c.hum]) },
        { label: 'Media casa', color: 'var(--room)', width: 2.2, pts: hist.map(p => [p.ts, p.h]), tol: 30 * 60e3 },
      ],
    });
  }

  window.addEventListener('resize', () => { if (data && !$('#tab-casa').hidden) render(); });
})();
