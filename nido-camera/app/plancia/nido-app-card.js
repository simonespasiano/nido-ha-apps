/*
 * NIDO – scheda "app" per le plance di Home Assistant.
 *
 * Mostra dentro una plancia l'interfaccia di un'app NIDO (o di qualsiasi app con Ingress),
 * con lo stesso accesso protetto del pannello laterale: niente porte aperte, niente login a parte.
 *
 *   type: custom:nido-app-card
 *   addon: nido_clima        # slug dell'app (basta la parte finale, es. nido_tapparelle)
 *   percorso: ""             # facoltativo: pagina interna dell'app da aprire
 *   altezza: ""              # facoltativo: altezza CSS (predefinita: tutto lo schermo)
 *
 * Il file viene copiato in /config/www/nido/ dalle app NIDO e registrato da sole fra le risorse.
 * Funziona per gli utenti amministratori (come il pannello laterale delle app).
 */
const NIDO_CARD_VERSION = '1.0.0';

class NidoAppCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.addon) throw new Error("Indica l'app, ad esempio  addon: nido_clima");
    const changed = this._config && (this._config.addon !== config.addon || this._config.percorso !== config.percorso);
    this._config = config;
    if (changed && this._hass) { this._started = false; this._start(); }
    this._applyHeight();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._started && this.isConnected) this._start();
  }

  connectedCallback() {
    if (!this._started && this._hass && this._config) this._start();
  }

  disconnectedCallback() {
    clearInterval(this._keepAlive);
    this._keepAlive = undefined;
    this._started = false;
  }

  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full', rows: 12, min_rows: 6 }; }
  static getStubConfig() { return { addon: 'nido_clima' }; }

  _root() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          :host { display: block; }
          .wrap { position: relative; width: 100%; height: 100%; background: var(--primary-background-color); }
          iframe { border: 0; width: 100%; height: 100%; display: block; }
          .msg { padding: 24px; color: var(--primary-text-color); font-family: var(--paper-font-body1_-_font-family, sans-serif); line-height: 1.5; }
          .msg b { display: block; margin-bottom: 6px; }
          .msg small { color: var(--secondary-text-color); }
        </style>
        <div class="wrap"><div class="msg">Apertura dell'app…</div></div>`;
      this._applyHeight();
    }
    return this.shadowRoot;
  }

  _applyHeight() {
    const wrap = this.shadowRoot && this.shadowRoot.querySelector('.wrap');
    if (!wrap) return;
    wrap.style.height = (this._config && this._config.altezza)
      || 'calc(100dvh - var(--header-height, 56px) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))';
  }

  _message(title, detail) {
    this._root().querySelector('.wrap').innerHTML =
      `<div class="msg"><b>${title}</b><small>${detail || ''}</small></div>`;
  }

  _api(endpoint, method = 'get', data) {
    const msg = { type: 'supervisor/api', endpoint, method };
    if (data) msg.data = data;
    return this._hass.callWS(msg);
  }

  async _session() {
    const res = await this._api('/ingress/session', 'post');
    const session = res && res.session;
    if (!session) throw new Error('sessione non ricevuta');
    const secure = location.protocol === 'https:' ? ';Secure' : '';
    document.cookie = `ingress_session=${session};path=/api/hassio_ingress/;SameSite=Strict${secure}`;
    this._sessionId = session;
  }

  async _start() {
    if (!this._hass || !this._config) return;
    this._started = true;
    this._root();
    const wanted = String(this._config.addon).trim();
    const user = this._hass.user;
    if (user && user.is_admin === false) {
      this._message('Questa app è riservata agli amministratori',
        'Home Assistant apre le app solo agli utenti amministratori, come nel pannello laterale.');
      return;
    }
    try {
      const list = await this._api('/addons');
      const addons = (list && list.addons) || [];
      const addon = addons.find(a => a.slug === wanted) || addons.find(a => a.slug.endsWith('_' + wanted));
      if (!addon) {
        this._message(`App «${wanted}» non trovata`, 'Controlla che sia installata e che il nome in  addon:  sia giusto.');
        return;
      }
      const info = await this._api(`/addons/${addon.slug}/info`);
      if (!info.ingress || !info.ingress_url) {
        this._message(`${info.name} non ha un'interfaccia da mostrare`, '');
        return;
      }
      if (info.state !== 'started') {
        this._message(`${info.name} è ferma`, 'Avviala da Impostazioni → App, poi ricarica la pagina.');
        return;
      }
      await this._session();
      clearInterval(this._keepAlive);
      this._keepAlive = setInterval(async () => {
        try { await this._api('/ingress/validate_session', 'post', { session: this._sessionId }); }
        catch { try { await this._session(); } catch { /* riprova al prossimo giro */ } }
      }, 60_000);

      const path = String(this._config.percorso || '').replace(/^\/+/, '');
      const frame = document.createElement('iframe');
      frame.title = info.name;
      frame.allow = 'fullscreen; clipboard-write';
      frame.src = info.ingress_url + path;
      const wrap = this._root().querySelector('.wrap');
      wrap.innerHTML = '';
      wrap.appendChild(frame);
    } catch (err) {
      this._started = false;
      this._message('App non raggiungibile', (err && (err.message || err.code)) || String(err));
    }
  }
}

if (!customElements.get('nido-app-card')) {
  customElements.define('nido-app-card', NidoAppCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'nido-app-card',
    name: 'NIDO – App',
    description: "Mostra un'app NIDO (NIDO Clima, NIDO Tapparelle…) dentro una plancia",
  });
  console.info(`%c NIDO app card %c ${NIDO_CARD_VERSION} `, 'background:#2e7d32;color:#fff', 'background:#eee;color:#333');
}
