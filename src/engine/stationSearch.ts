// Finding a train the way passengers know it: by a station it calls at and
// the time it is due there ("Paddington 08:00", "0800 bristol"). Only trains
// on the map, from their timetabled stops.

import type { PlannedStop } from '../feeds/feed.ts';
import type { TrainView } from './trainStore.ts';

export interface StationMatch {
  id: string;
  station: string;
  /** Planned time there: departure, or arrival where it ends. */
  at: number;
  kind: 'dep' | 'arr';
}

/** How far from the asked time a train still counts as that train. */
const NEAR_MINUTES = 20;
const MAX_RESULTS = 10;
const londonClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const words = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/['’.]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const minuteOfDay = (ms: number) => {
  const [h, m] = londonClock.format(ms).split(':').map(Number);
  return h * 60 + m;
};

/** A time of day in the query ("8:05", "08.05", "0805"), in minutes, and the words around it. */
export function parseStationQuery(query: string): { words: string[]; minute?: number } {
  let minute: number | undefined;
  // A headcode such as "1A94" has a letter in it, so is not taken for a time.
  const rest = query.replace(/\b([01]?\d|2[0-3])[:.]?([0-5]\d)\b/, (_, h: string, mm: string) => {
    minute = Number(h) * 60 + Number(mm);
    return ' ';
  });
  return { words: words(rest), minute };
}

export function searchByStation(query: string, trains: { view: TrainView; stops: PlannedStop[] }[], now: number): StationMatch[] {
  const q = parseStationQuery(query);
  // A station is needed: "08:00" alone would be half the trains in the country.
  if (q.words.join('').length < 3) return [];
  const named = (name: string) => {
    const w = words(name);
    return q.words.every((qw) => w.some((sw) => sw.startsWith(qw)));
  };
  const nowMinute = minuteOfDay(now);
  const matches: (StationMatch & { score: number })[] = [];
  for (const { view, stops } of trains) {
    let best: (StationMatch & { score: number }) | undefined;
    stops.forEach((s, i) => {
      if (!s.call || !named(s.name ?? '')) return;
      const last = i === stops.length - 1;
      const at = (last ? s.arr ?? s.dep : s.dep ?? s.arr);
      if (at === undefined) return;
      const minute = minuteOfDay(at);
      let score: number;
      if (q.minute !== undefined) {
        const d = Math.abs(minute - q.minute);
        score = Math.min(d, 24 * 60 - d);
        if (score > NEAR_MINUTES) return;
      } else {
        // Soonest first; ones already gone after those still to come.
        const ahead = (minute - nowMinute + 24 * 60) % (24 * 60);
        score = at >= now - 5 * 60_000 ? ahead : 24 * 60 + (now - at) / 60_000;
      }
      if (!best || score < best.score) best = { id: view.id, station: s.name!, at, kind: last ? 'arr' : 'dep', score };
    });
    if (best) matches.push(best);
  }
  return matches.sort((a, b) => a.score - b.score || a.at - b.at).slice(0, MAX_RESULTS).map(({ score: _, ...m }) => m);
}
