import { describe, expect, it } from 'vitest';
import { railRates } from '../src/engine/motion.ts';

// @ts-expect-error -- a plain browser script: no types, it sets globalThis.TrainMotion.
await import('../public/motion.js');
interface Plan { d: number; T: number; v: number; a: number; b: number; ta: number; tb: number; ease: number }
interface Motion { startsStopped: boolean; endsStopped: boolean; accel: number; brake: number }
const M = (globalThis as unknown as { TrainMotion: {
  plan(lengthM: number, runS: number, motion: Motion): Plan;
  at(p: Plan, t: number): { s: number; v: number };
  onPlan(p: Plan, t: number): { s: number; v: number };
} }).TrainMotion;

const stopToStop = { startsStopped: true, endsStopped: true, accel: 0.8, brake: 0.8 };

/** Samples a run every 0.5 s: no going backwards, no jumps in position or speed. */
function checkSmooth(p: Plan, until: number, fn = M.at) {
  let prev = fn(p, 0);
  for (let t = 0.5; t <= until; t += 0.5) {
    const here = fn(p, t);
    expect(here.s).toBeGreaterThanOrEqual(prev.s - 1e-9);
    expect(Math.abs(here.v - prev.v)).toBeLessThan(1);
    expect(here.s - prev.s).toBeLessThan(0.5 * Math.max(here.v, prev.v) + 1);
    prev = here;
  }
}

describe('TrainMotion', () => {
  it('pulls away, runs and brakes so a stop-to-stop run takes exactly its time', () => {
    const p = M.plan(5000, 300, stopToStop);
    // T = d/v + k·v with k = 1/(2·0.8) twice.
    expect(5000 / p.v + 1.25 * p.v).toBeCloseTo(300, 6);
    expect(M.onPlan(p, 0)).toEqual({ s: 0, v: 0 });
    expect(M.onPlan(p, 300)).toEqual({ s: 5000, v: 0 });
    expect(M.onPlan(p, 150)).toEqual({ s: 2500, v: p.v });
    // Faster than the average in the middle.
    expect(p.v).toBeGreaterThan(5000 / 300);
    checkSmooth(p, 300, M.onPlan);
  });

  it('runs through at one speed between passing points, and only speeds up or brakes at a stop', () => {
    const through = M.plan(6000, 200, { ...stopToStop, startsStopped: false, endsStopped: false });
    expect(M.onPlan(through, 50)).toEqual({ s: 1500, v: 30 });
    const departing = M.plan(6000, 200, { ...stopToStop, endsStopped: false });
    expect(M.onPlan(departing, 0).v).toBe(0);
    expect(M.onPlan(departing, 200)).toEqual({ s: 6000, v: departing.v });
    checkSmooth(departing, 200, M.onPlan);
  });

  it('speeds up and brakes harder for a run too short for its rates', () => {
    const p = M.plan(5000, 60, stopToStop);
    expect(p.a).toBeGreaterThan(0.8);
    expect(M.onPlan(p, 30).s).toBeCloseTo(2500, 6);
    expect(M.onPlan(p, 60).s).toBeCloseTo(5000, 6);
  });

  it('eases a train whose report is late toward the end, never past it', () => {
    const p = M.plan(5000, 300, stopToStop);
    expect(M.at(p, 300 - p.ease)).toEqual(M.onPlan(p, 300 - p.ease));
    expect(M.at(p, 300).s).toBeLessThan(5000);
    expect(M.at(p, 900).s).toBeLessThan(5000);
    expect(M.at(p, 900).s).toBeGreaterThan(4999);
    checkSmooth(p, 900);
  });

  it('keeps a train running through a passing point moving on while its report is late', () => {
    const p = M.plan(6000, 200, { ...stopToStop, startsStopped: false, endsStopped: false });
    expect(p.ease).toBe(30);
    expect(M.at(p, 200).s).toBeGreaterThan(5500);
    expect(M.at(p, 260).s).toBeLessThan(6000);
    checkSmooth(p, 400);
  });
});

describe('railRates', () => {
  const info = (power: string, timingLoad?: string) => ({ uid: 'C1', date: '2026-11-26', atoc: 'GW', origin: '', destination: '', service: { power, timingLoad } });
  it('by kind of train: freight slowest, electric units quickest', () => {
    expect(railRates('6M45', undefined).accel).toBe(0.15);
    expect(railRates('1A23', info('EMU', '390'))).toEqual({ accel: 0.45, brake: 0.6 });
    expect(railRates('2C11', info('EMU', '387'))).toEqual({ accel: 0.8, brake: 0.75 });
    expect(railRates('2C11', info('DMU', '150'))).toEqual({ accel: 0.5, brake: 0.7 });
    expect(railRates('1S12', undefined)).toEqual({ accel: 0.5, brake: 0.6 });
  });
});
