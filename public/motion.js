// How a train moves along one section between reports: speeding up from a
// stop, running at a steady speed, braking for the next stop, instead of
// gliding at one speed from end to end.
//
// The server says how long the run should take, whether the train starts
// and ends the section standing, and how hard trains of its kind speed up
// and brake. From that, the steady speed is the one that makes the run take
// exactly its time: with t_a = v/a spent speeding up and t_b = v/b braking,
//
//   T = d/v + k·v,  k = [starts standing]/(2a) + [ends standing]/(2b)
//
// so v = (T − √(T² − 4kd)) / 2k. A run too short for those rates gets
// harder ones, just enough to make it.
//
// A train that has not reported reaching the end yet is not shown waiting
// there: over the last moments of its run it eases off, creeping on toward
// the end until the next report says where it is.
//
// A plain script (no imports or exports), so the page loads it as is and
// tests import it; either way it defines globalThis.TrainMotion.

globalThis.TrainMotion = (() => {
  // How long before the end of its time a train starts easing off, at most (s).
  const EASE_STOPPING_S = 60;
  const EASE_PASSING_S = 30;
  // And at most this share of the run.
  const EASE_SHARE = 0.25;

  /**
   * A run of `lengthM` metres taking `runS` seconds.
   * motion: { startsStopped, endsStopped, accel, brake } (m/s²).
   */
  function plan(lengthM, runS, motion) {
    const d = Math.max(0, lengthM);
    const T = Math.max(1e-3, runS);
    let a = motion.accel > 0 ? motion.accel : 0.5;
    let b = motion.brake > 0 ? motion.brake : 0.6;
    const k0 = (motion.startsStopped ? 1 / (2 * a) : 0) + (motion.endsStopped ? 1 / (2 * b) : 0);
    let k = k0;
    let v;
    if (k === 0 || d === 0) {
      v = d / T;
    } else {
      // Too short for these rates: brake and speed up harder, just enough.
      if (T * T < 4 * k * d) {
        k = (T * T) / (4 * d);
        a *= k0 / k;
        b *= k0 / k;
      }
      v = (T - Math.sqrt(Math.max(0, T * T - 4 * k * d))) / (2 * k);
    }
    const ta = motion.startsStopped && a ? v / a : 0;
    const tb = motion.endsStopped && b ? v / b : 0;
    const ease = Math.min(motion.endsStopped ? EASE_STOPPING_S : EASE_PASSING_S, EASE_SHARE * T);
    return { d, T, v, a, b, ta, tb, ease };
  }

  /** Distance covered (m) and speed (m/s) `t` seconds into a planned run, as planned. */
  function onPlan(p, t) {
    if (t <= 0) return { s: 0, v: p.ta ? 0 : p.v };
    if (t >= p.T) return { s: p.d, v: p.tb ? 0 : p.v };
    if (t < p.ta) return { s: 0.5 * p.a * t * t, v: p.a * t };
    const left = p.T - t;
    if (left < p.tb) return { s: p.d - 0.5 * p.b * left * left, v: p.b * left };
    const sa = p.ta ? 0.5 * p.a * p.ta * p.ta : 0;
    return { s: sa + p.v * (t - p.ta), v: p.v };
  }

  /**
   * Where the train is `t` seconds after it left: as planned, except that
   * over the last `ease` seconds the clock slows (smoothly, at the same rate
   * at first), so it closes on the end without reaching it.
   */
  function at(p, t) {
    const from = p.T - p.ease;
    if (!(p.ease > 0) || t <= from) return onPlan(p, t);
    const rate = Math.exp(-(t - from) / p.ease);
    const here = onPlan(p, p.T - p.ease * rate);
    return { s: here.s, v: here.v * rate };
  }

  return { plan, at, onPlan };
})();
