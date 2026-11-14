// NIDO Clima — Umidità: stato, profili orari, picchi che si ripetono, rischio condensa e consigli.
(() => {
  let days = 14, data = null;
  window.loadUmidita = async () => { data = await api(`api/humidity?days=${days}`); render(); };
  const pct = v => v == null ? '–' : `${Math.round(v)} %`;
  const g = v => v == null ? '–' : `${n1(v)} g/m³`;

  function profile(p, w) {
    const H = 150, L = 30, R = 8, T = 8, B = 20;
    const vals = [...p.feriali, ...p.festivi].filter(v => v != null);
    if (vals.length < 4) return '<p class="note">Profilo in costruzione: servono almeno un paio di giorni di dati.</p>';
    let lo = Math.floor(Math.min(...vals) / 5) * 5, hi = Math.ceil(Math.max(...vals) / 5) * 5;
    if (hi - lo < 10) hi = lo + 10;
    const x = h => L + (w - L - R) * (h / 23), y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const path = arr => { let d = '', pen = false; arr.forEach((v, h) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(h).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
    let s = `<svg viewBox="0 0 ${w} ${H}" class="hchart" role="img" aria-label="Umidità media per ora">`;
    for (let v = lo; v <= hi; v += 5) s += `<line class="grid" x1="${L}" x2="${w - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    if (60 > lo && 60 < hi) s += `<line x1="${L}" x2="${w - R}" y1="${y(60)}" y2="${y(60)}" stroke="var(--warn)" stroke-dasharray="3 3"/>`;
    for (const h of [0, 6, 12, 18, 23]) s += `<text x="${x(h)}" y="${H - 5}" text-anchor="middle">${h}</text>`;
    s += `<path d="${path(p.feriali)}" fill="none" stroke="var(--c1)" stroke-width="2"/><path d="${path(p.festivi)}" fill="none" stroke="var(--c2)" stroke-width="2" stroke-dasharray="5 3"/>`;
    const now = new Date().getHours();
    return s + `<line x1="${x(now)}" x2="${x(now)}" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-width="1" opacity=".5"/></svg>`;
  }

  function spark(pts, w) {
    const H = 44;
    const v = pts.filter(p => p.h != null);
    if (v.length < 2) return '';
    const t0 = v[0].ts, t1 = v.at(-1).ts;
    const lo = Math.min(...v.map(p => p.h)) - 2, hi = Math.max(...v.map(p => p.h)) + 2;
    const x = t => (w * (t - t0)) / Math.max(1, t1 - t0), y = h => H - 2 - ((H - 4) * (h - lo)) / Math.max(1, hi - lo);
    return `<svg viewBox="0 0 ${w} ${H}" class="spark" preserveAspectRatio="none"><path d="${v.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.h).toFixed(1)}`).join('')}" fill="none" stroke="var(--room)" stroke-width="1.6"/></svg>`;
  }

  function bands(p) {
    const a70 = p.above70 ?? 0, a60 = Math.max(0, (p.above60 ?? 0) - a70), b40 = p.below40 ?? 0, ok = Math.max(0, 100 - a70 - a60 - b40);
    return `<div class="hbands" title="Tempo per fascia di umidità">
      <i style="width:${b40}%;background:var(--c4)"></i><i style="width:${ok}%;background:var(--c3)"></i><i style="width:${a60}%;background:var(--c2)"></i><i style="width:${a70}%;background:var(--c5)"></i></div>
      <div class="hb-leg"><span><i style="background:var(--c4)"></i>secca &lt;40 %: ${pct(b40)}</span><span><i style="background:var(--c3)"></i>40–60 %: ${pct(ok)}</span><span><i style="background:var(--c2)"></i>60–70 %: ${pct(a60)}</span><span><i style="background:var(--c5)"></i>&gt;70 %: ${pct(a70)}</span></div>`;
  }

  function render() {
    const el = document.getElementById('umidita'), d = data;
    const w = Math.max(280, Math.min(520, (el.clientWidth || 900) / (el.clientWidth > 900 ? 2 : 1) - 40));
    const icon = { alto: '🔴', medio: '🟠', info: '🔵' };
    el.innerHTML = `
      <div class="toolbar"><div class="seg" id="hu-days">${[7, 14, 30].map(n => `<button class="${n === days ? 'on' : ''}" data-hdays="${n}">${n} giorni</button>`).join('')}</div></div>
      <div class="hu-top">
        <div class="card"><div class="card-head"><h2>Casa e fuori</h2></div>
          <div class="fig-grid">
            <div class="fig">Vapore in casa<b>${g(d.house.ah)}</b></div>
            <div class="fig">Vapore fuori<b>${g(d.outdoor.ah)}</b></div>
            <div class="fig">Differenza<b>${d.house.load == null ? '–' : `+${n1(d.house.load)}`}</b></div>
            <div class="fig">Fuori<b>${n1(d.outdoor.temp)}° · ${pct(d.outdoor.hum)}</b></div>
          </div>
          <p class="note">L'umidità relativa dipende dalla temperatura; il <b>vapore</b> (umidità assoluta) no. Arieggiare abbassa l'umidità solo se fuori c'è meno vapore che dentro: in inverno quasi sempre. In casa 2–3 g/m³ più di fuori è normale, oltre 4 serve arieggiare di più.</p>
        </div>
        <div class="card"><div class="card-head"><h2>Consigli</h2></div>
          ${d.advice.length ? `<ul class="advice">${d.advice.map(a => `<li>${icon[a.level]} ${esc(a.text)}</li>`).join('')}</ul>` : '<p class="note">Nessun problema: umidità nella norma in tutte le stanze.</p>'}
        </div>
      </div>
      <div class="hu-rooms">${d.rooms.map(r => !r.available ? `<div class="card"><h2>${esc(r.name)}</h2><p class="note">Nessun sensore di umidità o nessun dato.</p></div>` : `
        <article class="card">
          <div class="card-head"><h2>${esc(r.name)}</h2>${r.now.surfaceRH != null && r.now.surfaceRH >= 80 ? '<span class="badge warm">Rischio condensa</span>' : r.now.rh >= 65 ? '<span class="badge win">Umida</span>' : r.now.rh < 40 ? '<span class="badge">Secca</span>' : '<span class="badge">Nella norma</span>'}</div>
          <div class="figures">
            <div class="big"><span>${Math.round(r.now.rh)}<small>%</small></span><span class="big-lbl">ora · ${n1(r.now.t)} °C</span></div>
            <div class="fig-grid">
              <div class="fig" title="Vapore contenuto in un metro cubo d'aria">Vapore<b>${g(r.now.ah)}</b></div>
              <div class="fig" title="Sotto questa temperatura una superficie si bagna">Punto di rugiada<b>${n1(r.now.dew)}°</b></div>
              <div class="fig" title="Umidità stimata sulle pareti esterne più fredde (angoli, dietro i mobili)">Sulle pareti<b>${pct(r.now.surfaceRH)}</b></div>
              <div class="fig" title="Oltre questa umidità, con il freddo di adesso, le pareti superano l'80 %">Limite oggi<b>${pct(r.now.criticalRH)}</b></div>
            </div>
          </div>
          ${spark(r.last24, w)}
          <h3>Ultimi ${r.period.days} giorni · media ${pct(r.period.mean)} (${r.period.min}–${r.period.max} %)</h3>
          ${bands(r.period)}
          <p class="note">${r.period.mouldHours ? `⚠ ${r.period.mouldHours} ore con le pareti oltre l'80 %. ` : ''}${r.spikesPerDay ? `${n1(r.spikesPerDay)} picchi al giorno${r.recoverMedian != null ? `, rientro tipico in ${r.recoverMedian} minuti` : ''}.` : 'Nessun picco improvviso.'}</p>
          <h3>Giornata tipo <span class="legend-inline"><i style="background:var(--c1)"></i>feriali <i class="dash" style="border-color:var(--c2)"></i>sabato e domenica</span></h3>
          ${profile(r.profile, w)}
          ${r.patterns.length ? `<h3>Cosa si ripete</h3><ul class="advice">${r.patterns.map(p => `<li>🔁 ${esc(p.text)}</li>`).join('')}</ul>` : ''}
          ${r.spikes.length ? `<details><summary>Picchi recenti (${r.spikes.length})</summary><table class="mini"><thead><tr><th>Quando</th><th>Da → a</th><th>Rientro</th></tr></thead><tbody>
            ${r.spikes.slice(0, 15).map(s => `<tr><td>${new Date(s.ts).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${s.from} → ${s.peak} %</td><td>${s.recoverMin != null ? `${s.recoverMin} min` : 'lento'}</td></tr>`).join('')}</tbody></table></details>` : ''}
        </article>`).join('')}</div>`;
  }
  document.addEventListener('click', e => { const b = e.target.closest('[data-hdays]'); if (b) { days = Number(b.dataset.hdays); window.loadUmidita(); } });
})();
