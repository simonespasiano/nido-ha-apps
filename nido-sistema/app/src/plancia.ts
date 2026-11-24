/**
 * Plancia di Home Assistant per l'app.
 *
 * All'avvio (solo dentro Home Assistant):
 *  1. copia la scheda `nido-app-card.js` in /config/www/nido/ (servita da HA come /local/nido/…)
 *  2. la registra fra le risorse delle plance (una sola volta, aggiornando la versione)
 *  3. crea, se non c'è già, una plancia con l'app a tutto schermo
 *
 * Una plancia, a differenza del pannello laterale dell'app, si può scegliere come pagina iniziale
 * e riordinare come le altre. La plancia creata non viene mai sovrascritta: se la modifichi resta tua.
 * Ogni passo è indipendente: se qualcosa non va lo scrive nel registro e l'app continua normalmente.
 * Questo file è identico in tutte le app NIDO.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PlanciaOptions {
  /** slug dell'app senza il prefisso del repository, es. nido_clima */
  addon: string;
  /** indirizzo della plancia, deve contenere un trattino, es. nido-clima */
  urlPath: string;
  title: string;
  icon: string;
  /** cartella con nido-app-card.js dentro l'immagine dell'app */
  cardDir: string;
  log: (m: string) => void;
}

const CONFIG_DIR = process.env.HA_CONFIG_DIR ?? '/homeassistant';
const CARD_FILE = 'nido-app-card.js';
const CARD_URL = `/local/nido/${CARD_FILE}`;

class MiniWS {
  private ws!: WebSocket;
  private id = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  open(url: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => { reject(new Error('Home Assistant non risponde')); ws.close(); }, 20_000);
      ws.onmessage = ev => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (msg.type === 'auth_invalid') { clearTimeout(timer); reject(new Error('autenticazione rifiutata')); }
        else if (msg.type === 'auth_ok') { clearTimeout(timer); resolve(); }
        else if (msg.type === 'result') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          msg.success ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? msg.error?.code ?? 'errore'));
        }
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('connessione a Home Assistant non riuscita')); };
      ws.onclose = () => { this.pending.forEach(p => p.reject(new Error('connessione chiusa'))); this.pending.clear(); };
    });
  }

  call(msg: Record<string, unknown>): Promise<any> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, ...msg }));
    });
  }

  close() { try { this.ws.close(); } catch { /* già chiusa */ } }
}

/** Copia la scheda in /config/www/nido. Restituisce la versione (hash) e se la cartella www è nuova. */
function installCard(o: PlanciaOptions): { version: string; newWww: boolean } | null {
  const src = join(o.cardDir, CARD_FILE);
  if (!existsSync(src)) { o.log(`Plancia: ${CARD_FILE} mancante nell'app`); return null; }
  if (!existsSync(CONFIG_DIR)) {
    o.log('Plancia: cartella di configurazione di Home Assistant non accessibile, salto la scheda');
    return null;
  }
  const content = readFileSync(src);
  const version = createHash('sha1').update(content).digest('hex').slice(0, 10);
  const www = join(CONFIG_DIR, 'www');
  const newWww = !existsSync(www);
  const dir = join(www, 'nido');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, CARD_FILE);
  if (!existsSync(dest) || !readFileSync(dest).equals(content)) writeFileSync(dest, content);
  return { version, newWww };
}

async function registerResource(ws: MiniWS, version: string, log: (m: string) => void) {
  const url = `${CARD_URL}?v=${version}`;
  let resources: any[];
  try { resources = await ws.call({ type: 'lovelace/resources' }); }
  catch (e) { log(`Plancia: risorse non leggibili (${(e as Error).message})`); return; }
  const mine = resources.filter(r => typeof r.url === 'string' && r.url.split('?')[0] === CARD_URL);
  try {
    if (!mine.length) {
      await ws.call({ type: 'lovelace/resources/create', res_type: 'module', url });
      log('Plancia: scheda NIDO registrata fra le risorse');
    } else if (mine[0].url !== url) {
      await ws.call({ type: 'lovelace/resources/update', resource_id: mine[0].id, res_type: 'module', url });
      log('Plancia: scheda NIDO aggiornata');
    }
    // due app avviate insieme possono averla registrata due volte
    for (const extra of mine.slice(1))
      await ws.call({ type: 'lovelace/resources/delete', resource_id: extra.id }).catch(() => undefined);
  } catch (e) {
    log(`Plancia: non riesco a registrare la scheda (${(e as Error).message}). `
      + `Se le risorse sono in YAML aggiungi a mano: ${CARD_URL} (module)`);
  }
}

async function createDashboard(ws: MiniWS, o: PlanciaOptions) {
  const dashboards: any[] = await ws.call({ type: 'lovelace/dashboards/list' });
  if (dashboards.some(d => d.url_path === o.urlPath)) return;
  await ws.call({
    type: 'lovelace/dashboards/create',
    url_path: o.urlPath, title: o.title, icon: o.icon,
    show_in_sidebar: true, require_admin: true,
  });
  await ws.call({
    type: 'lovelace/config/save', url_path: o.urlPath,
    config: {
      title: o.title,
      views: [{ title: o.title, path: 'app', icon: o.icon, type: 'panel',
        cards: [{ type: 'custom:nido-app-card', addon: o.addon }] }],
    },
  });
  o.log(`Plancia "${o.title}" creata (/${o.urlPath})`);
}

export async function setupPlancia(o: PlanciaOptions): Promise<void> {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) return; // fuori da Home Assistant (sviluppo, demo)
  let card: ReturnType<typeof installCard> = null;
  try { card = installCard(o); }
  catch (e) { o.log(`Plancia: non riesco a copiare la scheda (${(e as Error).message})`); }

  const ws = new MiniWS();
  try {
    await ws.open('ws://supervisor/core/websocket', token);
    if (card) await registerResource(ws, card.version, o.log);
    await createDashboard(ws, o);
    if (card?.newWww) {
      await ws.call({
        type: 'call_service', domain: 'persistent_notification', service: 'create',
        service_data: {
          notification_id: 'nido_plancia_riavvio',
          title: 'NIDO: riavvia Home Assistant una volta',
          message: `Ho creato la cartella www per la scheda delle plance NIDO. Home Assistant la vede solo dopo un riavvio: `
            + `Impostazioni → Sistema → Riavvia. Dopo il riavvio la plancia "${o.title}" mostrerà l'app.`,
        },
      }).catch(() => undefined);
      o.log('Plancia: creata la cartella www, serve un riavvio di Home Assistant perché la scheda venga caricata');
    }
  } catch (e) {
    o.log(`Plancia non creata: ${(e as Error).message}`);
  } finally {
    ws.close();
  }
}
