import type { Store } from './db.js';

/** Statistiche dai movimenti registrati: chi muove le tapparelle, quando, quanto restano chiuse. */
export function statistics(store: Store, shutters: { id: string; name: string; position: number | null }[], days: number, now = Date.now()) {
  const since = now - days * 86_400_000;
  const moves = store.moves(since, now + 1);
  const origins = ['nido', 'utente', 'muro', 'automazione'] as const;
  const zero = () => Object.fromEntries(origins.map(o => [o, 0])) as Record<string, number>;

  const byOrigin = zero();
  const byHour = Array.from({ length: 24 }, () => ({ su: 0, giu: 0 }));
  const perDay = new Map<string, Record<string, number>>();
  const byWho = new Map<string, number>();
  const per = new Map<string, { moves: number; up: number; down: number; byOrigin: Record<string, number>; travel: number }>();
  for (const s of shutters) per.set(s.id, { moves: 0, up: 0, down: 0, byOrigin: zero(), travel: 0 });

  for (const m of moves) {
    byOrigin[m.origin] = (byOrigin[m.origin] ?? 0) + 1;
    const d = new Date(m.ts);
    const up = (m.to ?? 0) > (m.from ?? 0);
    byHour[d.getHours()][up ? 'su' : 'giu']++;
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const day = perDay.get(k) ?? zero(); day[m.origin]++; perDay.set(k, day);
    if (m.origin !== 'nido') byWho.set(m.who ?? m.origin, (byWho.get(m.who ?? m.origin) ?? 0) + 1);
    const p = per.get(m.shutter);
    if (p) { p.moves++; up ? p.up++ : p.down++; p.byOrigin[m.origin]++; p.travel += Math.abs((m.to ?? 0) - (m.from ?? 0)); }
  }

  // ore al giorno chiusa (≤ 10%) e posizione media, ricostruite dalla sequenza dei movimenti
  const timeline = shutters.map(s => {
    const mv = moves.filter(m => m.shutter === s.id);
    let pos = store.positionBefore(s.id, since) ?? mv[0]?.from ?? s.position;
    let t = since, closed = 0, weighted = 0, known = 0;
    const seg = (to: number) => {
      if (pos == null) { t = to; return; }
      const dt = to - t;
      if (pos <= 10) closed += dt;
      weighted += pos * dt; known += dt; t = to;
    };
    for (const m of mv) { seg(m.ts); pos = m.to; }
    seg(now);
    return {
      id: s.id, closedHoursPerDay: known ? Math.round((closed / known) * 24 * 10) / 10 : null,
      avgPosition: known ? Math.round(weighted / known) : null,
    };
  });

  const dayList: { day: string; [k: string]: number | string }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dayList.push({ day: k, ...(perDay.get(k) ?? zero()) });
  }

  return {
    days, total: moves.length, byOrigin, byHour, perDay: dayList,
    byWho: [...byWho].map(([who, n]) => ({ who, n })).sort((a, b) => b.n - a.n),
    shutters: shutters.map(s => ({ name: s.name, ...per.get(s.id)!, ...timeline.find(t => t.id === s.id)!, id: s.id })),
  };
}
