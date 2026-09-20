import type { PlaybackState } from '../shared/protocol.js';

export type ClockSyncTimestamps = {
  clientSentAtMs: number;
  serverReceivedAtMs: number;
  serverSentAtMs: number;
  clientReceivedAtMs: number;
};

export type ClockSyncEstimate = {
  /** Add this value to the client clock to express it in the server clock domain. */
  serverClockOffsetMs: number;
  /** Network round-trip time with server processing time removed. */
  roundTripMs: number;
};

/**
 * Estimate server-minus-client wall-clock offset with the four-timestamp NTP formula.
 * The estimate is per connection: different browser devices can have different clocks.
 */
export function estimateServerClockOffset(timestamps: ClockSyncTimestamps): ClockSyncEstimate {
  const values = Object.values(timestamps);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Clock synchronization timestamps must be finite');
  }
  const clientElapsedMs = timestamps.clientReceivedAtMs - timestamps.clientSentAtMs;
  const serverProcessingMs = timestamps.serverSentAtMs - timestamps.serverReceivedAtMs;
  if (clientElapsedMs < 0 || serverProcessingMs < 0) {
    throw new RangeError('Clock synchronization timestamps must be monotonic within each machine');
  }
  return {
    serverClockOffsetMs: (
      (timestamps.serverReceivedAtMs - timestamps.clientSentAtMs)
      + (timestamps.serverSentAtMs - timestamps.clientReceivedAtMs)
    ) / 2,
    roundTripMs: Math.max(0, clientElapsedMs - serverProcessingMs),
  };
}

/**
 * Convert a server-clock PlaybackState anchor into the receiving client's clock
 * domain. Position and revision are unchanged; only absolute timestamps move.
 */
export function localizePlaybackStateClock(
  state: PlaybackState,
  serverClockOffsetMs: number,
): PlaybackState {
  if (!Number.isFinite(serverClockOffsetMs)) {
    throw new RangeError('Server clock offset must be finite');
  }
  return {
    ...state,
    positionAtMs: state.positionAtMs - serverClockOffsetMs,
    updatedAtMs: state.updatedAtMs - serverClockOffsetMs,
  };
}
