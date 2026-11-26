import { describe, expect, it } from 'vitest';
import { LocationIndex } from '../src/engine/locations.ts';
import { RunTimes } from '../src/engine/runTimes.ts';
import { TrainStore, trustTime } from '../src/engine/trainStore.ts';
import type { TrustMessage } from '../src/trust/types.ts';

const stations = {
  KNGX: { name: 'London Kings Cross', lat: 51.53, lon: -0.12 },
  STEVNGE: { name: 'Stevenage', lat: 51.9, lon: -0.21 },
  PBRO: { name: 'Peterborough', lat: 52.57, lon: -0.25 },
};
// STANOX -> TIPLOC, plus a junction with no coordinates.
const index = LocationIndex.byStanox(stations, {
  '87701': { tiplocs: ['KNGX'] },
  '86021': { tiplocs: ['STEVNGE'] },
  '70011': { tiplocs: ['PBRO'] },
  '86099': { tiplocs: ['WYMONDJ'], name: 'Wymondley Junction' },
});

const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

function movement(body: Record<string, string | null>): TrustMessage {
  return {
    header: { msg_type: '0003' },
    body: {
      train_id: '871S12MO31',
      toc_id: '61',
      event_type: 'DEPARTURE',
      planned_event_type: 'DEPARTURE',
      actual_timestamp: String(T0),
      loc_stanox: '87701',
      next_report_stanox: '86021',
      next_report_run_time: '20',
      timetable_variation: '0',
      variation_status: 'ON TIME',
      train_terminated: 'false',
      ...body,
    },
  };
}

describe('TrainStore', () => {
  it('puts a departing train on the segment to its next timing point', () => {
    const store = new TrainStore(index, (toc) => (toc === '61' ? 'LNER' : undefined));
    store.apply(movement({}), T0 + 2000);
    const [t] = store.snapshot();
    expect(t).toMatchObject({
      id: '871S12MO31',
      headcode: '1S12',
      operator: 'LNER',
      state: 'moving',
      departedAt: T0,
      runMs: 20 * 60_000,
      delayMin: 0,
      freight: false,
    });
    expect(t.from.name).toBe('London Kings Cross');
    expect(t.to?.name).toBe('Stevenage');
  });

  describe('with a timetable', () => {
    const info = { uid: 'C10001', date: '2026-10-31', atoc: 'GN', origin: 'London Kings Cross', destination: 'Peterborough' };
    const timetable = {
      byUid: (uid: string, date: string) => (uid === 'C10001' && date === '2026-10-31' ? info : undefined),
      match: (headcode: string, key: string, planned: number) => (headcode === '1S12' && key === '87701' && planned === T0 ? info : undefined),
    };
    // Operator names come from the schedule's code when it has one.
    const names = (toc: string, atoc?: string) => (atoc === 'GN' ? 'Great Northern' : toc === '88' ? 'Govia Thameslink Railway' : undefined);
    const activation = (uid: string): TrustMessage => ({
      header: { msg_type: '0001' },
      body: { train_id: '871S12MO31', toc_id: '88', train_uid: uid, tp_origin_timestamp: '2026-10-31' },
    });

    it('takes origin, destination and operator from the schedule the activation names', () => {
      const store = new TrainStore(index, names);
      store.setTimetable(timetable);
      store.apply(activation('C10001'), T0 - 60_000);
      store.apply(movement({ toc_id: '88' }), T0);
      expect(store.snapshot()[0]).toMatchObject({ operator: 'Great Northern', origin: 'London Kings Cross', destination: 'Peterborough' });
      expect(store.scheduleOf('871S12MO31')).toEqual(info);
    });

    it('finds the schedule of a train already running when we started listening', () => {
      const store = new TrainStore(index, names);
      store.setTimetable(timetable);
      store.apply(movement({ toc_id: '88', planned_timestamp: String(T0) }), T0 + 2000);
      expect(store.snapshot()[0]).toMatchObject({ operator: 'Great Northern', destination: 'Peterborough' });
    });

    it('keeps a train running through a station it passes, despite the arrival report', () => {
      const plan = (stevenage: { arr?: number; dep: number; call: boolean }) => ({
        ...timetable,
        plannedStops: () => [
          { key: '87701', call: true, dep: T0 },
          { key: '86021', ...stevenage },
          { key: '70011', call: true, arr: T0 + 45 * 60_000 },
        ],
      });
      const arrive = movement({ toc_id: '88', event_type: 'ARRIVAL', loc_stanox: '86021', planned_timestamp: String(T0 + 20 * 60_000), next_report_stanox: '70011', next_report_run_time: '25' });

      const passing = new TrainStore(index, names);
      passing.setTimetable(plan({ dep: T0 + 20 * 60_000, call: false }));
      passing.apply(activation('C10001'), T0 - 60_000);
      passing.apply(movement({ toc_id: '88' }), T0);
      passing.apply(arrive, T0 + 20 * 60_000);
      // Running through, so it does not pull away from a stand either.
      expect(passing.snapshot()[0]).toMatchObject({ state: 'moving', to: { key: '70011' }, motion: { startsStopped: false, endsStopped: true } });

      const stopping = new TrainStore(index, names);
      stopping.setTimetable(plan({ arr: T0 + 19 * 60_000, dep: T0 + 21 * 60_000, call: true }));
      stopping.apply(activation('C10001'), T0 - 60_000);
      stopping.apply(movement({ toc_id: '88' }), T0);
      stopping.apply(arrive, T0 + 20 * 60_000);
      expect(stopping.snapshot()[0].state).toBe('stopped');
    });

    it('describes restored trains from a newly loaded timetable', () => {
      const before = new TrainStore(index, names);
      before.setTimetable({ ...timetable, byUid: () => ({ ...info, destination: 'Old Name' }) });
      before.apply(activation('C10001'), T0 - 60_000);
      before.apply(movement({ toc_id: '88' }), T0);
      const after = new TrainStore(index, names);
      after.importState(JSON.parse(JSON.stringify(before.exportState(T0))), T0);
      after.drainChanges();
      after.setTimetable(timetable);
      expect(after.scheduleOf('871S12MO31')?.destination).toBe('Peterborough');
      expect(after.drainChanges().upserts).toMatchObject([{ destination: 'Peterborough' }]);
    });

    it('falls back to the TRUST operator code without a schedule', () => {
      const store = new TrainStore(index, names);
      store.setTimetable(timetable);
      store.apply(activation('X99999'), T0 - 60_000);
      store.apply(movement({ toc_id: '88', planned_timestamp: String(T0 - 3_600_000) }), T0);
      expect(store.snapshot()[0]).toMatchObject({ operator: 'Govia Thameslink Railway' });
      expect(store.snapshot()[0].destination).toBeUndefined();
    });
  });

  it('carries trains over a restart, but not ones that have gone quiet', () => {
    const before = new TrainStore(index);
    before.apply(movement({}), T0);
    before.apply(movement({ train_id: '872D10MO31' }), T0 - 40 * 60_000);
    const saved = JSON.parse(JSON.stringify(before.exportState(T0)));

    const after = new TrainStore(index);
    expect(after.importState(saved, T0 + 60_000)).toBe(1);
    expect(after.snapshot().map((t) => t.id)).toEqual(['871S12MO31']);
    // Browsers get the restored trains in the next push.
    expect(after.drainChanges().upserts).toHaveLength(1);
    // A later report carries on from the restored history.
    after.apply(movement({ event_type: 'ARRIVAL', loc_stanox: '86021' }), T0 + 20 * 60_000);
    expect(after.train('871S12MO31')!.history.map((h) => h.key)).toEqual(['87701', '86021']);
  });

  it('skips operators another source already shows (TfL services on Network Rail track)', () => {
    const store = new TrainStore(index, undefined, null, new Set(['30']));
    store.apply(movement({ toc_id: '30', train_id: '872L07MO31' }), T0);
    store.apply(movement({}), T0);
    expect(store.snapshot().map((t) => t.id)).toEqual(['871S12MO31']);
  });

  it('places reports at junctions too, and takes an arrival there for a pass', () => {
    const withJunction = LocationIndex.byStanox(stations, {
      '87701': { tiplocs: ['KNGX'] },
      '86021': { tiplocs: ['STEVNGE'] },
      '86099': { tiplocs: ['WYMONDJ'], name: 'WYMONDLEY JN' },
    }, { points: { WYMONDJ: [-0.23, 51.93] }, names: {} });
    const store = new TrainStore(withJunction);
    store.apply(movement({ next_report_stanox: '86099', next_report_run_time: '25' }), T0);
    store.apply(movement({ event_type: 'ARRIVAL', planned_event_type: 'ARRIVAL', loc_stanox: '86099', next_report_stanox: '86021', next_report_run_time: '3' }), T0 + 25 * 60_000);
    const [t] = store.snapshot();
    expect(t).toMatchObject({ state: 'moving', from: { name: 'Wymondley Junction', lat: 51.93 }, to: { key: '86021' } });
    // A station arrival, with no timetable to say otherwise, is a stop.
    store.apply(movement({ event_type: 'ARRIVAL', planned_event_type: 'ARRIVAL', loc_stanox: '86021' }), T0 + 28 * 60_000);
    expect(store.snapshot()[0].state).toBe('stopped');
  });

  it('moves a restored train standing at a newly placed junction to it', () => {
    const before = new TrainStore(index);
    // Wymondley Junction has no position yet: the train is shown standing at Kings Cross.
    before.apply(movement({ next_report_stanox: '86099' }), T0);
    before.apply(movement({ event_type: 'ARRIVAL', planned_event_type: 'ARRIVAL', loc_stanox: '86099', next_report_stanox: null }), T0 + 60_000);
    expect(before.snapshot()[0]).toMatchObject({ state: 'stopped', from: { name: 'London Kings Cross' } });
    const saved = JSON.parse(JSON.stringify(before.exportState(T0 + 60_000)));
    const placed = LocationIndex.byStanox(stations, { '87701': { tiplocs: ['KNGX'] }, '86099': { tiplocs: ['WYMONDJ'], name: 'WYMONDLEY JN' } }, { points: { WYMONDJ: [-0.23, 51.93] }, names: {} });
    const after = new TrainStore(placed);
    after.importState(saved, T0 + 2 * 60_000);
    expect(after.snapshot()[0].from.name).toBe('Wymondley Junction');
  });

  it('holds an arriving train at the station and records lateness', () => {
    const store = new TrainStore(index);
    store.apply(movement({ event_type: 'ARRIVAL', planned_event_type: 'ARRIVAL', loc_stanox: '86021', variation_status: 'LATE', timetable_variation: '4' }), T0);
    const [t] = store.snapshot();
    expect(t.state).toBe('stopped');
    expect(t.from.name).toBe('Stevenage');
    expect(t.delayMin).toBe(4);
  });

  it('reports early running as a negative delay', () => {
    const store = new TrainStore(index);
    store.apply(movement({ variation_status: 'EARLY', timetable_variation: '2' }), T0);
    expect(store.snapshot()[0].delayMin).toBe(-2);
  });

  it('stays put when the next timing point has no coordinates', () => {
    const store = new TrainStore(index);
    store.apply(movement({ next_report_stanox: '86099' }), T0);
    expect(store.snapshot()[0]).toMatchObject({ state: 'stopped', to: null });
  });

  it('keeps the last position when a report comes from an unmapped location', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    store.apply(movement({ loc_stanox: '86099', variation_status: 'LATE', timetable_variation: '3' }), T0 + 60_000);
    const [t] = store.snapshot();
    expect(t.from.name).toBe('London Kings Cross');
    expect(t.delayMin).toBe(3);
    expect(store.stats.unplacedReports).toBe(1);
  });

  it('does not show a train it has never been able to place', () => {
    const store = new TrainStore(index);
    store.apply(movement({ loc_stanox: '99999' }), T0);
    expect(store.snapshot()).toHaveLength(0);
    expect(store.stats.tracked).toBe(1);
  });

  it('marks terminated trains and prunes them after a short linger', () => {
    const store = new TrainStore(index);
    store.apply(movement({ event_type: 'ARRIVAL', planned_event_type: 'DESTINATION', loc_stanox: '70011', train_terminated: 'true' }), T0);
    expect(store.snapshot()[0].state).toBe('terminated');
    store.drainChanges();
    store.prune(T0 + 60_000);
    expect(store.snapshot()).toHaveLength(1);
    store.prune(T0 + 3 * 60_000);
    expect(store.snapshot()).toHaveLength(0);
    expect(store.drainChanges().removals).toEqual(['871S12MO31']);
  });

  it('prunes trains that stop reporting', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    store.prune(T0 + 40 * 60_000);
    expect(store.snapshot()).toHaveLength(1);
    store.prune(T0 + 51 * 60_000);
    expect(store.snapshot()).toHaveLength(0);
  });

  it('removes cancelled trains', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    store.drainChanges();
    store.apply({ header: { msg_type: '0002' }, body: { train_id: '871S12MO31' } }, T0);
    expect(store.snapshot()).toHaveLength(0);
    expect(store.drainChanges()).toEqual({ upserts: [], removals: ['871S12MO31'] });
  });

  it('keeps the original id but shows the new headcode after a change of identity', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    store.drainChanges();
    store.apply({ header: { msg_type: '0007' }, body: { train_id: '871S12MO31', revised_train_id: '871S99MO31' } }, T0);
    expect(store.drainChanges().upserts.map((t) => [t.id, t.headcode])).toEqual([['871S12MO31', '1S99']]);
    // Later reports still carry the original train_id.
    store.apply(movement({ loc_stanox: '86021', next_report_stanox: '70011' }), T0 + 20 * 60_000);
    const trains = store.snapshot();
    expect(trains).toHaveLength(1);
    expect(trains[0]).toMatchObject({ headcode: '1S99', state: 'moving' });
    expect(trains[0].from.name).toBe('Stevenage');
  });

  it('does not lose a train removed and re-added before the next push', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    store.drainChanges();
    store.apply({ header: { msg_type: '0002' }, body: { train_id: '871S12MO31' } }, T0);
    store.apply(movement({}), T0 + 1000);
    const changes = store.drainChanges();
    expect(changes.removals).toEqual([]);
    expect(changes.upserts).toHaveLength(1);
  });

  it('terminates a train at its last known position when the destination is unmapped', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    store.apply(movement({ event_type: 'ARRIVAL', loc_stanox: '86099', train_terminated: 'true' }), T0 + 60_000);
    const [t] = store.snapshot();
    expect(t.state).toBe('terminated');
    expect(t.from.name).toBe('London Kings Cross');
  });

  it('runs on from an unmapped junction toward a mapped next point', () => {
    const store = new TrainStore(index);
    store.apply(movement({ next_report_stanox: '86099', next_report_run_time: '5' }), T0);
    expect(store.snapshot()[0].state).toBe('stopped');
    store.apply(movement({ loc_stanox: '86099', next_report_stanox: '86021', next_report_run_time: '8', actual_timestamp: String(T0 + 5 * 60_000) }), T0 + 5 * 60_000);
    const [t] = store.snapshot();
    // Drawn from Kings Cross (the junction has no coordinates), so timed from
    // when it left there: 5 min to the junction plus 8 min on to Stevenage.
    expect(t).toMatchObject({ state: 'moving', departedAt: T0, runMs: 13 * 60_000 });
    expect(t.from.name).toBe('London Kings Cross');
    expect(t.to?.name).toBe('Stevenage');
  });

  it('does not show a speed faster than any train', () => {
    // 40 km of track in one minute.
    const store = new TrainStore(index, undefined, () => 40_000);
    store.apply(movement({ next_report_run_time: '1' }), T0);
    expect(store.snapshot()[0].speedKmh).toBeUndefined();
  });

  it('ignores null entries in a batch', () => {
    const store = new TrainStore(index);
    store.apply(null as unknown as TrustMessage, T0);
    store.apply(movement({}), T0);
    expect(store.snapshot()).toHaveLength(1);
  });

  it('records reported locations as history, merging arrival and departure', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    store.apply(movement({ event_type: 'ARRIVAL', loc_stanox: '86021', actual_timestamp: String(T0 + 20 * 60_000) }), T0 + 20 * 60_000);
    store.apply(movement({ loc_stanox: '86021', next_report_stanox: '70011', actual_timestamp: String(T0 + 21 * 60_000) }), T0 + 21 * 60_000);
    const history = store.train('871S12MO31')!.history;
    expect(history.map((h) => [h.name, h.arr, h.dep])).toEqual([
      ['London Kings Cross', undefined, T0],
      ['Stevenage', T0 + 20 * 60_000, T0 + 21 * 60_000],
    ]);
  });

  it('flags freight and empty stock by headcode class', () => {
    const store = new TrainStore(index);
    store.apply(movement({ train_id: '876M45MO31' }), T0);
    store.apply(movement({ train_id: '875A10MO31' }), T0);
    store.apply(movement({ train_id: '872C10MO31' }), T0);
    const freight = Object.fromEntries(store.snapshot().map((t) => [t.headcode, t.freight]));
    expect(freight).toEqual({ '6M45': true, '5A10': true, '2C10': false });
  });

  it('estimates section speed from track distance and running time', () => {
    // Kings Cross to Stevenage: 40 km in the 20 scheduled minutes = 120 km/h.
    const store = new TrainStore(index, undefined, () => 40_000);
    store.apply(movement({}), T0);
    expect(store.snapshot()[0].speedKmh).toBe(120);
  });

  it("never shows a speed above the train's timetabled top speed", () => {
    // A 60 mph (97 km/h) freight train, scheduled 20 minutes for the section.
    const timetable = {
      byUid: () => ({ uid: 'C10001', date: '2026-10-31', atoc: 'ZZ', origin: 'A', destination: 'B', service: { power: 'D', speed: '060' } }),
      match: () => undefined,
    };
    const run = (metres: number) => {
      const store = new TrainStore(index, undefined, () => metres);
      store.setTimetable(timetable);
      store.apply({ header: { msg_type: '0001' }, body: { train_id: '871S12MO31', toc_id: '61', train_uid: 'C10001', tp_origin_timestamp: '2026-10-31' } }, T0 - 60_000);
      store.apply(movement({}), T0);
      return store.snapshot()[0];
    };
    expect(run(30_000)).toMatchObject({ speedKmh: 90, topKmh: 97 });
    // 128 km/h from a long path or short running time: shown as the top speed.
    expect(run(42_667).speedKmh).toBe(97);
    // Far over it: something is wrong, so no speed at all.
    expect(run(60_000).speedKmh).toBeUndefined();
  });

  it('measures speed over the last section from actual report times', () => {
    const store = new TrainStore(index, undefined, () => 40_000);
    store.apply(movement({}), T0);
    // Arrives at Stevenage after 24 minutes: 40 km / 0.4 h = 100 km/h.
    store.apply(movement({ event_type: 'ARRIVAL', loc_stanox: '86021', actual_timestamp: String(T0 + 24 * 60_000) }), T0 + 24 * 60_000);
    const [t] = store.snapshot();
    expect(t).toMatchObject({ measuredKmh: 100, measuredSection: 'London Kings Cross → Stevenage', speedKmh: 0 });
  });

  describe('how a train runs its section', () => {
    it('starts and ends standing at stations, without a timetable', () => {
      const store = new TrainStore(index);
      store.apply(movement({}), T0);
      expect(store.snapshot()[0].motion).toEqual({ startsStopped: true, endsStopped: true, accel: 0.5, brake: 0.6 });
    });

    // Late away from Kings Cross; through Wymondley Junction and Stevenage without stopping.
    const plan = {
      byUid: () => undefined,
      match: () => ({ uid: 'C10001', date: '2026-10-31', atoc: 'GN', origin: 'London Kings Cross', destination: 'Peterborough' }),
      plannedStops: () => [
        { key: '87701', call: true, dep: T0 - 5 * 60_000, allowanceMs: 2 * 60_000 },
        { key: '86099', call: false, dep: T0 + 5 * 60_000, allowanceMs: 60_000 },
        { key: '86021', call: false, dep: T0 + 15 * 60_000 },
        { key: '70011', call: true, arr: T0 + 40 * 60_000 },
      ],
    };
    const late = (min: number) => movement({ planned_timestamp: String(T0 - 5 * 60_000), timetable_variation: String(min), variation_status: 'LATE' });

    it('makes up the allowances padded into the run when late, as far as it is late', () => {
      const store = new TrainStore(index);
      store.setTimetable(plan);
      store.apply(late(5), T0);
      // 20 minutes planned, less the 3 minutes of allowance up to Stevenage.
      expect(store.snapshot()[0]).toMatchObject({ runMs: 17 * 60_000, motion: { startsStopped: true, endsStopped: false } });

      const slightly = new TrainStore(index);
      slightly.setTimetable(plan);
      slightly.apply(late(1), T0);
      expect(slightly.snapshot()[0].runMs).toBe(19 * 60_000);
    });

    it('takes its full time when on time', () => {
      const store = new TrainStore(index);
      store.setTimetable(plan);
      store.apply(movement({ planned_timestamp: String(T0 - 5 * 60_000) }), T0);
      expect(store.snapshot()[0].runMs).toBe(20 * 60_000);
    });
  });

  describe('recording section run times', () => {
    const arrive = (stanox: string, min: number, next: string) => movement({
      event_type: 'ARRIVAL', planned_event_type: 'ARRIVAL', loc_stanox: stanox, actual_timestamp: String(T0 + min * 60_000), next_report_stanox: next,
    });
    const depart = (stanox: string, min: number, next: string) => movement({
      loc_stanox: stanox, actual_timestamp: String(T0 + min * 60_000), next_report_stanox: next,
    });

    it('times each run from one reporting point to the next, by kind of train', () => {
      const runTimes = new RunTimes();
      const store = new TrainStore(index, undefined, null, new Set(), runTimes);
      store.apply(movement({}), T0);
      store.apply(arrive('86021', 24, '70011'), T0 + 24 * 60_000);
      store.apply(depart('86021', 26, '70011'), T0 + 26 * 60_000);
      store.apply(movement({ event_type: 'ARRIVAL', planned_event_type: 'PASS', loc_stanox: '70011', actual_timestamp: String(T0 + 50 * 60_000) }), T0 + 50 * 60_000);
      // No schedule yet: operator and class digit.
      expect(runTimes.exportState(T0).sections).toEqual({
        '87701>86021|ss|c:61/1': [T0 + 24 * 60_000, 24 * 60],
        '86021>70011|sp|c:61/1': [T0 + 50 * 60_000, 24 * 60],
      });
      expect(store.stats.runTimes).toEqual({ sections: 2, runs: 2 });
    });

    it('skips a run when a report in between went missing', () => {
      const runTimes = new RunTimes();
      const store = new TrainStore(index, undefined, null, new Set(), runTimes);
      // Expected next at Wymondley Junction, but next heard of at Peterborough.
      store.apply(movement({ next_report_stanox: '86099' }), T0);
      store.apply(arrive('70011', 45, ''), T0 + 45 * 60_000);
      expect(runTimes.stats.runs).toBe(0);
    });

    it("uses the schedule's power type and timing load once it is known", () => {
      const runTimes = new RunTimes();
      const store = new TrainStore(index, undefined, null, new Set(), runTimes);
      const info = { uid: 'C10001', date: '2026-10-31', atoc: 'GN', origin: 'London Kings Cross', destination: 'Peterborough', service: { power: 'EMU', timingLoad: '387' } };
      store.setTimetable({ byUid: () => undefined, match: () => info });
      store.apply(movement({ planned_timestamp: String(T0) }), T0);
      store.apply(arrive('86021', 20, '70011'), T0 + 20 * 60_000);
      expect(Object.keys(runTimes.exportState(T0).sections)).toEqual(['87701>86021|ss|t:EMU/387']);
    });
  });

  it('only sends each change once', () => {
    const store = new TrainStore(index);
    store.apply(movement({}), T0);
    expect(store.drainChanges().upserts).toHaveLength(1);
    expect(store.drainChanges()).toEqual({ upserts: [], removals: [] });
  });
});

describe('trustTime', () => {
  it('passes through UTC timestamps', () => {
    expect(trustTime(String(T0), T0 + 5000)).toBe(T0);
  });
  it('corrects timestamps an hour ahead (UK local time during BST)', () => {
    expect(trustTime(String(T0 + 3_600_000), T0 + 5000)).toBe(T0);
  });
  it('falls back to receipt time for missing values', () => {
    expect(trustTime(null, T0)).toBe(T0);
    expect(trustTime('', T0)).toBe(T0);
  });
});
