import { describe, expect, it } from 'vitest';
import { type Leg, RunTimes } from '../src/engine/runTimes.ts';

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
const DAY = 24 * 60 * 60_000;
const leg: Leg = { from: '87701', to: '86021', profile: 't:EMU/800', startsStopped: true, endsStopped: false };

describe('RunTimes', () => {
  it('times a section by the median of recent runs, once there are enough', () => {
    const r = new RunTimes();
    for (const s of [600, 610, 620, 630]) r.add(leg, s * 1000, T0);
    expect(r.estimate(leg)).toBeUndefined();
    // One train held outside hardly moves it.
    r.add(leg, 2400_000, T0);
    expect(r.estimate(leg)).toEqual({ ms: 620_000, runs: 5, lowMs: 610_000, highMs: 630_000 });
  });

  it('keeps sections apart by direction, kind of train, and whether it stops at either end', () => {
    const r = new RunTimes();
    for (let i = 0; i < 5; i++) r.add(leg, 600_000, T0);
    expect(r.estimate({ ...leg, from: leg.to, to: leg.from })).toBeUndefined();
    expect(r.estimate({ ...leg, profile: 't:DMU/158' })).toBeUndefined();
    expect(r.estimate({ ...leg, startsStopped: false })).toBeUndefined();
    expect(r.estimate({ ...leg, endsStopped: true })).toBeUndefined();
    expect(r.stats).toEqual({ sections: 1, runs: 5 });
  });

  it('keeps only the most recent runs', () => {
    const r = new RunTimes();
    for (let i = 0; i < 24; i++) r.add(leg, 900_000, T0);
    for (let i = 0; i < 24; i++) r.add(leg, 600_000, T0);
    expect(r.estimate(leg)?.ms).toBe(600_000);
    expect(r.stats.runs).toBe(24);
  });

  it('turns down runs that cannot be real', () => {
    const r = new RunTimes();
    expect(r.add(leg, -1000, T0)).toBe(false);
    expect(r.add(leg, 4 * 60 * 60_000, T0)).toBe(false);
    expect(r.add({ ...leg, to: leg.from }, 60_000, T0)).toBe(false);
    expect(r.add({ ...leg, to: '' }, 60_000, T0)).toBe(false);
    expect(r.stats.sections).toBe(0);
  });

  it('saves and restores, forgetting sections no train has run for months', () => {
    const r = new RunTimes();
    for (let i = 0; i < 5; i++) r.add(leg, 600_000, T0);
    const old = { ...leg, to: '70011' };
    r.add(old, 600_000, T0 - 100 * DAY);
    expect(r.dirty).toBe(true);
    const state = JSON.parse(JSON.stringify(r.exportState(T0)));
    expect(r.dirty).toBe(false);
    const back = new RunTimes();
    expect(back.importState(state)).toBe(1);
    expect(back.estimate(leg)?.ms).toBe(600_000);
    expect(back.importState({ version: 2 } as never)).toBe(0);
  });
});
