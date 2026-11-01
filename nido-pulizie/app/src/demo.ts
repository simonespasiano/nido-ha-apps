import type { Store } from './db.js';

/** Storico finto di 5 settimane per vedere statistiche e grafici nella demo. */
export function seedDemoHistory(store: Store) {
  if (store.counts().sessions > 0) return;
  const names: Record<string, string> = { 1: 'Soggiorno', 2: 'Cucina', 3: 'Corridoio', 4: 'Camera da letto', 5: 'Cameretta', 6: 'Bagno', 7: 'Cabina armadio' };
  const area: Record<number, number> = { 1: 9.3, 2: 4.7, 3: 2.5, 4: 7.1, 5: 4.5, 6: 3.1, 7: 3.2 };
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const now = Date.now();
  for (let d = 35; d >= 1; d--) {
    const day = new Date(now - d * 86400_000);
    const dow = day.getDay();
    const plans: { h: number; rooms: number[]; source: string; mode: number }[] = [];
    if (dow >= 1 && dow <= 5) plans.push({ h: 9 + Math.floor(rnd() * 3), rooms: [1, 2, 3], source: 'Programma «Quando esco»', mode: 4 });
    if (dow === 6) plans.push({ h: 10, rooms: [1, 2, 3, 4, 5, 6, 7], source: 'Programma «Sabato tutta casa»', mode: 3 });
    if (rnd() < 0.3) plans.push({ h: 20, rooms: [2], source: 'NIDO', mode: 4 });
    if (rnd() < 0.15) plans.push({ h: 14, rooms: [], source: 'App Narwal o pulsante del robot', mode: 1 });
    for (const p of plans) {
      day.setHours(p.h, Math.floor(rnd() * 50), 0, 0);
      const start = day.getTime();
      const rooms = p.rooms.length ? p.rooms : [1, 2, 3, 4];
      const skipped = p.source.includes('esco') && rnd() < 0.2 ? [rooms.at(-1)!] : [];
      const visited = rooms.filter(r => !skipped.includes(r));
      const a = Math.round(visited.reduce((s, r) => s + area[r] * (0.85 + rnd() * 0.12), 0) * 10) / 10;
      const dur = Math.round(a * (p.mode === 3 ? 130 : 95) + rnd() * 120);
      const bat = 100 - Math.round(dur / 60 * 0.9);
      const id = store.openSession({ start, source: p.source, rooms: p.rooms, roomNames: names, mode: p.mode, batteryStart: 100, mapId: 1730000000 });
      store.updateSession(id, { end: start + dur * 1000 + 180_000, duration: dur, area: a, batteryEnd: bat, visited, result: skipped.length ? `Completata in parte (mancano ${names[skipped[0]]})` : 'Completata' });
      store.addEvent('pulizia', `Pulizia finita · Completata · ${a.toLocaleString('it-IT')} m² · ${Math.round(dur / 60)} min`, null, start + dur * 1000);
    }
  }
}
