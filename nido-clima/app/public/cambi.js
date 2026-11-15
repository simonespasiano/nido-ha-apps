// NIDO Clima — Chi cambia la temperatura: ogni cambio di obiettivo con la sua origine.
(() => {
  let days = 14, open = false;
  const ORIG = {
    utente: ['👤', 'Persone', 'var(--c1)'],
    valvola: ['🔧', 'Sulla valvola', 'var(--c2)'],
    automazione: ['⚙️', 'Automazioni di HA', 'var(--c4)'],
    nido: ['🏠', 'NIDO', 'var(--c3)'],
    programma: ['🕒', 'Programmi', 'var(--c7)'],
  };
  window.loadCambi = async () => { render(await api(`api/changes?days=${days}`)); };

  function hours(h) {
    const max = Math.max(1, ...h);
    return `<div class="cb-hours" title="A che ora si ritocca la temperatura (escluso NIDO)">${h.map((n, i) =>
      `<i style="height:${Math.round((n / max) * 100)}%" title="${i}:00 · ${n}"></i>`).join('')}</div>
      <div class="tl-h"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>`;
  }
  const MAN = ['utente', 'valvola', 'automazione'];
  const bar = c => {
    const tot = MAN.reduce((a, k) => a + (c[k] ?? 0), 0);
    if (!tot) return '<span class="note">nessuno</span>';
    return `<div class="hbands" title="${tot} cambi a mano">${MAN.map(k => `<i style="width:${((c[k] ?? 0) / tot) * 100}%;background:${ORIG[k][2]}" title="${ORIG[k][1]}: ${c[k] ?? 0}"></i>`).join('')}</div>`;
  };

  function render(d) {
    const el = document.getElementById('cambi'); if (!el) return;
    const manual = d.byOrigin.utente + d.byOrigin.valvola + d.byOrigin.automazione;
    el.innerHTML = `<div class="card" style="margin-bottom:14px">
      <div class="card-head"><h2>Chi cambia la temperatura</h2>
        <div class="seg">${[7, 14, 30].map(n => `<button class="${n === days ? 'on' : ''}" data-cdays="${n}">${n} giorni</button>`).join('')}</div></div>
      ${!d.total ? '<p class="note">Ancora nessun cambio di obiettivo registrato con la sua origine.</p>' : `
      <div class="fig-grid">${Object.entries(ORIG).map(([k, [ic, name]]) => `<div class="fig">${ic} ${name}<b>${d.byOrigin[k]}</b></div>`).join('')}</div>
      <div class="cb-cols">
        <div><h3>Chi</h3>${d.byWho.length ? `<table class="mini"><tbody>${d.byWho.map(w => `<tr><td>${esc(w.who)}</td><td><b>${w.n}</b></td></tr>`).join('')}</tbody></table>` : '<p class="note">Solo NIDO.</p>'}</div>
        <div><h3>Dove (a mano)</h3><table class="mini"><tbody>${d.byRoom.map(r => `<tr><td>${esc(r.name)}</td><td style="width:60%">${bar(r)}</td></tr>`).join('')}</tbody></table></div>
        <div><h3>Quando</h3>${manual ? hours(d.byHour) : '<p class="note">–</p>'}</div>
      </div>
      ${d.list.length ? `<details ${open ? 'open' : ''} id="cb-det"><summary>Ultimi cambi a mano (${d.list.length})</summary><table class="mini"><thead><tr><th>Quando</th><th>Stanza</th><th>Cambio</th></tr></thead><tbody>
        ${d.list.map(e => `<tr><td>${new Date(e.ts).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(e.roomName ?? '')}</td><td>${ORIG[e.origin]?.[0] ?? ''} ${esc(e.message)}</td></tr>`).join('')}</tbody></table></details>` : ''}`}
      <p class="note">Le modifiche da Home Assistant (app, dashboard, assistente vocale) riportano la persona; quelle di automazioni e script di HA sono indicate a parte. Un cambio fatto sulla manopola, dall'app Aqara o da Zigbee2MQTT arriva senza nome: risulta <b>sulla valvola</b>. Se tieni attivo il programma interno delle valvole, anche i suoi cambi finiscono lì: con i programmi di NIDO il conteggio è pulito.</p>
    </div>`;
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-cdays]'); if (b) { days = Number(b.dataset.cdays); window.loadCambi(); }
  });
  document.addEventListener('toggle', e => { if (e.target.id === 'cb-det') open = e.target.open; }, true);
})();
