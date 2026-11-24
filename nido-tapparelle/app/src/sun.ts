/** Posizione del sole e orari di alba e tramonto (algoritmo NOAA), calcolati in locale senza servizi esterni. */

const rad = Math.PI / 180;
const deg = 180 / Math.PI;

function julian(ms: number) { return ms / 86_400_000 + 2440587.5; }

function solar(ms: number) {
  const jc = (julian(ms) - 2451545) / 36525;
  const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
  const C = Math.sin(M * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
    + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * jc) + Math.sin(3 * M * rad) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * jc;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * rad);
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * rad);
  const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad)) * deg;
  const y = Math.tan((eps / 2) * rad) ** 2;
  const eqTime = 4 * deg * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad)
    + 4 * e * y * Math.sin(M * rad) * Math.cos(2 * L0 * rad) - 0.5 * y * y * Math.sin(4 * L0 * rad)
    - 1.25 * e * e * Math.sin(2 * M * rad));
  return { decl, eqTime };
}

/** Azimut (0 = nord, 90 = est, 180 = sud, 270 = ovest) ed elevazione in gradi. */
export function sunPosition(ms: number, lat: number, lon: number) {
  const { decl, eqTime } = solar(ms);
  const d = new Date(ms);
  const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  let tst = (utcMin + eqTime + 4 * lon) % 1440;
  if (tst < 0) tst += 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const zen = Math.acos(Math.sin(lat * rad) * Math.sin(decl * rad) + Math.cos(lat * rad) * Math.cos(decl * rad) * Math.cos(ha * rad)) * deg;
  const elevation = 90 - zen;
  let az = Math.acos(Math.max(-1, Math.min(1,
    (Math.sin(lat * rad) * Math.cos(zen * rad) - Math.sin(decl * rad)) / (Math.cos(lat * rad) * Math.sin(zen * rad))))) * deg;
  az = ha > 0 ? (az + 180) % 360 : (540 - az) % 360;
  return { azimuth: Math.round(az * 10) / 10, elevation: Math.round(elevation * 10) / 10 };
}

/** Alba, mezzogiorno solare e tramonto del giorno che contiene `ms` (ora locale del server). */
export function sunTimes(ms: number, lat: number, lon: number) {
  const day = new Date(ms); day.setHours(12, 0, 0, 0);
  const noonUtcGuess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12);
  const { decl, eqTime } = solar(noonUtcGuess);
  const noonMin = 720 - 4 * lon - eqTime; // minuti UTC
  const cosH = (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(decl * rad)) / (Math.cos(lat * rad) * Math.cos(decl * rad));
  const base = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const noon = base + noonMin * 60_000;
  if (cosH > 1) return { sunrise: null, sunset: null, noon };   // notte polare
  if (cosH < -1) return { sunrise: null, sunset: null, noon };  // giorno polare
  const H = Math.acos(cosH) * deg;
  return { sunrise: noon - H * 4 * 60_000, sunset: noon + H * 4 * 60_000, noon };
}

/** Il sole batte su una facciata orientata `facing` gradi? Differenza angolare e incidenza. */
export function onFacade(azimuth: number, elevation: number, facing: number, halfWidth: number, minElevation: number) {
  let diff = Math.abs(azimuth - facing) % 360;
  if (diff > 180) diff = 360 - diff;
  return { hit: elevation >= minElevation && diff <= halfWidth, diff: Math.round(diff) };
}

export const DIRECTIONS = [
  { label: 'Nord', deg: 0 }, { label: 'Nord-est', deg: 45 }, { label: 'Est', deg: 90 }, { label: 'Sud-est', deg: 135 },
  { label: 'Sud', deg: 180 }, { label: 'Sud-ovest', deg: 225 }, { label: 'Ovest', deg: 270 }, { label: 'Nord-ovest', deg: 315 },
];
