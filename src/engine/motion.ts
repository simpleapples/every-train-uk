// How hard trains of a kind speed up and brake, for drawing a run between
// reports as speeding up, running and braking (public/motion.js) rather
// than at one speed throughout.
//
// Typical service rates, not the most a train can do: an average over
// pulling away (rates fall as speed rises) and normal braking. They only
// shape a run whose time is given; a run too short for them gets harder ones.

import { describeService } from '../schedule/service.ts';
import type { ScheduleInfo } from '../schedule/timetable.ts';

/** How a train runs a section. */
export interface Motion {
  /** Standing at the start of the section (pulling away), not running through. */
  startsStopped: boolean;
  /** Stopping at the end of the section, not running through. */
  endsStopped: boolean;
  /** m/s². */
  accel: number;
  /** m/s². */
  brake: number;
}

export type Rates = Pick<Motion, 'accel' | 'brake'>;

const RATES = {
  freight: { accel: 0.15, brake: 0.3 },
  lightEngine: { accel: 0.4, brake: 0.5 },
  highSpeed: { accel: 0.45, brake: 0.6 },
  hauled: { accel: 0.35, brake: 0.5 },
  electricUnit: { accel: 0.8, brake: 0.75 },
  dieselUnit: { accel: 0.5, brake: 0.7 },
  unknown: { accel: 0.5, brake: 0.6 },
  tube: { accel: 1.0, brake: 1.0 },
  dlr: { accel: 0.9, brake: 0.9 },
  overground: { accel: 0.8, brake: 0.8 },
  'elizabeth-line': { accel: 0.8, brake: 0.8 },
} satisfies Record<string, Rates>;

// Headcode class digits for freight trains (4, 6, 7, 8) and light engines (0).
const FREIGHT_CLASSES = new Set(['4', '6', '7', '8']);

/** Rates for a National Rail train, from its headcode and (when known) its schedule. */
export function railRates(headcode: string, schedule: ScheduleInfo | undefined): Rates {
  if (FREIGHT_CLASSES.has(headcode[0])) return RATES.freight;
  if (headcode[0] === '0') return RATES.lightEngine;
  const s = describeService(schedule);
  if (s?.kind === 'high-speed') return RATES.highSpeed;
  if (s?.kind === 'loco') return RATES.hauled;
  if (s?.kind === 'unit') return s.traction === 'electric' ? RATES.electricUnit : RATES.dieselUnit;
  return RATES.unknown;
}

/** Rates for a TfL network's trains. */
export function tflRates(mode: 'tube' | 'dlr' | 'overground' | 'elizabeth-line'): Rates {
  return RATES[mode];
}
