import { describe, expect, it } from 'vitest';
import type { PlannedStop } from '../src/feeds/feed.ts';
import { parseStationQuery, searchByStation } from '../src/engine/stationSearch.ts';
import type { TrainView } from '../src/engine/trainStore.ts';

// Thursday 26 November 2026, GMT: London time is UTC.
const at = (h: number, m: number) => Date.UTC(2026, 10, 26, h, m);
const view = (id: string) => ({ id }) as TrainView;
const stop = (name: string, call: boolean, arr?: number, dep?: number): PlannedStop => ({ key: name, name, call, arr, dep });
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
      { id: 'A', station: 'London Paddington', at: at(8, 0), kind: 'dep' },
      { id: 'B', station: 'London Paddington', at: at(8, 30), kind: 'dep' },
    ].slice(0, 1));
    expect(searchByStation('Paddington 08:20', trains, at(7, 0)).map((m) => m.id)).toEqual(['B', 'A']);
    expect(searchByStation('bristol 0940', trains, at(7, 0))).toEqual([{ id: 'A', station: 'Bristol Temple Meads', at: at(9, 40), kind: 'arr' }]);
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

  it('needs a station, not just a time', () => {
    expect(searchByStation('08:00', trains, at(7, 0))).toEqual([]);
  });
});
