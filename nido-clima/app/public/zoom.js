// NIDO Clima — grafico ingrandito con zoom, valori al passaggio e tabella dei dati puntuali.
(() => {
  const SERIES = [
    { key: 'tRoom', label: 'Stanza', color: 'var(--room)', unit: '°C', width: 2, on: true },
    { key: 'tValve', label: 'Termosifone (usata)', color: 'var(--valve)', unit: '°C', width: 1.6, on: true },
    { key: 'tValveLocal', label: 'Valvola', color: '#b5838d', unit: '°C', width: 1.1, dash: '2 2', on: false },
    { key: 'setpoint', label: 'Obiettivo', color: 'var(--set)', unit: '°C', width: 1.2, dash: '4 3', step: true, on: true },
    { key: 'hRoom', label: 'Umidità', color: '#7a9a5a', unit: '%', width: 1.2, axis: 'right', on: false },
  ];
  const EV_ICON = { calorifero_on: '🔥', calorifero_off: '❄️', finestra: '🪟', comando: '👆', obiettivo: '🎯', modalita: '⚙️' };
  const z = { room: null, t0: 0, t1: 0, base: null, data: [], events: [], pick: null, drag: null, loading: 0 };
  const dlg = $('#zoom');
  const box = $('#zoom-chart');
  const M = { l: 40, r: 40, t: 22, b: 26 };

  const fmtTs = (ts, withDate) => new Date(ts).toLocaleString('it-IT', withDate
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
  const span = () => z.t1 - z.t0;
  const multiDay = () => span() > 20 * 3600e3;

  // ---------- apertura ----------
  document.addEventListener('click', e => {
    const w = e.target.closest('[data-zoom]');
    if (!w) return;
    z.room = w.dataset.zoom;
    z.pick = null;
    setRange(24);
    $('#zoom-title').textContent = roomNames[z.room] ?? z.room;
    dlg.showModal();
  });

  function setRange(hours) {
    z.t1 = Date.now();
    z.t0 = z.t1 - hours * 3600e3;
    z.base = [z.t0, z.t1];
    document.querySelectorAll('#zoom-ranges button').forEach(b => b.classList.toggle('on', Number(b.dataset.hours) === hours));
    load();
  }

  async function load() {
    const id = ++z.loading;
    const t0 = Math.round(z.t0), t1 = Math.round(z.t1);
    const [data, events] = await Promise.all([
      api(`api/rooms/${z.room}/history?from=${t0}&to=${t1}&max=1500`),
      api(`api/events?room=${z.room}&from=${t0}&to=${t1}&limit=300`).catch(() => []),
    ]);
    if (id !== z.loading) return; // risposta superata da una richiesta più recente
    z.data = data;
    z.events = events.filter(e => EV_ICON[e.kind]).reverse();
    render();
  }

  // ---------- scale ----------
  function scales(W, H) {
    const vis = SERIES.filter(s => s.on);
    const left = z.data.flatMap(d => vis.filter(s => s.axis !== 'right').map(s => d[s.key])).filter(v => v != null);
    const right = z.data.flatMap(d => vis.filter(s => s.axis === 'right').map(s => d[s.key])).filter(v => v != null);
    const range = (vals, pad, minSpan) => {
      if (!vals.length) return [0, 1];
      let lo = Math.min(...vals) - pad, hi = Math.max(...vals) + pad;
      if (hi - lo < minSpan) { const m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
      return [Math.floor(lo), Math.ceil(hi)];
    };
    const [lo, hi] = range(left, 0.3, 3);
    const [hlo, hhi] = range(right, 2, 10);
    const x = ts => M.l + ((ts - z.t0) / span()) * (W - M.l - M.r);
    const inv = px => z.t0 + ((px - M.l) / (W - M.l - M.r)) * span();
    const y = v => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
    const yr = v => M.t + (1 - (v - hlo) / (hhi - hlo)) * (H - M.t - M.b);
    return { x, inv, y, yr, lo, hi, hlo, hhi, hasRight: right.length > 0 };
  }

  function timeTicks(W) {
    const steps = [10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map(m => m * 60e3);
    const maxTicks = Math.max(3, Math.min(8, Math.floor((W - M.l - M.r) / 58)));
    const step = steps.find(s => span() / s <= maxTicks) ?? steps[steps.length - 1];
    const out = [];
    const off = new Date().getTimezoneOffset() * 60e3;
    for (let t = Math.ceil((z.t0 - off) / step) * step + off; t <= z.t1; t += step) out.push(t);
    return { out, step };
  }

  // ---------- disegno ----------
  function render() {
    const W = Math.max(320, box.clientWidth || 800);
    const H = W < 600 ? 240 : 340;
    const S = scales(W, H);
    const visible = SERIES.filter(s => s.on);

    // fasce di riscaldamento
    let bands = '', start = null;
    z.data.forEach((d, i) => {
      if (d.heating && start == null) start = d.ts;
      if (start != null && (!d.heating || i === z.data.length - 1)) {
        bands += `<rect x="${S.x(start)}" y="${M.t}" width="${Math.max(1, S.x(d.ts) - S.x(start))}" height="${H - M.t - M.b}" fill="var(--heat)"/>`;
        start = null;
      }
    });

    const grid = [];
    const stepV = (S.hi - S.lo) > 12 ? 5 : (S.hi - S.lo) > 5 ? 2 : 1;
    for (let v = Math.ceil(S.lo / stepV) * stepV; v <= S.hi; v += stepV)
      grid.push(`<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${S.y(v)}" y2="${S.y(v)}"/><text x="${M.l - 6}" y="${S.y(v) + 4}" text-anchor="end">${v}°</text>`);
    if (S.hasRight) {
      const stepH = (S.hhi - S.hlo) > 30 ? 10 : 5;
      for (let v = Math.ceil(S.hlo / stepH) * stepH; v <= S.hhi; v += stepH)
        grid.push(`<text x="${W - M.r + 6}" y="${S.yr(v) + 4}">${v}%</text>`);
    }
    const { out: ticks, step } = timeTicks(W);
    ticks.forEach(t => {
      const d = new Date(t);
      const label = step >= 1440 * 60e3 ? d.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' })
        : (d.getHours() === 0 && d.getMinutes() === 0 && multiDay()) ? d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
        : fmtTs(t);
      grid.push(`<line class="grid" x1="${S.x(t)}" x2="${S.x(t)}" y1="${M.t}" y2="${H - M.b}" stroke-opacity=".5"/><text x="${S.x(t)}" y="${H - 8}" text-anchor="middle">${label}</text>`);
    });

    const lines = visible.map(s => {
      const yf = s.axis === 'right' ? S.yr : S.y;
      let d = '', open = false, lastY = null;
      for (const p of z.data) {
        if (p[s.key] == null) { open = false; continue; }
        const X = S.x(p.ts).toFixed(1), Y = yf(p[s.key]).toFixed(1);
        if (!open) { d += `M${X},${Y}`; open = true; }
        else d += s.step ? `H${X}V${Y}` : `L${X},${Y}`;
        lastY = Y;
      }
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round"/>`;
    }).join('');

    const evs = z.events.map(e => `<g class="evm"><title>${fmtTs(e.ts, true)} — ${esc(e.message)}</title>
      <line x1="${S.x(e.ts)}" x2="${S.x(e.ts)}" y1="${M.t - 4}" y2="${H - M.b}" stroke="var(--muted)" stroke-opacity=".25"/>
      <text x="${S.x(e.ts)}" y="${M.t - 6}" text-anchor="middle" style="font-size:11px">${EV_ICON[e.kind]}</text></g>`).join('');

    const pick = z.pick != null ? `<line class="pick" x1="${S.x(z.pick)}" x2="${S.x(z.pick)}" y1="${M.t}" y2="${H - M.b}"/>` : '';
    const empty = z.data.length < 2 ? `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">Nessun dato in questo periodo</text>` : '';

    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
      ${bands}${grid.join('')}${evs}${lines}${pick}${empty}
      <line class="cross" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" visibility="hidden"/>
      <rect class="sel" x="0" y="${M.t}" width="0" height="${H - M.b - M.t}" visibility="hidden"/>
      <rect class="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="transparent"/>
    </svg><div class="tip" hidden></div>`;
    z.scale = { ...S, W, H };

    $('#zoom-sub').textContent = `${fmtTs(z.t0, true)} → ${fmtTs(z.t1, true)} · ${z.data.length} punti`;
    renderSeries();
    renderTable();
  }

  function renderSeries() {
    $('#zoom-series').innerHTML = SERIES.map((s, i) => `<label><input type="checkbox" data-series="${i}" ${s.on ? 'checked' : ''}>
      <span style="display:inline-block;width:14px;height:3px;background:${s.color}"></span>${s.label}</label>`).join('')
      + `<label><span style="display:inline-block;width:14px;height:10px;background:var(--heat)"></span>Termosifone caldo</label>`;
  }

  // ---------- tabella ----------
  function renderTable() {
    const rows = [];
    const evs = [...z.events];
    // dal più recente al più vecchio, con gli eventi intercalati
    for (let i = z.data.length - 1; i >= 0; i--) {
      const d = z.data[i];
      while (evs.length && evs[evs.length - 1].ts >= d.ts) {
        const e = evs.pop();
        rows.push(`<tr class="ev-row"><td>${fmtTs(e.ts, multiDay())}</td><td colspan="8">${EV_ICON[e.kind]} ${esc(e.message)}</td></tr>`);
      }
      const diff = d.tValve != null && d.tRoom != null ? d.tValve - d.tRoom : null;
      rows.push(`<tr data-ts="${d.ts}" class="${d.heating ? 'hot' : ''}">
        <td>${fmtTs(d.ts, multiDay())}</td><td>${n1(d.tRoom)}</td><td>${d.hRoom == null ? '–' : Math.round(d.hRoom)}</td>
        <td>${n1(d.tValveLocal)}</td><td><b>${n1(d.tValve)}</b></td><td>${diff == null ? '–' : (diff >= 0 ? '+' : '') + n1(diff)}</td>
        <td>${n1(d.setpoint)}</td><td>${esc(d.mode ?? '–')}</td><td>${d.heating ? '🔥 sì' : 'no'}</td></tr>`);
    }
    $('#zoom-table').innerHTML = `<table><thead><tr><th>Ora</th><th>Stanza °C</th><th>Umidità %</th><th>Valvola °C</th><th>Termosifone (usata) °C</th>
      <th>Differenza</th><th>Obiettivo °C</th><th>Modalità</th><th>Caldo</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="9">Nessun dato</td></tr>'}</tbody></table>`;
    if (z.pick != null) highlight(z.pick, false);
  }

  function nearest(ts) {
    let best = null, bd = Infinity;
    for (const d of z.data) { const dd = Math.abs(d.ts - ts); if (dd < bd) { bd = dd; best = d; } }
    return best;
  }

  function highlight(ts, scroll = true) {
    document.querySelectorAll('#zoom-table tr.picked').forEach(r => r.classList.remove('picked'));
    const row = document.querySelector(`#zoom-table tr[data-ts="${ts}"]`);
    if (!row) return;
    row.classList.add('picked');
    if (scroll) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------- interazione ----------
  const localX = e => e.clientX - box.getBoundingClientRect().left;
  const clampT = t => Math.min(z.t1, Math.max(z.t0, t));

  function showTip(e) {
    const S = z.scale; if (!S || !z.data.length) return;
    const px = localX(e);
    const d = nearest(S.inv(px));
    if (!d) return;
    const cross = box.querySelector('.cross');
    cross.setAttribute('x1', S.x(d.ts)); cross.setAttribute('x2', S.x(d.ts)); cross.setAttribute('visibility', 'visible');
    const tip = box.querySelector('.tip');
    tip.innerHTML = `<b>${fmtTs(d.ts, true)}</b>` + SERIES.filter(s => s.on).map(s =>
      `<div><i style="background:${s.color}"></i>${s.label}: ${s.unit === '%' ? (d[s.key] == null ? '–' : Math.round(d[s.key])) : n1(d[s.key])} ${s.unit}</div>`).join('')
      + `<div>${d.heating ? '🔥 termosifone caldo' : 'termosifone freddo'}</div>`;
    tip.hidden = false;
    const r = box.getBoundingClientRect();
    const left = px + 14 + tip.offsetWidth > r.width ? px - tip.offsetWidth - 14 : px + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${M.t + 4}px`;
  }

  box.addEventListener('pointerdown', e => {
    if (!z.scale || e.button > 0) return;
    z.drag = { x: localX(e), id: e.pointerId };
    box.setPointerCapture(e.pointerId);
  });

  box.addEventListener('pointermove', e => {
    const S = z.scale; if (!S) return;
    if (z.drag) {
      const x0 = Math.max(M.l, Math.min(z.drag.x, localX(e)));
      const x1 = Math.min(S.W - M.r, Math.max(z.drag.x, localX(e)));
      const sel = box.querySelector('.sel');
      sel.setAttribute('x', x0); sel.setAttribute('width', Math.max(0, x1 - x0));
      sel.setAttribute('visibility', x1 - x0 > 6 ? 'visible' : 'hidden');
    }
    if (e.pointerType === 'mouse' || z.drag) showTip(e);
  });

  box.addEventListener('pointerup', e => {
    const S = z.scale; if (!S || !z.drag) return;
    const dx = Math.abs(localX(e) - z.drag.x);
    const a = clampT(S.inv(Math.min(z.drag.x, localX(e)))), b = clampT(S.inv(Math.max(z.drag.x, localX(e))));
    z.drag = null;
    if (dx > 8 && b - a > 5 * 60e3) {           // trascinamento: zoom sul periodo selezionato
      z.t0 = a; z.t1 = b; clearRangeButtons(); load();
    } else {                                     // clic: punto in tabella
      const d = nearest(S.inv(localX(e)));
      if (d) { z.pick = d.ts; render(); highlight(d.ts); showTip(e); }
    }
  });

  box.addEventListener('pointerleave', () => {
    if (z.drag) return;
    box.querySelector('.cross')?.setAttribute('visibility', 'hidden');
    const tip = box.querySelector('.tip'); if (tip) tip.hidden = true;
  });

  box.addEventListener('dblclick', () => { z.t0 = z.base[0]; z.t1 = z.base[1]; z.pick = null; load(); });

  let wheelTimer = null;
  box.addEventListener('wheel', e => {
    const S = z.scale; if (!S) return;
    e.preventDefault();
    const center = S.inv(localX(e));
    const f = e.deltaY > 0 ? 1.3 : 1 / 1.3;
    const len = Math.max(10 * 60e3, Math.min(400 * 86400e3, span() * f));
    const ratio = (center - z.t0) / span();
    z.t0 = center - ratio * len; z.t1 = z.t0 + len;
    if (z.t1 > Date.now()) { z.t1 = Date.now(); z.t0 = z.t1 - len; }
    clearRangeButtons();
    clearTimeout(wheelTimer); wheelTimer = setTimeout(load, 180);
  }, { passive: false });

  function clearRangeButtons() { document.querySelectorAll('#zoom-ranges button').forEach(b => b.classList.remove('on')); }

  dlg.addEventListener('click', e => {
    const r = e.target.closest('[data-hours]');
    if (r) { z.pick = null; return setRange(Number(r.dataset.hours)); }
    if (e.target.closest('[data-reset]')) { z.t0 = z.base[0]; z.t1 = z.base[1]; z.pick = null; return load(); }
    if (e.target.closest('[data-zoomout]')) {
      const len = Math.min(400 * 86400e3, span() * 2), mid = (z.t0 + z.t1) / 2;
      z.t0 = mid - len / 2; z.t1 = Math.min(Date.now(), mid + len / 2);
      clearRangeButtons(); return load();
    }
    const pan = e.target.closest('[data-pan]');
    if (pan) {
      const shift = span() / 2 * Number(pan.dataset.pan);
      const len = span();
      z.t1 = Math.min(Date.now(), z.t1 + shift); z.t0 = z.t1 - len;
      clearRangeButtons(); return load();
    }
    if (e.target.closest('[data-csv]')) return exportCsv();
    const row = e.target.closest('#zoom-table tr[data-ts]');
    if (row) { z.pick = Number(row.dataset.ts); render(); highlight(z.pick, false); }
  });

  dlg.addEventListener('change', e => {
    const i = e.target.dataset.series;
    if (i == null) return;
    SERIES[i].on = e.target.checked;
    render();
  });

  function exportCsv() {
    const num = v => v == null ? '' : String(Math.round(v * 100) / 100).replace('.', ',');
    const lines = ['data;ora;stanza_c;umidita;valvola_c;termosifone_usata_c;differenza;obiettivo_c;modalita;caldo'];
    for (const d of z.data) {
      const dt = new Date(d.ts);
      lines.push([dt.toLocaleDateString('it-IT'), dt.toLocaleTimeString('it-IT'), num(d.tRoom), num(d.hRoom), num(d.tValveLocal), num(d.tValve),
        num(d.tValve != null && d.tRoom != null ? d.tValve - d.tRoom : null), num(d.setpoint), d.mode ?? '', d.heating ? 1 : 0].join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nido-clima_${z.room}_${new Date(z.t0).toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.addEventListener('resize', () => { if (dlg.open) render(); });
})();
