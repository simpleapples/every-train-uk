import { describe, expect, it } from 'vitest';
import { parseStationQuery, searchByStation, type SearchStop } from '../src/engine/stationSearch.ts';
import type { TrainView } from '../src/engine/trainStore.ts';

// Thursday 26 November 2026, GMT: London time is UTC.
const at = (h: number, m: number) => Date.UTC(2026, 10, 26, h, m);
const view = (id: string, delayMin = 0) => ({ id, delayMin }) as TrainView;
const stop = (name: string, call: boolean, arr?: number, dep?: number, extra: Partial<SearchStop> = {}): SearchStop => ({ key: name, name, call, arr, dep, ...extra });
const trains = [
  { view: view('A'), stops: [stop('London Paddington', true, undefined, at(8, 0)), stop('Reading', false, undefined, at(8, 24)), stop('Bristol Temple Meads', true, at(9, 40))] },
  { view: view('B'), stops: [stop('London Paddington', true, undefined, at(8, 30)), stop('Reading', true, at(8, 52), at(8, 54)), stop('Oxford', true, at(9, 20))] },
];

describe('station search', () => {
  it('reads a time of day out of the query', () => {
    expect(parseStationQuery('Paddington 08:00')).toEqual({ words: ['paddington'], minute: 480 });
    expect(parseStationQuery('0805 bristol')).toEqual({ words: ['bristol'], minute: 485 });
    expect(parseStationQuery('St. Pancras 9')).toEqual({ words: ['st', 'pancras', '9'], minute: undefined });
    // A headcode is not a time.
    expect(parseStationQuery('1A94').minute).toBeUndefined();
  });

  it('finds the train due at a station nearest the time asked', () => {
    expect(searchByStation('padd 8:00', trains, at(7, 0))).toEqual([
      { id: 'A', station: 'London Paddington', at: at(8, 0), kind: 'dep', expected: at(8, 0), state: 'due' },
      { id: 'B', station: 'London Paddington', at: at(8, 30), kind: 'dep', expected: at(8, 30), state: 'due' },
    ].slice(0, 1));
    expect(searchByStation('Paddington 08:20', trains, at(7, 0)).map((m) => m.id)).toEqual(['B', 'A']);
    expect(searchByStation('bristol 0940', trains, at(7, 0))).toEqual([{ id: 'A', station: 'Bristol Temple Meads', at: at(9, 40), kind: 'arr', expected: at(9, 40), state: 'due' }]);
  });

  it("gives the train's platform at the station when known", () => {
    const withPlatforms = [{ view: view('C'), stops: [stop('London Paddington', true, undefined, at(8, 0), { platform: '9' }), stop('Oxford', true, at(9, 0))] }];
    expect(searchByStation('paddington', withPlatforms, at(7, 50))[0].platform).toBe('9');
    expect(searchByStation('oxford', withPlatforms, at(7, 50))[0]).not.toHaveProperty('platform');
  });

  it('matches only where the train stops, every word of the name', () => {
    // A runs through Reading without stopping.
    expect(searchByStation('reading', trains, at(8, 0)).map((m) => m.id)).toEqual(['B']);
    expect(searchByStation('temple meads', trains, at(8, 0)).map((m) => m.id)).toEqual(['A']);
    expect(searchByStation('kings cross', trains, at(8, 0))).toEqual([]);
  });

  it('without a time, lists the soonest first', () => {
    expect(searchByStation('paddington', trains, at(8, 10)).map((m) => m.id)).toEqual(['B', 'A']);
  });

  it('is a departure board without a time: still to come by expected time, then a few that have gone', () => {
    const board = [
      // Left Reading already.
      { view: view('C'), stops: [stop('Reading', true, undefined, at(8, 5), { passed: true }), stop('Oxford', true, at(8, 40))] },
      // Due at 8:15 but 10 minutes late, so after D.
      { view: view('E', 10), stops: [stop('Reading', true, at(8, 13), at(8, 15)), stop('Didcot', true, at(8, 30))] },
      { view: view('D'), stops: [stop('Reading', true, undefined, at(8, 20)), stop('Oxford', true, at(8, 50))] },
      // Standing at Reading now.
      { view: view('F'), stops: [stop('Reading', true, at(8, 9), at(8, 11), { here: true }), stop('Oxford', true, at(8, 40))] },
    ];
    const r = searchByStation('reading', board, at(8, 10));
    expect(r.map((m) => [m.id, m.state])).toEqual([['F', 'here'], ['D', 'due'], ['E', 'due'], ['C', 'gone']]);
    expect(r.find((m) => m.id === 'E')!.expected).toBe(at(8, 25));
  });

  it('keeps a train held short of the station on its board, however late', () => {
    // Due at 8:00, reported running 1 min late, still not there at 8:20.
    const held = [{ view: view('H', 1), stops: [stop('Reading', true, at(7, 58), at(8, 0), { passed: false }), stop('Oxford', true, at(8, 30))] }];
    expect(searchByStation('reading', held, at(8, 20)).map((m) => [m.id, m.state])).toEqual([['H', 'due']]);
  });

  it('uses a predicted time where there is one (TfL)', () => {
    const tube = [{ view: view('T'), stops: [stop('Leyton', true, at(8, 4), undefined, { expected: at(8, 4) }), stop('Stratford', true, at(8, 7), undefined, { expected: at(8, 7) })] }];
    expect(searchByStation('leyton', tube, at(8, 0))).toEqual([{ id: 'T', station: 'Leyton', at: at(8, 4), kind: 'dep', expected: at(8, 4), state: 'due' }]);
  });

  it('needs a station, not just a time', () => {
    expect(searchByStation('08:00', trains, at(7, 0))).toEqual([]);
  });
});
