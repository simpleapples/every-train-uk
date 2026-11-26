import type { TrustMessage } from '../trust/types.ts';

export type EmitMessages = (messages: TrustMessage[], receivedAt: number) => void;

export interface FeedStatus {
  connected: boolean;
  detail: string;
}

/** A timetabled location; times are planned, ms since epoch. */
export interface PlannedStop {
  key: string;
  /** The timetable's own name for the place, for timing points with no station name. */
  name?: string;
  call: boolean;
  arr?: number;
  dep?: number;
  /**
   * Engineering, pathing and performance allowances: time the timetable pads
   * into the run from here to the next location, beyond what the train needs.
   */
  allowanceMs?: number;
}

export interface Feed {
  readonly kind: 'demo' | 'nrod';
  start(emit: EmitMessages): void;
  stop(): void;
  status(): FeedStatus;
  /**
   * The train's full timetable, when the feed knows it. TRUST alone does not
   * carry one; live mode would need the SCHEDULE feed for this.
   */
  plannedStops?(trainId: string): PlannedStop[] | undefined;
}
