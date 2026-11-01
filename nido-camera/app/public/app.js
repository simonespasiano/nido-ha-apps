/* NIDO Camera: interfaccia */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = path => fetch(path, { cache: 'no-store' }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
const post = (path, body = {}) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; });
let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast'); t.textContent = msg; t.className = error ? 'error' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}
const fmtTime = ts => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtHM = ts => new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const fmtDay = ts => new Date(ts).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtDur = (a, b) => { if (!b) return ''; const s = Math.round((b - a) / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtMB = b => b < 1024 ** 3 ? `${Math.round(b / 1024 / 1024)} MB` : `${(b / 1024 ** 3).toLocaleString('it-IT', { maximumFractionDigits: 1 })} GB`;
const media = rel => `media/${rel}`;
const DAYS = [[1, 'lun'], [2, 'mar'], [3, 'mer'], [4, 'gio'], [5, 'ven'], [6, 'sab'], [0, 'dom']];

const S = { ov: null, tab: 'diretta', live: false, liveEl: null };

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => goto(b.dataset.tab)));
function goto(tab) {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === tab)));
  document.querySelectorAll('.tab').forEach(s => (s.hidden = s.id !== `tab-${tab}`));
  S.tab = tab;
  if (tab !== 'diretta') stopLive();
  ({ eventi: loadEvents, privacy: renderPrivacy, impostazioni: loadSettings })[tab]?.();
}
document.addEventListener('click', ev => { const g = ev.target.closest('[data-goto]'); if (g) goto(g.dataset.goto); });
document.querySelectorAll('dialog [data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$('#viewer').addEventListener('close', () => { const v = $('#v-body video'); if (v) v.pause(); });

let timer;
async function refresh() {
  clearTimeout(timer);
  try {
    S.ov = await api('api/overview');
    header();
    if (S.tab === 'diretta') renderLive();
  } catch (e) { $('#subtitle').textContent = `Server non raggiungibile (${e.message})`; }
  timer = setTimeout(refresh, S.ov?.recording ? 2000 : 5000);
}

function header() {
  const o = S.ov;
  $('#subtitle').textContent = o.camera ? `${o.camera.deviceName ?? o.camera.title}${o.demo ? ' · demo con immagini di prova' : ''}` : 'Nessuna camera HomeKit trovata';
  const pill = $('#status-pill'); pill.hidden = false;
  const paused = o.rules.pausedUntil && o.rules.pausedUntil > Date.now();
  pill.innerHTML = o.recording ? '<span class="dot bad"></span>Registra' : paused ? '<span class="dot warn"></span>In pausa' : o.camera ? `<span class="dot on"></span>Attiva` : '<span class="dot"></span>Da configurare';
  $('#footer').textContent = `NIDO Camera ${o.version} · ${o.ha.kind === 'demo' ? 'casa simulata' : o.ha.connected ? 'collegata a Home Assistant' : 'Home Assistant non raggiungibile'}${o.ha.bridge === 'mqtt' ? ' · entità via MQTT' : ''} · spazio ${fmtMB(o.bytes)} di ${o.maxBytes / 1024 ** 3} GB`;
}

// ── Diretta ──
function renderLive() {
  const o = S.ov;
  const banner = $('#banner');
  if (!o.camera) banner.innerHTML = `<div class="banner"><b>Nessuna camera abbinata</b>Abbina la G3 a Home Assistant come HomeKit Device: i passi sono in <a href="#" data-goto="impostazioni">Impostazioni</a>.</div>`;
  else if (o.backend.error && !o.backend.active && !S.live) banner.innerHTML = `<div class="banner"><b>go2rtc segnala un problema</b>${esc(o.backend.error)}</div>`;
  else banner.innerHTML = '';

  if (!S.live) {
    $('#player').innerHTML = `${o.recording ? '<span class="rec">REC</span>' : ''}
      ${o.lastSnapshot ? `<img src="${media(o.lastSnapshot.rel)}" alt="Ultima foto">` : ''}
      <div class="overlay">${!o.live.allowed ? '<p>Diretta disattivata quando c\'è qualcuno in casa (Privacy).</p>' : !o.camera ? '<p>Camera non configurata</p>' :
        `<button class="btn primary" id="start-live">▶ Avvia la diretta</button><p>${o.lastSnapshot ? `Ultima foto alle ${fmtHM(o.lastSnapshot.ts)}${o.lastSnapshot.source === 'homekit' ? ' (da HomeKit: go2rtc non ha dato il video)' : ''}. ` : ''}Con HomeKit il video arriva dopo qualche secondo.</p>`}</div>`;
  } else {
    const rec = $('#player .rec');
    if (o.recording && !rec) $('#player').insertAdjacentHTML('afterbegin', '<span class="rec">REC</span>');
    if (!o.recording && rec) rec.remove();
  }
  const dis = o.camera ? '' : 'disabled';
  $('#live-actions').innerHTML = `
    ${S.live ? '<button class="btn" id="stop-live">■ Ferma la diretta</button>' : ''}
    <button class="btn" id="snap" ${dis}>📷 Scatta foto</button>
    ${o.recording ? `<button class="btn danger" id="rec-stop">■ Ferma registrazione</button><span class="note">in corso da ${fmtDur(o.recording.started, Date.now())}</span>` : `<button class="btn" id="rec" ${dis}>⏺ Registra 30 secondi</button>`}`;

  const d = o.decision, paused = o.rules.pausedUntil && o.rules.pausedUntil > Date.now();
  $('#now-card').innerHTML = `
    <div class="card-head"><h2>Se ora c'è movimento</h2></div>
    <div class="decision">
      <div>Registra: <span class="${d.record ? 'yes' : 'no'}">${d.record ? 'sì' : 'no'}</span></div>
      <div>Notifica: <span class="${d.notify ? 'yes' : 'no'}">${d.notify ? 'sì' : 'no'}</span></div>
      ${d.why.length ? `<p class="note">${esc(d.why.join(' · '))}</p>` : ''}
    </div>
    <div class="facts">
      <div>In casa<b>${o.people.length ? esc(o.people.filter(p => p.home).map(p => p.name).join(', ') || 'nessuno') : '–'}</b></div>
      <div>Aspirapolvere<b>${o.vacuumBusy ? 'sta pulendo' : 'fermo'}</b></div>
      <div>Movimenti oggi<b>${o.today.events}</b></div>
      <div>Clip oggi<b>${o.today.recorded}</b></div>
    </div>
    <h3>Pausa</h3>
    <div class="go">${paused ? `<span class="note">Fino alle ${fmtHM(o.rules.pausedUntil)}${o.rules.pausedUntil - Date.now() > 86400_000 ? ` del ${new Date(o.rules.pausedUntil).toLocaleDateString('it-IT')}` : ''}</span><button class="btn small primary" data-pause="0">Riprendi</button>` :
      '<button class="btn small" data-pause="60">1 ora</button><button class="btn small" data-pause="240">4 ore</button><button class="btn small" data-pause="720">12 ore</button>'}</div>
    <p class="note">In pausa non registra e non manda notifiche. La diretta resta disponibile.</p>`;

  if (o.demo) {
    const c = $('#demo-card'); c.hidden = false;
    const t = o.triggers[0];
    c.innerHTML = `<div class="card-head"><h2>Casa simulata</h2><span class="pill">solo demo</span></div>
      <div class="chips">
        ${t ? `<button class="chip ${t.state === 'on' ? 'on' : ''}" data-demo="${t.id}" data-st="${t.state === 'on' ? 'off' : 'on'}">Movimento: ${t.state === 'on' ? 'sì' : 'no'}</button>` : ''}
        ${o.people.map(p => `<button class="chip ${p.home ? 'on' : ''}" data-demo="${p.id}" data-st="${p.home ? 'not_home' : 'home'}">${esc(p.name)}: ${p.home ? 'in casa' : 'fuori'}</button>`).join('')}
        <button class="chip ${o.vacuumBusy ? 'on' : ''}" data-demo="vacuum.narwal" data-st="${o.vacuumBusy ? 'docked' : 'cleaning'}">Narwal: ${o.vacuumBusy ? 'pulisce' : 'sulla base'}</button>
      </div>`;
  }
  loadRecent();
}

async function loadRecent() {
  try { const evs = await api('api/events?days=2'); $('#recent').innerHTML = evs.slice(0, 6).map(thumb).join('') || '<p class="note">Nessun evento negli ultimi due giorni.</p>'; } catch { /* */ }
}

async function startLive() {
  const o = S.ov;
  S.live = true;
  const box = $('#player');
  box.innerHTML = '<div class="overlay"><p>Collegamento alla camera…</p></div>';
  if (o.live.kind === 'go2rtc') {
    try {
      await import(new URL('go2rtc/video-stream.js', location.href).href);
      const v = document.createElement('video-stream');
      v.mode = 'mse,mp4,mjpeg';
      v.background = false;
      v.src = new URL('go2rtc/api/ws?src=camera', location.href).href;
      box.innerHTML = ''; box.appendChild(v); S.liveEl = v;
      // se dopo 20 secondi non c'è immagine si prova il formato MJPEG, più lento ma più compatibile
      setTimeout(() => {
        if (!S.live || S.liveEl !== v) return;
        const video = v.querySelector('video');
        if (video && (video.readyState >= 2 || video.currentTime > 0)) return;
        const why = v.querySelector('.status')?.textContent?.trim();
        toast(`Video MSE non arrivato${why ? ` (${why})` : ''}: provo in MJPEG`, true);
        v.remove(); S.liveEl = null;
        box.innerHTML = `<img src="api/live.mjpeg?t=${Date.now()}" alt="Diretta" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'overlay',innerHTML:'<p>Anche il video MJPEG non arriva: guarda il Registro di go2rtc in Impostazioni.</p>'}))">`;
      }, 20_000);
    } catch (e) { toast(`Lettore go2rtc non caricato (${e.message}): provo in MJPEG`, true); box.innerHTML = `<img src="api/live.mjpeg?t=${Date.now()}" alt="Diretta">`; }
  } else box.innerHTML = `<img src="api/live.mjpeg?t=${Date.now()}" alt="Diretta">`;
  renderLive();
}
function stopLive() {
  if (!S.live) return;
  S.live = false;
  if (S.liveEl) { try { S.liveEl.remove(); } catch { /* */ } S.liveEl = null; }
  const img = $('#player img'); if (img) img.src = '';
  $('#player').innerHTML = '';
  if (S.ov) renderLive();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopLive(); });

$('#tab-diretta').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b || b.disabled) return;
  try {
    if (b.id === 'start-live') return startLive();
    if (b.id === 'stop-live') return stopLive();
    if (b.id === 'snap') { b.disabled = true; toast('Scatto in corso…'); await post('api/snapshot'); toast('Foto salvata'); }
    else if (b.id === 'rec') { await post('api/record'); toast('Registrazione avviata'); }
    else if (b.id === 'rec-stop') { await post('api/record/stop'); toast('Registrazione fermata'); }
    else if (b.dataset.pause != null) { const m = Number(b.dataset.pause); await post('api/rules', { pausedUntil: m ? Date.now() + m * 60_000 : null }); }
    else if (b.dataset.demo) await post('api/demo/state', { id: b.dataset.demo, state: b.dataset.st });
    else if (b.dataset.ev) return openEvent(Number(b.dataset.ev));
    else return;
  } catch (e) { toast(e.message, true); }
  refresh();
});

// ── Eventi ──
let evKind = 'tutti', evCache = [];
const KIND = { movimento: 'Movimento', foto: 'Foto', manuale: 'Registrazione manuale' };
function thumb(e) {
  const trig = e.trigger && !e.trigger.startsWith('da ') && e.trigger !== 'manuale' ? (S.ov?.triggers.find(t => t.id === e.trigger)?.name ?? e.trigger) : e.trigger?.startsWith('da ') ? e.trigger : '';
  return `<button class="thumb" data-ev="${e.id}">
    <div class="img" style="${e.thumb ? `background-image:url('${media(e.thumb)}')` : ''}">${e.recorded ? `<span class="dur">▶ ${fmtDur(e.ts, e.end)}</span>` : ''}</div>
    <div class="cap"><b>${fmtHM(e.ts)} · ${KIND[e.kind] ?? e.kind}</b>
      ${trig ? `<small>${esc(trig)}</small>` : ''}
      <div class="badges">${e.notified ? '<span class="pill on">notificato</span>' : ''}${e.end == null ? '<span class="pill warn">in corso</span>' : ''}</div>
      ${e.note ? `<small>${esc(e.note)}</small>` : ''}</div></button>`;
}
async function loadEvents() {
  try { evCache = await api(`api/events?days=${$('#ev-days').value}&kind=${evKind}`); } catch (e) { $('#events').innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  if (!evCache.length) { $('#events').innerHTML = '<p class="empty">Nessun evento nel periodo.</p>'; return; }
  const groups = new Map();
  for (const e of evCache) { const k = fmtDay(e.ts); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  $('#events').innerHTML = [...groups].map(([d, es]) => `<div class="day">${esc(d)} · ${es.length}</div><div class="thumbs">${es.map(thumb).join('')}</div>`).join('');
}
$('#ev-days').addEventListener('change', loadEvents);
$('#ev-kind').addEventListener('click', ev => { const b = ev.target.closest('button'); if (!b) return; evKind = b.dataset.k; $('#ev-kind').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); loadEvents(); });
$('#events').addEventListener('click', ev => { const b = ev.target.closest('[data-ev]'); if (b) openEvent(Number(b.dataset.ev)); });

async function openEvent(id) {
  let e = evCache.find(x => x.id === id);
  if (!e) { const evs = await api('api/events?days=30'); e = evs.find(x => x.id === id); }
  if (!e) return;
  $('#v-title').textContent = `${KIND[e.kind] ?? e.kind} · ${fmtDay(e.ts)} alle ${fmtTime(e.ts)}`;
  $('#v-sub').textContent = [e.recorded ? `video di ${fmtDur(e.ts, e.end)}` : 'senza video', e.notified ? 'notificato' : null, e.note].filter(Boolean).join(' · ');
  $('#v-body').innerHTML = `${e.clip ? `<video src="${media(e.clip)}" controls autoplay playsinline ${e.thumb ? `poster="${media(e.thumb)}"` : ''}></video>` : e.thumb ? `<img src="${media(e.thumb)}" alt="">` : '<p class="note">Nessuna immagine.</p>'}
    <div class="f-actions">${e.clip ? `<a class="btn small" href="${media(e.clip)}" download>Scarica il video</a>` : e.thumb ? `<a class="btn small" href="${media(e.thumb)}" download>Scarica la foto</a>` : '<span></span>'}<button class="btn small danger" data-del="${e.id}">Elimina</button></div>`;
  $('#viewer').showModal();
}
$('#v-body').addEventListener('click', async ev => {
  const b = ev.target.closest('[data-del]'); if (!b) return;
  if (!confirm('Eliminare questo evento e i suoi file?')) return;
  try { await post(`api/events/${b.dataset.del}/delete`); $('#viewer').close(); toast('Eliminato'); loadEvents(); loadRecent(); } catch (e) { toast(e.message, true); }
});

// ── Privacy ──
let rulesDraft = null;
function renderPrivacy() {
  const o = S.ov; if (!o) return;
  rulesDraft = JSON.parse(JSON.stringify(o.rules));
  draw();
  function draw() {
    const r = rulesDraft, M = o.modes;
    const seg = (key) => `<div class="seg" data-mode="${key}">${Object.entries(M).map(([k, l]) => `<button class="${r[key] === k ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div>`;
    $('#privacy').innerHTML = `<div class="settings">
      <div class="card"><div class="card-head"><h2>Quando registrare</h2></div>${seg('record')}
        <p class="note">"Solo a casa vuota" usa le persone di Home Assistant${o.people.length ? ` (${o.people.map(p => esc(p.name)).join(', ')})` : ''}: se c'è qualcuno in casa il movimento viene annotato ma non filmato.</p>
        <div class="card-head"><h2>Quando notificare</h2></div>${seg('notify')}
        <div class="f-row"><label>Al massimo una notifica ogni <input type="number" min="0" max="120" value="${r.cooldownMin}" data-k="cooldownMin"> minuti</label></div>
      </div>
      <div class="card"><div class="card-head"><h2>Fasce silenziose</h2><button class="btn small" data-add-quiet>+ Aggiungi</button></div>
        <p class="note">In queste fasce non arrivano notifiche. Puoi anche sospendere le registrazioni, per esempio la sera quando siete a casa.</p>
        <div>${r.quiet.map((q, i) => `<div class="quiet-row" data-q="${i}">
          <div class="chips">${DAYS.map(([d, n]) => `<button class="chip ${q.days.includes(d) ? 'on' : ''}" data-qd="${d}">${n}</button>`).join('')}</div>
          <label>dalle <input type="time" value="${q.from}" data-qf="from"></label><label>alle <input type="time" value="${q.to}" data-qf="to"></label>
          <label class="check"><input type="checkbox" ${q.noRecord ? 'checked' : ''} data-qf="noRecord"><span>anche senza registrare</span></label>
          <button class="btn small danger" data-qdel>Togli</button></div>`).join('') || '<p class="note">Nessuna fascia.</p>'}</div>
      </div>
      <div class="card"><div class="card-head"><h2>Altre regole</h2></div>
        <label class="check"><input type="checkbox" data-k="ignoreWhileVacuum" ${r.ignoreWhileVacuum ? 'checked' : ''}><span>Ignora il movimento mentre l'aspirapolvere pulisce<small>Vale per qualsiasi entità vacuum di Home Assistant, compreso il Narwal di NIDO Pulizie</small></span></label>
        <label class="check"><input type="checkbox" data-k="liveWhenHome" ${r.liveWhenHome ? 'checked' : ''}><span>Diretta disponibile anche quando c'è qualcuno in casa<small>Se la togli, la diretta si apre solo a casa vuota</small></span></label>
      </div>
    </div>
    <div class="go" style="margin-top:14px"><button class="btn primary" data-save-rules>Salva</button><span class="note">Le regole valgono subito.</span></div>`;
  }
  const box = $('#privacy');
  box.onclick = async ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const row = b.closest('[data-q]');
    if (b.closest('[data-mode]')) rulesDraft[b.closest('[data-mode]').dataset.mode] = b.dataset.v;
    else if (b.hasAttribute('data-add-quiet')) rulesDraft.quiet.push({ days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '07:00', noRecord: false });
    else if (row && b.dataset.qd != null) { const q = rulesDraft.quiet[row.dataset.q], d = Number(b.dataset.qd); q.days = q.days.includes(d) ? q.days.filter(x => x !== d) : [...q.days, d]; }
    else if (row && b.hasAttribute('data-qdel')) rulesDraft.quiet.splice(Number(row.dataset.q), 1);
    else if (b.hasAttribute('data-save-rules')) {
      try { await post('api/rules', rulesDraft); toast('Regole salvate'); await refresh(); } catch (e) { toast(e.message, true); }
      return;
    } else return;
    draw();
  };
  box.onchange = ev => {
    const t = ev.target, row = t.closest('[data-q]');
    if (row && t.dataset.qf) { const q = rulesDraft.quiet[row.dataset.q]; q[t.dataset.qf] = t.type === 'checkbox' ? t.checked : t.value; }
    else if (t.dataset.k) rulesDraft[t.dataset.k] = t.type === 'checkbox' ? t.checked : Number(t.value);
  };
}

// ── Impostazioni ──
async function loadSettings() {
  const o = S.ov; if (!o) return;
  let lg = { log: [], app: [], go2rtc: [], config: null };
  try { lg = await api('api/log'); } catch { /* */ }
  const step = (ok, title, body, warn = false) => `<div class="step"><i class="${ok ? 'ok' : warn ? 'warn' : ''}">${ok ? '✓' : '!'}</i><div><b>${title}</b>${body}</div></div>`;
  const cam = o.camera;
  const pct = Math.min(100, (o.bytes / o.maxBytes) * 100);
  $('#settings').innerHTML = `<div class="settings">
    <div class="card" style="grid-column:1/-1"><div class="card-head"><h2>Configurazione</h2><button class="btn small" data-rediscover>Ricontrolla</button></div>
      <div class="steps">
        ${step(o.ha.connected, 'Home Assistant', o.ha.connected ? '<small>Collegata</small>' : '<small>Non raggiungibile</small>')}
        ${step(!!cam, 'Camera abbinata in Home Assistant come HomeKit Device', cam ? `<small>${esc(cam.deviceName ?? cam.title)} · abbinamento «${esc(cam.title)}»${o.cameras.length > 1 ? ` · altre: ${o.cameras.filter(c => c.title !== cam.title).map(c => esc(c.title)).join(', ')} (scegli con l'opzione <code>camera</code>)` : ''}</small>` :
          `<ol>
            <li>Nell'app Aqara: la G3 non deve essere aggiunta ad Apple Casa. Se lo è, toglila da Casa sull'iPhone.</li>
            <li>Tieni a portata il <b>codice di configurazione HomeKit</b> (8 cifre): è sull'etichetta sotto la G3 o nella confezione. Nell'app Aqara lo trovi anche nelle impostazioni della camera alla voce HomeKit.</li>
            <li>In Home Assistant: <b>Impostazioni → Dispositivi e servizi</b>. Dovrebbe comparire tra i rilevati <b>HomeKit Device · Camera Hub G3</b>: Configura e inserisci il codice. Se non compare: Aggiungi integrazione → HomeKit Device.</li>
            <li>Torna qui e premi <b>Ricontrolla</b>.</li></ol>`)}
        ${step(o.backend.running || o.demo, 'go2rtc (video)', `<small>${o.demo ? 'non usato nella demo' : o.backend.running ? `in funzione${o.backend.active ? ' · flusso della camera attivo' : ' · il flusso parte quando serve'}` : 'non in funzione'}${o.backend.error ? ` · ultimo errore: ${esc(o.backend.error)}` : ''}${o.go2rtcError ? ` · foto: ${esc(o.go2rtcError)}` : ''}</small>`, !o.backend.running)}
        ${step(o.triggers.length > 0, 'Sensori di movimento', o.triggers.length ? `<small>${o.triggers.map(t => `${esc(t.name)} (${esc(t.state)})`).join(', ')}</small>` : '<small>Nessuno: indicali nell\'opzione <code>sensori_movimento</code> (es. binary_sensor.camera_hub_g3_motion)</small>', true)}
        ${step(o.notify.configured.length > 0, 'Notifiche', `<small>${o.notify.configured.length ? `A ${o.notify.configured.map(esc).join(', ')}` : 'Nessun servizio: aggiungilo nell\'opzione <code>notifiche</code>'}${o.notify.available.length ? `. Disponibili: ${o.notify.available.map(s => `<code class="copy">${esc(s)}</code>`).join(' ')}` : ''}</small>
          ${o.notify.configured.length ? '<div class="go" style="margin-top:6px"><button class="btn small" data-test-notify>Manda una notifica di prova</button></div>' : ''}`, true)}
      </div>
    </div>
    <div class="card"><div class="card-head"><h2>Spazio</h2></div>
      <div class="space"><i style="width:${pct}%"></i></div>
      <p class="note">${fmtMB(o.bytes)} di ${o.maxBytes / 1024 ** 3} GB · i video si tengono ${o.keepDays} giorni, poi si cancellano da soli (anche prima se lo spazio finisce). I file sono in <code>/media/nido-camera</code>, visibili anche in Home Assistant da Media → Media locali.</p>
    </div>
    <div class="card"><div class="card-head"><h2>Vederla anche nelle dashboard</h2></div>
      <p class="note">${o.rtsp ? `L'app offre un flusso RTSP locale. In Home Assistant aggiungi l'integrazione <b>Generic Camera</b> con questo indirizzo come URL dello stream:<br><code class="copy">${esc(o.rtsp)}</code><br>Lascia vuoto l'URL dell'immagine fissa. Con MQTT trovi anche il dispositivo <b>NIDO Camera</b> con l'ultima foto, gli interruttori della privacy e i pulsanti foto e registra.` : 'Non disponibile nella demo.'}</p>
    </div>
    <div class="card" style="grid-column:1/-1"><div class="card-head"><h2>Diario</h2></div>
      <div class="log">${lg.log.map(l => `<div><time>${new Date(l.ts).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>${esc(l.message)}${l.user ? ` · ${esc(l.user)}` : ''}</div>`).join('') || '<div>vuoto</div>'}</div>
      <details><summary>Registro dell'app</summary><div class="log">${lg.app.map(l => `<div><time>${fmtTime(l.ts)}</time>${esc(l.msg)}</div>`).join('')}</div></details>
      ${lg.go2rtc.length ? `<details><summary>Registro di go2rtc</summary><div class="log">${lg.go2rtc.map(l => `<div>${esc(l)}</div>`).join('')}</div></details>` : ''}
      ${lg.config ? `<details><summary>Configurazione di go2rtc</summary><pre class="raw">${esc(lg.config.replace(/hass:[^"\n]*/g, m => m))}</pre></details>` : ''}
    </div>
  </div>`;
}
$('#settings').addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  try {
    if (b.hasAttribute('data-rediscover')) { const r = await post('api/rediscover'); toast(r.camera ? `Camera trovata: ${r.camera.deviceName ?? r.camera.title}` : 'Nessuna camera HomeKit trovata', !r.camera); }
    else if (b.hasAttribute('data-test-notify')) { b.disabled = true; await post('api/notify/test'); toast('Notifica inviata'); }
    else return;
  } catch (e) { toast(e.message, true); }
  await refresh(); loadSettings();
});

refresh();
