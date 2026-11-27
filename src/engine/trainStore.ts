// Turns TRUST messages into a map-ready view of where each train is.
//
// TRUST only reports a train when it passes a timing point, so positions are
// estimated: after a departure the train runs from that point toward
// `next_report_stanox`, taking `next_report_run_time` minutes. The browser
// interpolates along that segment; the server only sends segment changes.

import type { PlannedStop } from '../feeds/feed.ts';
import type { ScheduleInfo, ScheduleLookup } from '../schedule/timetable.ts';
import type { LocationIndex, Place } from './locations.ts';
import { type Motion, railRates } from './motion.ts';
import type { Leg, RunTimes } from './runTimes.ts';
import {
  MSG_ACTIVATION,
  MSG_CANCELLATION,
  MSG_CHANGE_OF_IDENTITY,
  MSG_MOVEMENT,
  type MovementBody,
  type TrustBody,
  type TrustMessage,
} from '../trust/types.ts';

export type TrainState = 'moving' | 'stopped' | 'terminated';

export interface TrainView {
  id: string; // TRUST train_id
  headcode: string;
  toc: string;
  operator?: string;
  freight: boolean;
  state: TrainState;
  from: Place;
  to: Place | null;
  /** When the train left `from` (ms since epoch, UTC). */
  departedAt: number;
  /** Expected running time from `from` to `to`. */
  runMs: number;
  /** How it runs the section (speeding up, braking), for drawing it; absent: at one speed. */
  motion?: Motion;
  /** For a standing train, where it runs to next (so the map can show which way it faces). */
  toward?: string;
  /** Minutes against the timetable; negative means early. */
  delayMin: number;
  platform?: string;
  /** When the last report for this train happened (ms since epoch, UTC). */
  reportedAt: number;
  /**
   * Average speed over the current section, km/h: track length over expected
   * running time. An estimate, not a measured speed; 0 when standing.
   */
  speedKmh?: number;
  /** Average speed over the last completed section, from actual report times. */
  measuredKmh?: number;
  measuredSection?: string;
  /** The train's timetabled top speed, km/h, which the speeds above never exceed. */
  topKmh?: number;
  /** TfL network (Underground, DLR, Overground, Elizabeth line); absent for National Rail. */
  mode?: 'tube' | 'dlr' | 'overground' | 'elizabeth-line';
  line?: string;
  color?: string;
  /** Where the train started and where it terminates (National Rail: from its schedule). */
  origin?: string;
  destination?: string;
}

/** Everything needed to carry trains over a server restart. */
export interface StoreState {
  version: 1;
  savedAt: number;
  trains: TrainRecord[];
}

export interface TrainChanges {
  upserts: TrainView[];
  removals: string[];
}

export interface StoreStats {
  messages: number;
  byType: Record<string, number>;
  /** Movement reports at locations with no known coordinates. */
  unplacedReports: number;
  lastMessageAt: number | null;
}

/** One reported location, with arrival and/or departure merged. */
export interface HistoryEntry {
  key: string;
  name: string;
  arr?: number;
  dep?: number;
  pass: boolean;
  delayMin: number;
  /** The platform it reported at here, when TRUST gives one. */
  platform?: string;
}

interface TrainRecord {
  id: string;
  toc: string;
  /** Set by a change of identity; otherwise derived from the id. */
  headcode?: string;
  view?: TrainView;
  history: HistoryEntry[];
  lastSeen: number;
  measured?: { kmh: number; section: string };
  /** Where its latest report said it reports next, so a run between consecutive reporting points can be timed. */
  nextKey?: string;
  /** From the activation message: which schedule, starting which day. */
  uid?: string;
  runDate?: string;
  schedule?: ScheduleInfo;
}

export type OperatorNameFn = (toc: string, atoc?: string) => string | undefined;

/** Track distance in metres between two location keys, if known. */
export type DistanceFn = (fromKey: string, toKey: string) => number | null;

// Reports closer together than this give a meaningless speed.
const MIN_MEASURE_MS = 30_000;
// Above GB line speeds (200 km/h, with margin): a bad report, path or timing.
const MAX_KMH = 225;
// Over a train's own top speed, an average comes from rounded times or a path a
// little long: shown as the top speed. Over this many times it, something is wrong.
const OVER_TOP_SPEED = 1.5;

const MAX_HISTORY = 150;

const TERMINATED_LINGER_MS = 2 * 60_000;
const STALE_AFTER_MS = 30 * 60_000;
// How far a report's planned time may be from the timetable's for the same place.
const PLANNED_TOLERANCE_MS = 2 * 60_000;
// TRUST timestamps have been seen in UK local time rather than UTC, which
// puts them an hour in the future during BST.
const BST_SKEW_MS = 60 * 60_000;

// Headcode first digit 0/3/4/5/6/7/8 is light engines, empty stock or freight.
const NON_PASSENGER_CLASSES = new Set(['0', '3', '4', '5', '6', '7', '8']);

/** The train's timetabled top speed in km/h, when its schedule gives one. */
function topKmhOf(rec: TrainRecord): number | undefined {
  const mph = Number(rec.schedule?.service?.speed);
  return mph > 0 ? Math.round(mph * 1.609) : undefined;
}

/**
 * What kind of train, for timing it: the schedule's power type and timing
 * load (what the timetable's own running times are worked out for), or,
 * before the schedule is known, its operator and the headcode's class digit.
 */
export function profileOf(rec: { toc: string; id: string; headcode?: string; schedule?: ScheduleInfo }): string {
  const s = rec.schedule?.service;
  if (s?.power || s?.timingLoad) return `t:${s.power ?? ''}/${s.timingLoad ?? ''}`;
  return `c:${rec.toc}/${(rec.headcode ?? headcodeOf(rec.id))[0]}`;
}

/** A speed no higher than the train can go: capped at its top speed, or nothing if far over it. */
function capped(kmh: number | undefined, topKmh: number | undefined): number | undefined {
  if (kmh === undefined || !topKmh) return kmh;
  return kmh > topKmh * OVER_TOP_SPEED ? undefined : Math.min(kmh, topKmh);
}

export function trustTime(raw: string | null | undefined, receivedAt: number): number {
  const t = Number(raw);
  if (!raw || !Number.isFinite(t) || t <= 0) return receivedAt;
  if (t - receivedAt > 30 * 60_000) return t - BST_SKEW_MS;
  return t;
}

export function headcodeOf(trainId: string): string {
  return trainId.slice(2, 6);
}

export class TrainStore {
  #locations: LocationIndex;
  #operatorName: OperatorNameFn;
  #distance: DistanceFn | null;
  #skipTocs: ReadonlySet<string>;
  #runTimes: RunTimes | null;
  #timetable: ScheduleLookup | null = null;
  #feedStops: ((trainId: string) => PlannedStop[] | undefined) | null = null;
  #trains = new Map<string, TrainRecord>();
  #changed = new Set<string>();
  #removed = new Set<string>();
  #stats: StoreStats = { messages: 0, byType: {}, unplacedReports: 0, lastMessageAt: null };

  constructor(
    locations: LocationIndex,
    operatorName: OperatorNameFn = () => undefined,
    distance: DistanceFn | null = null,
    /** Operators whose trains another source already shows. */
    skipTocs: ReadonlySet<string> = new Set(),
    /** Where to record how long each section run took (live mode). */
    runTimes: RunTimes | null = null,
  ) {
    this.#locations = locations;
    this.#operatorName = operatorName;
    this.#distance = distance;
    this.#skipTocs = skipTocs;
    this.#runTimes = runTimes;
  }

  apply(msg: TrustMessage, receivedAt: number): void {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.header?.msg_type;
    if (!type || !msg.body) return;
    this.#stats.messages++;
    this.#stats.byType[type] = (this.#stats.byType[type] ?? 0) + 1;
    this.#stats.lastMessageAt = receivedAt;

    switch (type) {
      case MSG_ACTIVATION:
        this.#activate(msg.body, receivedAt);
        break;
      case MSG_MOVEMENT:
        this.#move(msg.body as unknown as MovementBody, receivedAt);
        break;
      case MSG_CANCELLATION:
        this.#remove(msg.body.train_id);
        break;
      case MSG_CHANGE_OF_IDENTITY:
        this.#changeIdentity(msg.body.train_id, msg.body.revised_train_id);
        break;
      // Reinstatement, change of origin and change of location do not move a
      // train on the map; its next movement report will.
    }
  }

  /** Drops trains that terminated a while ago or stopped reporting. */
  prune(now: number): void {
    for (const [id, rec] of this.#trains) {
      const v = rec.view;
      const idle = now - rec.lastSeen;
      if (v?.state === 'terminated' && idle > TERMINATED_LINGER_MS) this.#remove(id);
      else if (idle > STALE_AFTER_MS + (v?.runMs ?? 0)) this.#remove(id);
    }
  }

  /** Changes since the previous call, for pushing to connected browsers. */
  drainChanges(): TrainChanges {
    const upserts: TrainView[] = [];
    for (const id of this.#changed) {
      const view = this.#trains.get(id)?.view;
      if (view) upserts.push(view);
    }
    const removals = [...this.#removed];
    this.#changed.clear();
    this.#removed.clear();
    return { upserts, removals };
  }

  /** Current view and reported locations so far, for the train detail panel. */
  train(id: string): { view: TrainView; history: readonly HistoryEntry[] } | undefined {
    const rec = this.#trains.get(id);
    return rec?.view ? { view: rec.view, history: rec.history } : undefined;
  }

  snapshot(): TrainView[] {
    const out: TrainView[] = [];
    for (const rec of this.#trains.values()) if (rec.view) out.push(rec.view);
    return out;
  }

  get stats(): StoreStats & { tracked: number; onMap: number; runTimes?: { sections: number; runs: number } } {
    let onMap = 0;
    for (const rec of this.#trains.values()) if (rec.view) onMap++;
    return { ...this.#stats, tracked: this.#trains.size, onMap, ...(this.#runTimes && { runTimes: this.#runTimes.stats }) };
  }

  /** Live mode: schedules give trains their origin, destination and operator. Swapped daily. */
  setTimetable(timetable: ScheduleLookup | null): void {
    this.#timetable = timetable;
    // Trains restored from a snapshot carry their schedule as described then.
    for (const rec of this.#trains.values()) {
      const s = rec.schedule;
      const fresh = s && timetable?.byUid(s.uid, s.date);
      if (!fresh) continue;
      rec.schedule = fresh;
      if (!rec.view) continue;
      rec.view = { ...rec.view, operator: this.#operatorName(rec.toc, fresh.atoc), origin: fresh.origin, destination: fresh.destination };
      this.#changed.add(rec.id);
    }
  }

  /** For a feed that plans its own trains (the demo): their stops by train id, used when there is no schedule. */
  setPlannedStops(plannedStops: ((trainId: string) => PlannedStop[] | undefined) | null): void {
    this.#feedStops = plannedStops;
  }

  /** Which schedule a train runs to, once known. */
  scheduleOf(id: string): ScheduleInfo | undefined {
    return this.#trains.get(id)?.schedule;
  }

  /** Every train, for saving across a restart. */
  exportState(now: number): StoreState {
    return { version: 1, savedAt: now, trains: [...this.#trains.values()] };
  }

  /** Brings back trains saved by exportState, unless they have gone quiet since. Returns how many. */
  importState(state: StoreState, now: number): number {
    if (state?.version !== 1 || !Array.isArray(state.trains)) return 0;
    let n = 0;
    for (const rec of state.trains) {
      if (!rec?.id || this.#trains.has(rec.id) || now - rec.lastSeen > STALE_AFTER_MS) continue;
      // A train standing where the last run could not place it (a junction
      // since given a position) moves to its last report.
      const last = this.#locations.get(rec.history.at(-1)?.key);
      if (rec.view && rec.view.state !== 'moving' && last && last.key !== rec.view.from.key) rec.view = { ...rec.view, from: last };
      this.#trains.set(rec.id, rec);
      if (rec.view) this.#changed.add(rec.id);
      n++;
    }
    return n;
  }

  #activate(body: TrustBody, receivedAt: number): void {
    const id = body.train_id;
    if (!id || this.#trains.has(id) || this.#skipTocs.has(body.toc_id ?? '')) return;
    this.#trains.set(id, {
      id,
      toc: body.toc_id ?? '',
      history: [],
      lastSeen: receivedAt,
      uid: body.train_uid?.trim() || undefined,
      // The day the train starts, YYYY-MM-DD.
      runDate: body.tp_origin_timestamp?.slice(0, 10) || undefined,
    });
  }

  #move(body: MovementBody, receivedAt: number): void {
    const id = body.train_id;
    if (!id || this.#skipTocs.has(body.toc_id ?? '')) return;
    let rec = this.#trains.get(id);
    if (!rec) {
      rec = { id, toc: body.toc_id ?? '', history: [], lastSeen: receivedAt };
      this.#trains.set(id, rec);
    }
    rec.lastSeen = receivedAt;
    if (body.toc_id) rec.toc = body.toc_id;

    const at = trustTime(body.actual_timestamp, receivedAt);
    const delayMin = delayOf(body);
    this.#record(rec, body, at, delayMin);
    rec.nextKey = body.next_report_stanox || undefined;
    this.#findSchedule(rec, body, receivedAt);
    const scheduled = {
      operator: this.#operatorName(rec.toc, rec.schedule?.atoc),
      origin: rec.schedule?.origin,
      destination: rec.schedule?.destination,
    };

    // A location we cannot place (junction, yard) still tells us where the
    // train goes next; carry on from its last known position.
    const placed = this.#locations.get(body.loc_stanox);
    if (!placed) this.#stats.unplacedReports++;
    const here = placed ?? rec.view?.from;
    if (!here) return;

    const headcode = rec.headcode ?? headcodeOf(id);
    const base = {
      id,
      headcode,
      toc: rec.toc,
      ...scheduled,
      freight: NON_PASSENGER_CLASSES.has(headcode[0]),
      from: here,
      delayMin,
      platform: body.platform?.trim() || undefined,
      reportedAt: at,
      departedAt: at,
      measuredKmh: capped(rec.measured?.kmh, topKmhOf(rec)),
      measuredSection: rec.measured?.section,
      topKmh: topKmhOf(rec),
    };
    const next = this.#locations.get(body.next_report_stanox);
    const runMin = Number(body.next_report_run_time);
    // Places report an arrival for trains running through as well. The
    // timetable says whether the train stops here; without it, a junction or
    // signal is passed and a station is a stop.
    const passing = body.event_type === 'ARRIVAL' && rec.view?.state === 'moving'
      && (this.#passesAt(rec, here.key, plannedTime(body, receivedAt)) ?? Boolean(placed?.timingPoint));
    // Reports at unplaced timing points are almost always passes.
    const running = body.event_type === 'DEPARTURE' || !placed || passing;

    if (body.train_terminated === 'true' || body.planned_event_type === 'DESTINATION') {
      rec.view = { ...base, state: 'terminated', to: null, runMs: 0, speedKmh: 0 };
    } else if (running && next && next.key !== here.key && runMin > 0) {
      // From an unplaced junction the train is drawn from the last place we
      // can draw: time the run from when it left there (not from the
      // junction), so it carries on instead of jumping back, at a true speed.
      let departedAt = at;
      if (!placed) {
        const left = rec.history.findLast((h) => h.key === here.key);
        departedAt = Math.min(at, left?.dep ?? left?.arr ?? (rec.view?.state === 'moving' ? rec.view.departedAt : at));
      }
      const section = this.#sectionPlan(rec, body.loc_stanox, plannedTime(body, receivedAt), next.key);
      // A late train can make up the time the timetable pads into the run
      // (but runs no faster than its plan without the padding).
      const recoverMs = delayMin > 0 ? Math.min(section.allowanceMs, delayMin * 60_000, runMin * 30_000) : 0;
      const runMs = at + runMin * 60_000 - recoverMs - departedAt;
      const motion: Motion = {
        startsStopped: placed
          ? body.event_type === 'DEPARTURE' && body.planned_event_type !== 'PASS' && !passing
          : rec.view?.state === 'moving' ? rec.view.motion?.startsStopped ?? false : rec.view?.state === 'stopped',
        // Without a timetable, as for reports: a junction or signal is passed, a station is a stop.
        endsStopped: section.endsStopped ?? !next.timingPoint,
        ...railRates(headcode, rec.schedule),
      };
      rec.view = { ...base, departedAt, state: 'moving', to: next, runMs, motion, speedKmh: capped(this.#speedKmh(here.key, next.key, runMs), base.topKmh) };
    } else if (placed && !passing) {
      const toward = next && next.key !== here.key ? next.key : undefined;
      rec.view = { ...base, state: 'stopped', to: null, runMs: 0, speedKmh: 0, toward };
    } else {
      rec.view = { ...rec.view!, ...scheduled, delayMin, reportedAt: at, measuredKmh: base.measuredKmh, measuredSection: base.measuredSection, topKmh: base.topKmh };
    }
    this.#changed.add(id);
    // Removed and re-added within one push: the browser must not drop it.
    this.#removed.delete(id);
  }

  /**
   * Ties a train to its schedule: by the activation's schedule id, or, for a
   * train already running when we started listening, by headcode, place and
   * planned time.
   */
  #findSchedule(rec: TrainRecord, body: MovementBody, receivedAt: number): void {
    const timetable = this.#timetable;
    if (rec.schedule || !timetable) return;
    if (rec.uid && rec.runDate) rec.schedule = timetable.byUid(rec.uid, rec.runDate);
    if (rec.schedule || !body.planned_timestamp || !body.loc_stanox) return;
    const planned = plannedTime(body, receivedAt);
    if (Number.isFinite(planned) && planned > 0) {
      rec.schedule = timetable.match(rec.headcode ?? headcodeOf(rec.id), body.loc_stanox, planned);
    }
  }

  /**
   * Whether the train's schedule runs through `key` without stopping at
   * about `plannedMs`; undefined when the schedule does not say. By time as
   * well as place: a train may pass one place several times (railhead
   * treatment trains go out and back along each line).
   */
  #passesAt(rec: TrainRecord, key: string, plannedMs: number): boolean | undefined {
    const at = this.#plannedAt(rec, key, plannedMs);
    const p = at?.stops[at.i];
    return p && !p.call && p.arr === undefined;
  }

  /** Where in the train's schedule it is timed at `key` at about `plannedMs`. */
  #plannedAt(rec: TrainRecord, key: string, plannedMs: number): { stops: PlannedStop[]; i: number } | undefined {
    if (!Number.isFinite(plannedMs)) return undefined;
    const s = rec.schedule;
    const stops = s ? this.#timetable?.plannedStops?.(s.uid, s.date) : this.#feedStops?.(rec.id);
    if (!stops) return undefined;
    let best = -1;
    let gap = PLANNED_TOLERANCE_MS;
    stops.forEach((p, i) => {
      const g = p.key === key ? Math.abs((p.arr ?? p.dep ?? Infinity) - plannedMs) : Infinity;
      if (g <= gap) [best, gap] = [i, g];
    });
    return best >= 0 ? { stops, i: best } : undefined;
  }

  /**
   * From the schedule, for the run from `key` (timed there at `plannedMs`)
   * on to `nextKey`: whether the train stops there, and the allowances
   * padded into the run. Nothing known without a schedule.
   */
  #sectionPlan(rec: TrainRecord, key: string, plannedMs: number, nextKey: string): { endsStopped?: boolean; allowanceMs: number } {
    const at = this.#plannedAt(rec, key, plannedMs);
    if (!at) return { allowanceMs: 0 };
    let allowanceMs = 0;
    for (let j = at.i; j + 1 < at.stops.length; j++) {
      allowanceMs += at.stops[j].allowanceMs ?? 0;
      const p = at.stops[j + 1];
      if (p.key === nextKey) return { endsStopped: p.call || p.arr !== undefined, allowanceMs };
    }
    return { allowanceMs: 0 };
  }

  #record(rec: TrainRecord, body: MovementBody, at: number, delayMin: number): void {
    const key = body.loc_stanox;
    if (!key) return;
    const arriving = body.event_type === 'ARRIVAL';
    const platform = body.platform?.trim() || undefined;
    const last = rec.history.at(-1);
    if (last?.key === key) {
      if (arriving) last.arr = at;
      else last.dep = at;
      last.delayMin = delayMin;
      if (platform) last.platform = platform;
      return;
    }
    const entry: HistoryEntry = {
      key,
      name: this.#locations.name(key) ?? key,
      arr: arriving ? at : undefined,
      dep: arriving ? undefined : at,
      pass: body.planned_event_type === 'PASS',
      delayMin,
      ...(platform && { platform }),
    };
    rec.history.push(entry);
    if (rec.history.length > MAX_HISTORY) rec.history.shift();
    // Only a run between consecutive reporting points: a report in between
    // may have gone missing, or the train been rerouted.
    if (last && rec.nextKey === key) this.#recordRun(rec, last, entry, at);
    this.#measure(rec, key, at);
  }

  /** How long the run from one reporting point to the next took, for that section's usual time. */
  #recordRun(rec: TrainRecord, prev: HistoryEntry, here: HistoryEntry, at: number): void {
    const left = prev.dep ?? prev.arr;
    if (!this.#runTimes || left === undefined) return;
    const leg: Leg = { from: prev.key, to: here.key, profile: profileOf(rec), startsStopped: !prev.pass, endsStopped: !here.pass };
    this.#runTimes.add(leg, at - left, at);
  }

  /** Track distance over expected running time, km/h; nothing if that is faster than any GB train. */
  #speedKmh(fromKey: string, toKey: string, runMs: number): number | undefined {
    const m = this.#distance?.(fromKey, toKey);
    const kmh = m && runMs > 0 ? Math.round((m / (runMs / 1000)) * 3.6) : undefined;
    return kmh !== undefined && kmh <= MAX_KMH ? kmh : undefined;
  }

  /** Average speed between the last two placed reports, from their actual times. */
  #measure(rec: TrainRecord, key: string, at: number): void {
    if (!this.#distance || !this.#locations.get(key)) return;
    for (let i = rec.history.length - 2; i >= 0; i--) {
      const h = rec.history[i];
      if (!this.#locations.get(h.key)) continue;
      const left = h.dep ?? h.arr;
      if (left === undefined || at - left < MIN_MEASURE_MS) return;
      const m = this.#distance(h.key, key);
      const kmh = m ? Math.round((m / ((at - left) / 1000)) * 3.6) : 0;
      // Faster than any GB train means a bad report or a bad path.
      if (kmh > 0 && kmh <= MAX_KMH) rec.measured = { kmh, section: `${h.name} → ${this.#locations.name(key) ?? key}` };
      return;
    }
  }

  #remove(id: string | null | undefined): void {
    if (!id || !this.#trains.has(id)) return;
    const hadView = Boolean(this.#trains.get(id)?.view);
    this.#trains.delete(id);
    this.#changed.delete(id);
    if (hadView) this.#removed.add(id);
  }

  // TRUST keeps reporting the train under the train_id it was activated with
  // (the new one only appears as current_train_id), so the record stays keyed
  // by that and only the displayed headcode changes.
  #changeIdentity(id: string | null | undefined, revisedId: string | null | undefined): void {
    const rec = id ? this.#trains.get(id) : undefined;
    if (!rec || !revisedId) return;
    rec.headcode = headcodeOf(revisedId);
    if (rec.view) {
      rec.view = { ...rec.view, headcode: rec.headcode, freight: NON_PASSENGER_CLASSES.has(rec.headcode[0]) };
      this.#changed.add(rec.id);
    }
  }
}

/** A report's planned time, with the same clock skew taken out as from its actual time. */
function plannedTime(body: MovementBody, receivedAt: number): number {
  if (!body.planned_timestamp) return NaN;
  const skew = Number(body.actual_timestamp) - trustTime(body.actual_timestamp, receivedAt);
  return Number(body.planned_timestamp) - (Number.isFinite(skew) ? skew : 0);
}

function delayOf(body: MovementBody): number {
  const minutes = Number(body.timetable_variation) || 0;
  if (body.variation_status === 'LATE') return minutes;
  if (body.variation_status === 'EARLY') return -minutes;
  return 0;
}
