import { describe, expect, it } from 'vitest';
import { PredictionErrors } from '../src/engine/predictionErrors.ts';

const T0 = Date.UTC(2026, 10, 28, 12, 0, 0);
const MIN = 60_000;

describe('PredictionErrors', () => {
  it('gives the spread of how far off runs were, in minutes and on the ground', () => {
    const p = new PredictionErrors();
    // 6 km in 6 minutes (1 km a minute), off by 0 to 4 minutes; a 10 km run a minute late.
    for (const off of [0, 1, 2, 3, 4]) p.add({ at: T0, ranMs: 6 * MIN, lengthM: 6000, offMs: { shown: off * MIN } });
    p.add({ at: T0, ranMs: 10 * MIN, lengthM: 10_000, offMs: { shown: -MIN } });
    const s = p.summary(T0);
    expect(s.runs).toBe(6);
    expect(s.shown?.minutesOff).toEqual({ p50: 1, p75: 2, p90: 3 });
    expect(s.shown?.kmOff).toEqual({ p50: 1, p75: 2, p90: 3 });
    expect(s.shown?.longKmOff).toEqual({ p50: 1, p75: 1, p90: 1 });
  });

  it('never puts a train further off than the run is long', () => {
    const p = new PredictionErrors();
    p.add({ at: T0, ranMs: 2 * MIN, lengthM: 3000, offMs: { shown: 10 * MIN } });
    expect(p.summary(T0).shown?.kmOff?.p50).toBe(3);
  });

  it('keeps the last hour', () => {
    const p = new PredictionErrors();
    p.add({ at: T0, ranMs: MIN, offMs: { shown: 0 } });
    p.elsewhere(T0);
    p.add({ at: T0 + 30 * MIN, ranMs: MIN, offMs: { shown: 0 } });
    expect(p.summary(T0 + 61 * MIN)).toMatchObject({ runs: 1, elsewhere: 0 });
  });

  it('compares the timings only over runs that had all of them', () => {
    const p = new PredictionErrors();
    p.add({ at: T0, ranMs: 5 * MIN, offMs: { shown: 2 * MIN, timetable: 2 * MIN } });
    p.add({ at: T0, ranMs: 5 * MIN, offMs: { shown: MIN, timetable: 2 * MIN, learned: 0 } });
    const s = p.summary(T0);
    expect(s.compared?.runs).toBe(1);
    expect(s.compared?.timetable?.minutesOff.p50).toBe(2);
    expect(s.compared?.learned?.minutesOff.p50).toBe(0);
    // No track length: no distances.
    expect(s.compared?.shown).not.toHaveProperty('kmOff');
  });
});
