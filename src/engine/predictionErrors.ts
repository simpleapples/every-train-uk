// How far off the map's timing of each run turned out. When a train reports
// at the point it was drawn running to, it was early or late against the time
// the map gave the run; at the run's average speed, that is how far apart the
// drawn train and the real one were when it got there.
//
// Each run is also scored for the other ways the map could have timed it (the
// timetable's running time alone, the median of recent runs alone), so the
// status shows which would have been closer over the same runs.
//
// Report times are whole minutes, so a single run's error is rough by up to a
// minute either way; over many runs the comparison holds.

/** The ways a run is timed: as drawn, and each source on its own. */
export type Timing = 'shown' | 'timetable' | 'learned';

export interface ScoredRun {
  /** When the train reached the point (ms since epoch). */
  at: number;
  /** How long the run really took. */
  ranMs: number;
  /** Track length of the run, when known. */
  lengthM?: number;
  /** Actual arrival minus each timing's, ms: positive is late. */
  offMs: Partial<Record<Timing, number>>;
}

/** Median, 75th and 90th percentile. */
export interface Spread {
  p50: number;
  p75: number;
  p90: number;
}

export interface TimingScore {
  minutesOff: Spread;
  kmOff?: Spread;
  /** Over runs of LONG_RUN_M or more, where most of a train's time goes. */
  longKmOff?: Spread;
}

export interface PredictionSummary {
  windowMin: number;
  /** Runs that ended where the train was drawn running to. */
  runs: number;
  /** Reports from somewhere else than where the train was drawn running to. */
  elsewhere: number;
  shown?: TimingScore;
  /** Over the runs a learned time was known for, each timing on its own. */
  compared?: { runs: number } & Partial<Record<Timing, TimingScore>>;
}

const WINDOW_MS = 60 * 60_000;
// A busy hour is about 16,000 runs.
const MAX_RUNS = 50_000;
// The status is asked for every few seconds; the summary sorts the hour's
// runs, so it is worked out again at most this often.
const SUMMARY_EVERY_MS = 30_000;
export const LONG_RUN_M = 8000;

export class PredictionErrors {
  #runs: ScoredRun[] = [];
  #elsewhere: number[] = [];
  #summary?: { now: number; value: PredictionSummary };

  add(run: ScoredRun): void {
    this.#runs.push(run);
    if (this.#runs.length > MAX_RUNS) this.#runs.splice(0, this.#runs.length - MAX_RUNS);
  }

  /** A report somewhere other than where the train was drawn running to. */
  elsewhere(at: number): void {
    this.#elsewhere.push(at);
    if (this.#elsewhere.length > MAX_RUNS) this.#elsewhere.splice(0, this.#elsewhere.length - MAX_RUNS);
  }

  /** Over the hour before `now` (as of up to SUMMARY_EVERY_MS earlier). */
  summary(now: number): PredictionSummary {
    const last = this.#summary;
    if (last && now >= last.now && now - last.now < SUMMARY_EVERY_MS) return last.value;
    const value = this.#summarise(now);
    this.#summary = { now, value };
    return value;
  }

  #summarise(now: number): PredictionSummary {
    const since = now - WINDOW_MS;
    this.#runs = this.#runs.filter((r) => r.at >= since);
    this.#elsewhere = this.#elsewhere.filter((at) => at >= since);
    const runs = this.#runs;
    const out: PredictionSummary = { windowMin: WINDOW_MS / 60_000, runs: runs.length, elsewhere: this.#elsewhere.length };
    if (runs.length) out.shown = score(runs, 'shown');
    const both = runs.filter((r) => r.offMs.learned !== undefined && r.offMs.timetable !== undefined);
    if (both.length) {
      out.compared = { runs: both.length };
      for (const t of ['shown', 'timetable', 'learned'] as const) out.compared[t] = score(both, t);
    }
    return out;
  }
}

function score(runs: ScoredRun[], timing: Timing): TimingScore {
  const minutes: number[] = [];
  const km: number[] = [];
  const longKm: number[] = [];
  for (const r of runs) {
    const off = r.offMs[timing];
    if (off === undefined) continue;
    minutes.push(Math.abs(off) / 60_000);
    if (!(r.lengthM && r.lengthM > 0 && r.ranMs > 0)) continue;
    // Off by that long at the run's average speed, and never more than the run.
    const m = Math.min(r.lengthM, (r.lengthM / r.ranMs) * Math.abs(off));
    km.push(m / 1000);
    if (r.lengthM >= LONG_RUN_M) longKm.push(m / 1000);
  }
  return {
    minutesOff: spread(minutes),
    ...(km.length && { kmOff: spread(km) }),
    ...(longKm.length && { longKmOff: spread(longKm) }),
  };
}

function spread(xs: number[]): Spread {
  // A typed array sorts by value, without a compare function.
  const s = Float64Array.from(xs).sort();
  const at = (p: number) => (s.length ? Math.round(s[Math.floor((s.length - 1) * p)] * 100) / 100 : 0);
  return { p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}
