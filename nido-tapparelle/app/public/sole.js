// Sole e meteo: percorso del sole, facciate, protezione estiva, guadagno invernale, vento e pioggia.

function compass(path, shutters) {
  const S = 420, cx = S / 2, cy = S / 2, R = 170;
  const pt = (az, el) => { const r = R * (1 - Math.max(0, el) / 90), a = az * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
  const line = pts => pts.length ? 'M' + pts.map(p => pt(p.azimuth, p.elevation).map(v => v.toFixed(1)).join(',')).join(' L') : '';
  const faces = new Map();
  for (const s of shutters) if (s.settings.orientation != null) {
    const k = s.settings.orientation; if (!faces.has(k)) faces.set(k, { width: s.settings.sunHalfWidth, names: [] }); faces.get(k).names.push(s.name);
  }
  const wedge = (o, w) => {
    const a0 = (o - w) * Math.PI / 180, a1 = (o + w) * Math.PI / 180, r = R;
    return `M${cx},${cy} L${cx + r * Math.sin(a0)},${cy - r * Math.cos(a0)} A${r},${r} 0 ${2 * w > 180 ? 1 : 0} 1 ${cx + r * Math.sin(a1)},${cy - r * Math.cos(a1)} Z`;
  };
  const now = path.now;
  const hours = path.points.filter(p => new Date(p.ts).getMinutes() === 0 && p.elevation > 0);
  return `<svg class="compass" viewBox="0 0 ${S} ${S}">
    ${[...faces].map(([o, f]) => `<path class="cone" d="${wedge(o, f.width)}"/>`).join('')}
    ${[0, 30, 60].map(el => `<circle class="ring" cx="${cx}" cy="${cy}" r="${R * (1 - el / 90)}"/>`).join('')}
    <text x="${cx + 4}" y="${cy - R * (1 - 30 / 90) + 12}">30°</text><text x="${cx + 4}" y="${cy - R * (1 - 60 / 90) + 12}">60°</text>
    ${[['N', 0], ['E', 90], ['S', 180], ['O', 270]].map(([l, a]) => { const [x, y] = pt(a, -8); return `<text x="${x}" y="${y + 4}" text-anchor="middle" style="font-weight:700">${l}</text>`; }).join('')}
    <path class="path s" d="${line(path.summer)}"/><path class="path s" d="${line(path.winter)}"/>
    <path class="path" d="${line(path.points.filter(p => p.elevation >= 0))}"/>
    ${hours.map(p => { const [x, y] = pt(p.azimuth, p.elevation); return `<circle cx="${x}" cy="${y}" r="2" fill="var(--sun)"/><text x="${x + 4}" y="${y - 4}" style="font-size:9px">${new Date(p.ts).getHours()}</text>`; }).join('')}
    ${[...faces].map(([o, f]) => { const [x, y] = pt(o, 0); const [lx, ly] = pt(o, 20); return `<line class="face" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}"/><text class="face-lbl" x="${lx}" y="${ly}" text-anchor="middle">${esc(f.names.length > 2 ? `${f.names.length} finestre` : f.names.join(', '))}</text>`; }).join('')}
    ${now && now.elevation > 0 ? (() => { const [x, y] = pt(now.azimuth, now.elevation); return `<circle cx="${x}" cy="${y}" r="9" fill="var(--sun)" stroke="var(--card)" stroke-width="3"/>`; })() : ''}
  </svg>
  <p class="lg" style="justify-content:center"><span><i style="background:var(--sun)"></i>oggi</span><span><i style="border-top:2px dashed var(--sun);height:0"></i>21 giugno / 21 dicembre</span><span><i style="background:var(--valve)"></i>facciate (spicchio = quando il sole la colpisce)</span></p>`;
}

async function renderSun() {
  const el = $('#sole');
  const [st, path] = await Promise.all([api('api/settings'), api('api/sunpath')]);
  settingsCache = st;
  const g = st.global, o = ov.overview;
  const sun = o.sun;
  const unknown = ov.shutters.filter(s => s.settings.orientation == null).length;
  el.innerHTML = `
    <div class="two">
      <div class="card"><h2>Il sole oggi</h2>
        ${sun ? compass(path, ov.shutters) : '<p class="note">Imposta la posizione della casa in Home Assistant (Impostazioni → Sistema → Generale) per calcolare il sole.</p>'}
        ${sun ? `<div class="mstats"><div><span>Alba</span><b>${sun.sunrise ? hhmm(sun.sunrise) : '–'}</b></div><div><span>Tramonto</span><b>${sun.sunset ? hhmm(sun.sunset) : '–'}</b></div>
          <div><span>Ora</span><b>${Math.round(sun.azimuth)}° · ${Math.round(sun.elevation)}°</b><small>direzione · altezza</small></div><div><span>Stagione</span><b>${esc(o.seasonLabel)}</b><small>${g.season === 'auto' ? 'automatica' : 'scelta da te'}</small></div></div>` : ''}
      </div>
      <div class="card"><h2>Fuori adesso</h2>
        <div class="mstats">
          <div><span>Temperatura</span><b>${o.outdoor.temp != null ? n1(o.outdoor.temp) + ' °C' : '–'}</b></div>
          <div><span>Luce</span><b>${o.outdoor.lux != null ? Math.round(o.outdoor.lux).toLocaleString('it-IT') + ' lx' : '–'}</b></div>
          <div><span>Vento</span><b>${o.outdoor.wind != null ? Math.round(o.outdoor.wind) : '–'}</b></div>
          <div><span>Meteo</span><b>${esc(o.outdoor.weather ?? '–')}</b>${o.outdoor.rain ? '<small>pioggia</small>' : ''}</div>
        </div>
        <p class="note">I sensori si scelgono nella scheda <a href="#sensori" data-go="sensori">Sensori</a>.</p>
        <h2 style="margin-top:8px">Adesso, finestra per finestra</h2>
        <div class="next-list">${ov.shutters.map(s => `<div><time>${s.sun.want ? '☀️' : s.sun.hit ? '🌤' : '·'}</time><span><b>${esc(s.name)}</b> — ${esc(s.sun.why)}${s.protect ? ' · <b>in ombra</b>' : ''}</span></div>`).join('')}</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px"><div class="card-head"><h2>Facciate</h2><span class="note">${unknown ? `${unknown} senza orientamento` : 'tutte impostate'}</span></div>
      <p class="note">Indica verso dove guarda ogni finestra. La posizione d'ombra è quanto resta aperta quando il sole batte.</p>
      <div class="scroll"><table class="mini"><tr><th>Tapparella</th><th>Guarda verso</th><th>Ombra %</th><th>Ampiezza °</th><th>Sole d'inverno</th></tr>
      ${ov.shutters.map(s => `<tr data-id="${s.id}"><td>${esc(s.name)}<br><small class="note">${esc(s.area ?? '')}</small></td>
        <td><select data-k="orientation"><option value="">—</option>${st.directions.map(d => `<option value="${d.deg}" ${s.settings.orientation === d.deg ? 'selected' : ''}>${d.label}</option>`).join('')}
          ${s.settings.orientation != null && !st.directions.some(d => d.deg === s.settings.orientation) ? `<option value="${s.settings.orientation}" selected>${s.settings.orientation}°</option>` : ''}</select></td>
        <td><input type="number" class="inp" style="width:70px" data-k="shadePos" min="0" max="100" step="5" value="${s.settings.shadePos}"></td>
        <td><input type="number" class="inp" style="width:70px" data-k="sunHalfWidth" min="20" max="90" step="5" value="${s.settings.sunHalfWidth}"></td>
        <td><span class="toggle"><input type="checkbox" data-k="winterGain" ${s.settings.winterGain ? 'checked' : ''}><span></span></span></td></tr>`).join('')}
      </table></div>
      <div class="dlg-actions"><button class="btn primary" id="faces-save">Salva facciate</button></div>
    </div>

    <div class="two" style="margin-top:14px">
      <div class="card"><div class="card-head"><h2>☀️ Protezione dal sole</h2><span class="toggle"><input type="checkbox" id="s-en" ${g.sun.enabled ? 'checked' : ''}><span></span></span></div>
        <p class="note" style="margin:0">Quando il sole batte su una finestra e fa caldo, la abbassa alla posizione d'ombra; quando il sole se ne va la riporta com'era.</p>
        <div class="form">
          <label class="frow"><span>Temperatura esterna minima<small>Senza sensore: solo in estate</small></span><span><input type="number" id="s-temp" min="-20" max="45" value="${g.sun.minOutdoorTemp}"> °C</span></label>
          <label class="frow"><span>Luce minima<small>Con un sensore di luce: niente ombra se è nuvoloso</small></span><span><input type="number" id="s-lux" min="0" max="150000" step="1000" value="${g.sun.minLux}"> lx</span></label>
          <label class="frow"><span>Temperatura minima in casa<small>Facoltativa, dal sensore della stanza</small></span><span><input type="number" id="s-in" min="10" max="40" step="0.5" value="${g.sun.minIndoorTemp ?? ''}" placeholder="—"> °C</span></label>
          <label class="frow"><span>Altezza minima del sole</span><span><input type="number" id="s-elev" min="0" max="60" value="${g.sun.minElevation}"> °</span></label>
          <label class="frow"><span>Attesa prima di muovere<small>Evita su e giù con le nuvole</small></span><span><input type="number" id="s-delay" min="0" max="60" value="${g.sun.delayMin}"> min</span></label>
          <label class="frow"><span>Quando la casa è vuota, scendi fino a<small>Vuoto = posizione d'ombra di ognuna</small></span><span><input type="number" id="s-away" min="0" max="100" step="5" value="${g.sun.awayPos ?? ''}" placeholder="—"> %</span></label>
          <label class="frow"><span>Riporta com'era quando il sole se ne va</span><span class="toggle"><input type="checkbox" id="s-restore" ${g.sun.restore ? 'checked' : ''}><span></span></span></label>
          <label class="frow"><span>Mai d'inverno</span><span class="toggle"><input type="checkbox" id="s-summer" ${g.sun.onlySummer ? 'checked' : ''}><span></span></span></label>
        </div>
      </div>
      <div class="card"><h2>Stagione, inverno e meteo</h2>
        <div class="form">
          <label class="frow"><span>Stagione<small>Automatica: dal mese e dalla temperatura esterna</small></span><select id="w-season">
            ${[['auto', 'Automatica'], ['estate', 'Estate'], ['mezza', 'Mezza stagione'], ['inverno', 'Inverno']].map(([k, v]) => `<option value="${k}" ${g.season === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="frow"><span>Sole d'inverno<small>Apre le tapparelle segnate nella tabella delle facciate quando il sole le scalda</small></span><span class="toggle"><input type="checkbox" id="w-winter" ${g.winter.enabled ? 'checked' : ''}><span></span></span></label>
          <label class="frow"><span>Vento forte oltre<small>Nella stessa unità del sensore (es. km/h)</small></span><span><input type="number" id="w-wind" min="5" max="200" value="${g.weather.windAbove ?? ''}" placeholder="—"></span></label>
          <label class="frow"><span>Con vento forte</span><select id="w-windact">${[['nessuna', 'Non fare nulla'], ['apri', 'Apri tutte'], ['chiudi', 'Chiudi tutte']].map(([k, v]) => `<option value="${k}" ${g.weather.windAction === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="frow"><span>Con la pioggia</span><select id="w-rainact">${[['nessuna', 'Non fare nulla'], ['apri', 'Apri tutte'], ['chiudi', 'Chiudi tutte']].map(([k, v]) => `<option value="${k}" ${g.weather.rainAction === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        </div>
        <p class="note">Durante vento forte o pioggia le automazioni restano ferme; riprendono 15 minuti dopo che il vento è calato.</p>
      </div>
    </div>
    <div class="au-bar"><button class="btn primary" id="sun-save">Salva</button><span class="note">Le facciate si salvano col loro pulsante</span></div>`;

  el.querySelector('[data-go]')?.addEventListener('click', e => { e.preventDefault(); showTab('sensori'); });
  el.querySelector('#faces-save').onclick = async () => {
    for (const tr of el.querySelectorAll('tr[data-id]')) {
      const v = k => tr.querySelector(`[data-k=${k}]`);
      await api(`api/shutters/${tr.dataset.id}/settings`, {
        orientation: v('orientation').value === '' ? null : Number(v('orientation').value),
        shadePos: Number(v('shadePos').value), sunHalfWidth: Number(v('sunHalfWidth').value), winterGain: v('winterGain').checked,
      }).catch(e => toast(e.message, true));
    }
    toast('Facciate salvate'); await refresh(); renderSun();
  };
  el.querySelector('#sun-save').onclick = async () => {
    const q = s => el.querySelector(s);
    const ng = { ...g,
      sun: { enabled: q('#s-en').checked, minOutdoorTemp: Number(q('#s-temp').value), minLux: Number(q('#s-lux').value),
        minIndoorTemp: q('#s-in').value === '' ? null : Number(q('#s-in').value), minElevation: Number(q('#s-elev').value), delayMin: Number(q('#s-delay').value),
        awayPos: q('#s-away').value === '' ? null : Number(q('#s-away').value), restore: q('#s-restore').checked, onlySummer: q('#s-summer').checked },
      season: q('#w-season').value, winter: { enabled: q('#w-winter').checked },
      weather: { windAbove: q('#w-wind').value === '' ? null : Number(q('#w-wind').value), windAction: q('#w-windact').value, rainAction: q('#w-rainact').value },
    };
    await run(() => api('api/settings', ng), 'Salvato'); settingsCache = null; await refresh(); renderSun();
  };
}

loaders.sole = () => renderSun().catch(e => toast(e.message, true));
