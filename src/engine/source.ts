import type { FeedStatus } from '../feeds/feed.ts';
import type { SearchStop } from './stationSearch.ts';
import type { TrainDetails } from './trainDetails.ts';
import type { TrainChanges, TrainView } from './trainStore.ts';

/**
 * A set of trains shown on the map alongside the main rail feed, with its own
 * data source (e.g. the London Underground from TfL).
 */
export interface TrainSource {
  readonly name: string;
  start(): void;
  stop(): void;
  snapshot(): TrainView[];
  /** Changes since the previous call, for pushing to connected browsers. */
  drainChanges(): TrainChanges;
  status(): FeedStatus & { trains: number };
  describe(trainId: string): TrainDetails | undefined;
  /** The train's stops for station search, with predicted times and how far it has got. */
  searchStops?(trainId: string): SearchStop[];
}
