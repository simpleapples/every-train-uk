// Finding a train the way passengers know it: by a station it calls at and
// the time it is due there ("Paddington 08:00", "0800 bristol"). Only trains
// on the map, from their timetabled stops.

import type { PlannedStop } from '../feeds/feed.ts';
import type { TrainView } from './trainStore.ts';

export interface StationMatch {
  id: string;
  station: string;
  /** Timetabled time there: departure, or arrival where it ends. TfL trains: their predicted arrival. */
  at: number;
  kind: 'dep' | 'arr';
  /** When it is expected there, lateness allowed for. */
  expected: number;
  /** gone: it has called there already; here: standing there now; due: still to come. */
  state: 'gone' | 'here' | 'due';
}

/** A stop as search sees it: the timetable's, plus how far the train has got. */
export interface SearchStop extends PlannedStop {
  /** True or false when the train's position is known; unset when it is not. */
  passed?: boolean;
  here?: boolean;
  /** A predicted time there (TfL), used instead of timetable plus lateness. */
  expected?: number;
}

/** How far from the asked time a train still counts as that train. */
const NEAR_MINUTES = 20;
// Generous: the page drops networks that are switched off, then shows up to 3 stations of 8.
const MAX_RESULTS = 40;
const MAX_GONE = 6;
/** How long a train that has gone stays on a station's board. */
const GONE_FOR_MS = 20 * 60_000;
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

export function searchByStation(query: string, trains: { view: TrainView; stops: SearchStop[] }[], now: number): StationMatch[] {
  const q = parseStationQuery(query);
  // A station is needed: "08:00" alone would be half the trains in the country.
  if (q.words.join('').length < 3) return [];
  const named = (name: string) => {
    const w = words(name);
    return q.words.every((qw) => w.some((sw) => sw.startsWith(qw)));
  };
  const matches: (StationMatch & { score: number })[] = [];
  for (const { view, stops } of trains) {
    let best: (StationMatch & { score: number }) | undefined;
    stops.forEach((s, i) => {
      if (!s.call || !named(s.name ?? '')) return;
      const last = i === stops.length - 1;
      const at = (last ? s.arr ?? s.dep : s.dep ?? s.arr);
      if (at === undefined) return;
      const expected = s.expected ?? at + Math.max(0, view.delayMin ?? 0) * 60_000;
      // Where the train has got to is known: trust it (a train held at a
      // signal is still due, however late). Not known: well past its time
      // counts as gone.
      const gone = s.passed ?? expected < now - 5 * 60_000;
      const state = s.here ? 'here' : gone ? 'gone' : 'due';
      let score: number;
      if (q.minute !== undefined) {
        // Nearest the time asked.
        const d = Math.abs(minuteOfDay(at) - q.minute);
        score = Math.min(d, 24 * 60 - d);
        if (score > NEAR_MINUTES) return;
      } else {
        // A departure board: still to come, soonest first; then the ones that
        // have just called there, most recent first.
        score = state === 'gone' ? 1e9 + (now - expected) : expected - now;
      }
      if (!best || score < best.score) best = { id: view.id, station: s.name!, at, kind: last ? 'arr' : 'dep', expected, state, score };
    });
    if (best) matches.push(best);
  }
  matches.sort((a, b) => a.score - b.score || a.at - b.at);
  // Without a time, at most a few that have already gone.
  const gone = q.minute === undefined ? matches.filter((m) => m.state === 'gone' && m.expected > now - GONE_FOR_MS).slice(0, MAX_GONE) : [];
  const shown = q.minute === undefined ? [...matches.filter((m) => m.state !== 'gone').slice(0, MAX_RESULTS - gone.length), ...gone] : matches.slice(0, MAX_RESULTS);
  return shown.map(({ score: _, ...m }) => m);
}
