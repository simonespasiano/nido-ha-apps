import type { Session } from './db.js';
import type { RobotMap } from './protocol.js';

const DAY = 86400_000;
const dayKey = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function statistics(all: Session[], days: number, map: RobotMap | null, lastCleaned: Record<number, number>, now = Date.now()) {
  const from = now - days * DAY;
  const cur = all.filter(s => s.start >= from && s.end);
  const prev = all.filter(s => s.start >= from - days * DAY && s.start < from && s.end);
  const sum = (ss: Session[]) => ({
    sessions: ss.length,
    area: Math.round(ss.reduce((a, s) => a + (s.area ?? 0), 0) * 10) / 10,
    minutes: Math.round(ss.reduce((a, s) => a + (s.duration ?? 0), 0) / 60),
    battery: (() => { const b = ss.filter(s => s.batteryStart != null && s.batteryEnd != null && s.batteryStart > s.batteryEnd); return b.length ? Math.round(b.reduce((a, s) => a + (s.batteryStart! - s.batteryEnd!), 0) / b.length) : null; })(),
  });
  const totals = sum(cur), before = sum(prev);
  const speed = totals.minutes ? Math.round((totals.area / totals.minutes) * 100) / 100 : null;

  // per giorno
  const byDay: { day: string; area: number; minutes: number; sessions: number }[] = [];
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const idx = new Map<string, number>();
  for (let t = start.getTime(); t <= now; t += DAY) { idx.set(dayKey(t), byDay.length); byDay.push({ day: dayKey(t), area: 0, minutes: 0, sessions: 0 }); }
  for (const s of cur) { const i = idx.get(dayKey(s.start)); if (i == null) continue; byDay[i].area += s.area ?? 0; byDay[i].minutes += (s.duration ?? 0) / 60; byDay[i].sessions++; }
  byDay.forEach(d => { d.area = Math.round(d.area * 10) / 10; d.minutes = Math.round(d.minutes); });

  // per ora del giorno
  const byHour = new Array(24).fill(0);
  for (const s of cur) byHour[new Date(s.start).getHours()]++;

  // per stanza
  const rooms = (map?.rooms ?? []).map(r => {
    const ss = cur.filter(s => (s.visited.length ? s.visited : s.rooms).includes(r.id));
    const last = lastCleaned[r.id] ?? null;
    return { id: r.id, name: r.name, area: r.area ?? null, count: ss.length, last, daysSince: last ? Math.floor((now - last) / DAY) : null, perWeek: Math.round((ss.length / Math.max(1, days)) * 7 * 10) / 10 };
  });

  // da chi sono partite
  const bySource: Record<string, number> = {};
  for (const s of cur) { const k = s.source.startsWith('Programma') ? s.source : s.source; bySource[k] = (bySource[k] ?? 0) + 1; }

  const results: Record<string, number> = {};
  for (const s of cur) { const k = (s.result ?? 'sconosciuto').replace(/ \(.*\)$/, ''); results[k] = (results[k] ?? 0) + 1; }

  // previsione semplice: con il ritmo attuale, quando verrà ripulita ogni stanza
  const gaps: number[] = [];
  const sorted = [...cur].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].start - sorted[i - 1].start);
  const avgGapH = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 3600_000) : null;

  return { days, totals, before, speed, byDay, byHour, rooms, bySource, results, avgGapH };
}
