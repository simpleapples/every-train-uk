// How long trains actually take between consecutive TRUST reporting points,
// kept per section and kind of train.
//
// TRUST's next_report_run_time is the plan: whole minutes, and with the
// timetable's allowances in it. These are the times trains really ran, from
// their reports, so the map can come to time a section from what trains of
// that kind usually take over it. Only the most recent runs are kept, and a
// section's time is their median, so one held or rerouted train hardly moves it.
//
// Report times have rounding in them (often to the minute), so a single run
// is rough; the median over many is not.

/** One section run: between two consecutive reporting points, by one kind of train. */
export interface Leg {
  from: string;
  to: string;
  /** What kind of train: trains of a kind are timed alike (see trainStore's profileOf). */
  profile: string;
  /** Standing at `from` (a stop) rather than running through it. */
  startsStopped: boolean;
  /** Stopping at `to` rather than running through it. */
  endsStopped: boolean;
}

export interface RunTimeEstimate {
  /** Median of the recent runs. */
  ms: number;
  /** How many runs that is from. */
  runs: number;
  /** Middle half of the runs (25th to 75th percentile). */
  lowMs: number;
  highMs: number;
}

export interface RunTimesState {
  version: 1;
  savedAt: number;
  /** Section key -> [last run at (ms since epoch), then run times in seconds, oldest first]. */
  sections: Record<string, number[]>;
}

// Recent runs kept per section; older ones fall off, so changes to the
// timetable or the line show through within a few weeks.
const MAX_RUNS = 24;
// Fewer runs than this is too few to time a section by.
const MIN_RUNS = 5;
// Longer than this between two reporting points is a train held or terminated
// and restarted, not a run.
const MAX_RUN_MS = 3 * 60 * 60_000;
// Sections no train has run for this long are forgotten (closed lines, diversions).
const FORGET_AFTER_MS = 90 * 24 * 60 * 60_000;

export class RunTimes {
  #sections = new Map<string, { lastAt: number; runs: number[] }>();
  #dirty = false;

  /** Records one run; false if it cannot be a real one. */
  add(leg: Leg, ms: number, at: number): boolean {
    if (!leg.from || !leg.to || leg.from === leg.to || !Number.isFinite(ms) || ms < 0 || ms > MAX_RUN_MS) return false;
    const key = keyOf(leg);
    let section = this.#sections.get(key);
    if (!section) {
      section = { lastAt: at, runs: [] };
      this.#sections.set(key, section);
    }
    section.lastAt = Math.max(section.lastAt, at);
    section.runs.push(Math.round(ms / 1000));
    if (section.runs.length > MAX_RUNS) section.runs.shift();
    this.#dirty = true;
    return true;
  }

  /** What trains of this kind have taken over this section lately, once enough have run it. */
  estimate(leg: Leg): RunTimeEstimate | undefined {
    const runs = this.#sections.get(keyOf(leg))?.runs;
    if (!runs || runs.length < MIN_RUNS) return undefined;
    const sorted = [...runs].sort((a, b) => a - b);
    return {
      ms: quantile(sorted, 0.5) * 1000,
      runs: sorted.length,
      lowMs: quantile(sorted, 0.25) * 1000,
      highMs: quantile(sorted, 0.75) * 1000,
    };
  }

  get stats(): { sections: number; runs: number } {
    let runs = 0;
    for (const s of this.#sections.values()) runs += s.runs.length;
    return { sections: this.#sections.size, runs };
  }

  /** Whether anything was recorded since the last export. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** Everything recorded, for saving; sections not run for months are dropped first. */
  exportState(now: number): RunTimesState {
    const sections: Record<string, number[]> = {};
    for (const [key, s] of this.#sections) {
      if (now - s.lastAt > FORGET_AFTER_MS) this.#sections.delete(key);
      else sections[key] = [s.lastAt, ...s.runs];
    }
    this.#dirty = false;
    return { version: 1, savedAt: now, sections };
  }

  /** Brings back what exportState saved. Returns how many sections. */
  importState(state: RunTimesState): number {
    if (state?.version !== 1 || !state.sections || typeof state.sections !== 'object') return 0;
    let n = 0;
    for (const [key, value] of Object.entries(state.sections)) {
      if (!Array.isArray(value) || value.length < 2 || !value.every(Number.isFinite)) continue;
      const [lastAt, ...runs] = value;
      this.#sections.set(key, { lastAt, runs: runs.slice(-MAX_RUNS) });
      n++;
    }
    return n;
  }
}

function keyOf(leg: Leg): string {
  return `${leg.from}>${leg.to}|${leg.startsStopped ? 's' : 'p'}${leg.endsStopped ? 's' : 'p'}|${leg.profile}`;
}

/** Linear-interpolated quantile of sorted values. */
function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
