/** Curve della ventola e regolazione con isteresi, salita rapida e discesa graduale. */

export type FanMode = 'auto' | 'silenziosa' | 'bilanciata' | 'fresca' | 'massima' | 'personalizzata';
export type Point = [number, number]; // [°C, %]

export const MODE_LABEL: Record<FanMode, string> = {
  auto: 'Automatica (firmware)', silenziosa: 'Silenziosa', bilanciata: 'Bilanciata', fresca: 'Fresca', massima: 'Massima', personalizzata: 'Personalizzata',
};
export const MODE_HELP: Record<FanMode, string> = {
  auto: 'Decide il Raspberry, come senza l\'app: parte verso i 50 °C e accelera a gradini fino ai 75 °C.',
  silenziosa: 'Ferma fino a 55 °C, poi lenta: il Pi lavora più caldo ma non si sente.',
  bilanciata: 'Parte a 45 °C e sale in modo graduale. Va bene quasi sempre.',
  fresca: 'Sempre un po\' accesa: CPU e SSD restano più freschi, si sente di più.',
  massima: 'Sempre al massimo.',
  personalizzata: 'La tua curva: temperatura → velocità.',
};

export const CURVES: Record<Exclude<FanMode, 'auto' | 'personalizzata'>, Point[]> = {
  silenziosa: [[55, 0], [56, 25], [65, 40], [72, 70], [78, 100]],
  bilanciata: [[45, 0], [46, 30], [55, 45], [65, 70], [72, 100]],
  fresca: [[35, 30], [50, 50], [60, 80], [66, 100]],
  massima: [[0, 100]],
};

export const SAFETY_TEMP = 80;

export function sanitizeCurve(c: any): Point[] {
  if (!Array.isArray(c)) return CURVES.bilanciata;
  const pts = c.map((p: any) => [Math.round(Number(p?.[0]) * 2) / 2, Math.round(Number(p?.[1]))] as Point)
    .filter(([t, v]) => Number.isFinite(t) && Number.isFinite(v) && t >= 20 && t <= 90 && v >= 0 && v <= 100)
    .sort((a, b) => a[0] - b[0]);
  const uniq: Point[] = [];
  for (const p of pts) if (!uniq.length || uniq.at(-1)![0] !== p[0]) uniq.push(p);
  return uniq.length >= 2 ? uniq.slice(0, 10) : CURVES.bilanciata;
}

/** Velocità per una temperatura: interpolazione lineare fra i punti; sotto il primo punto vale il suo valore. */
export function curveAt(curve: Point[], t: number): number {
  if (!curve.length) return 100;
  if (t <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [t0, v0] = curve[i - 1], [t1, v1] = curve[i];
    if (t <= t1) return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return curve.at(-1)![1];
}

/**
 * Regolatore: sale subito quando la temperatura cresce, scende solo quando la temperatura
 * è calata di almeno `hyst` gradi e poi a passi, per evitare che la ventola cambi in continuazione.
 */
export class Regulator {
  private out = 0;
  private refTemp = -Infinity;
  constructor(public hyst = 3, public minSpin = 20) {}

  next(curve: Point[], temp: number): number {
    let target = curveAt(curve, temp);
    if (temp >= SAFETY_TEMP) target = 100;
    if (target > this.out) { this.out = target; this.refTemp = temp; }
    else if (target < this.out && temp <= this.refTemp - this.hyst) {
      this.out = Math.max(target, this.out - 10); // al massimo -10 punti per ciclo
      this.refTemp = temp + this.hyst;
    }
    // sotto una certa velocità la ventola non parte: o ferma o almeno minSpin
    const v = this.out > 0 && this.out < this.minSpin ? this.minSpin : this.out;
    return Math.round(v);
  }
  reset() { this.out = 0; this.refTemp = -Infinity; }
}
