import type { PlantStatus, RoomStatus, Sample } from './types.js';

export interface DetectorConfig {
  onDelta: number;   // differenza valvola−stanza oltre cui il calorifero è caldo
  offDelta: number;  // differenza sotto cui torna freddo
}

/** Pendenza in °C/ora per regressione lineare sugli ultimi `windowMin` minuti. */
export function slope(samples: Sample[], key: 'tRoom' | 'tValve', windowMin: number, now: number): number | null {
  const from = now - windowMin * 60_000;
  const pts = samples.filter(s => s.ts >= from && s[key] != null);
  if (pts.length < 3) return null;
  const span = pts[pts.length - 1].ts - pts[0].ts;
  if (span < (windowMin * 60_000) / 2) return null;
  const xs = pts.map(p => (p.ts - pts[0].ts) / 3_600_000);
  const ys = pts.map(p => p[key] as number);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

const fmt = (n: number) => n.toFixed(1).replace('.', ',');

/**
 * Rileva se il calorifero sta scaldando combinando tre segnali:
 * 1. differenza tra temperatura della valvola (sul termosifone) e della stanza
 * 2. pendenza della temperatura della valvola (accensione/spegnimento rapidi)
 * 3. pendenza della stanza (conferma lenta, finestre aperte)
 * Con isteresi per non oscillare.
 */
export function detect(cfg: DetectorConfig, recent: Sample[], current: Sample, prev?: RoomStatus): RoomStatus {
  const now = current.ts;
  const all = [...recent, current];
  const delta = current.tValve != null && current.tRoom != null ? current.tValve - current.tRoom : null;
  const sV = slope(all, 'tValve', 20, now);
  const sR = slope(all, 'tRoom', 15, now);
  const wasHeating = prev?.heating ?? false;

  let heating = wasHeating;
  let reason = '';

  if (delta == null) {
    reason = 'Dati incompleti: manca la temperatura della valvola o della stanza';
  } else if (!wasHeating) {
    if (delta >= cfg.onDelta) {
      heating = true;
      reason = `Il termosifone è ${fmt(delta)} °C più caldo della stanza`;
    } else if (delta >= cfg.offDelta && sV != null && sV >= 4) {
      heating = true;
      reason = `Il termosifone si sta scaldando in fretta (+${fmt(sV)} °C/ora)`;
    } else {
      reason = sV != null && sV >= 1.5
        ? `Il termosifone sta salendo (+${fmt(sV)} °C/ora), in attesa di conferma`
        : `Termosifone alla temperatura della stanza (differenza ${fmt(delta)} °C)`;
    }
  } else {
    if (delta <= cfg.offDelta) {
      heating = false;
      reason = `Il termosifone è tornato alla temperatura della stanza (${fmt(delta)} °C)`;
    } else if (sV != null && sV <= -3 && delta < cfg.onDelta) {
      heating = false;
      reason = `Il termosifone si sta raffreddando (${fmt(sV)} °C/ora)`;
    } else {
      reason = `Il termosifone è ${fmt(delta)} °C più caldo della stanza`;
    }
  }

  // affidabilità: tanto più alta quanto più i segnali sono netti e concordi
  let confidence: RoomStatus['confidence'] = 'bassa';
  if (delta != null) {
    const margin = heating ? delta - cfg.offDelta : cfg.onDelta - delta;
    const concordant = sV == null ? false : heating ? sV > -1 : sV < 1;
    if (margin > 2 && concordant) confidence = 'alta';
    else if (margin > 0.7 || concordant) confidence = 'media';
  }

  // calo rapido della stanza: con il termosifone acceso la stanza dovrebbe salire, quindi è un segnale ancora più forte
  const window = sR != null && sR <= (heating ? -1.5 : -2);
  const requesting = current.mode !== 'off' && current.setpoint != null && current.tRoom != null
    && current.setpoint > current.tRoom + 0.3;

  return {
    heating,
    since: heating !== wasHeating || !prev ? now : prev.since,
    delta, slopeValve: sV, slopeRoom: sR,
    confidence, reason, window, requesting,
    requestingSince: requesting ? (prev?.requestingSince ?? now) : null,
  };
}

/**
 * Stato dell'impianto centralizzato, dedotto dalle stanze:
 * - almeno un calorifero caldo → acceso
 * - qualche stanza chiede calore da oltre 30 minuti ma nessun calorifero si scalda → spento
 * - nessuna richiesta → a riposo (non si può sapere)
 */
export function plantState(statuses: RoomStatus[], now: number, prev?: PlantStatus): PlantStatus {
  let state: PlantStatus['state'];
  if (statuses.some(s => s.heating)) state = 'acceso';
  else if (statuses.some(s => s.requestingSince != null && now - s.requestingSince > 30 * 60_000)) state = 'spento';
  else state = prev?.state === 'acceso' ? 'a_riposo' : (prev?.state ?? 'a_riposo');
  const labels = {
    acceso: 'Impianto acceso: almeno un termosifone scalda',
    spento: 'Impianto probabilmente spento: le valvole chiedono calore ma i termosifoni restano freddi',
    a_riposo: 'Nessuna stanza chiede calore: stato dell\'impianto non determinabile',
  } as const;
  return {
    state,
    since: prev && prev.state === state ? prev.since : now,
    label: labels[state],
  };
}
