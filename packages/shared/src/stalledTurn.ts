/**
 * Detect when a provider turn is still marked running but the client has not
 * received stream/orchestration updates for a while.
 *
 * Shared across providers: any adapter that leaves a session "running" while
 * silent will surface the same stalled signal.
 */

/** Default silence window before the UI treats a running turn as stalled. */
export const STALLED_TURN_THRESHOLD_MS = 30_000;

export type StalledTurnState = {
  readonly isStalled: boolean;
  /** Milliseconds since the last observed activity; 0 when not running or unknown. */
  readonly silentForMs: number;
};

/**
 * Pick the latest ISO timestamp that indicates the client still received
 * turn/stream activity. Prefer thread.updatedAt — the client reducer bumps it
 * on orchestration events, including streaming message deltas that do not
 * refresh message.updatedAt while streaming.
 */
export function deriveLastStreamActivityAt(input: {
  readonly threadUpdatedAt?: string | null;
  readonly sessionUpdatedAt?: string | null;
  readonly latestTurnRequestedAt?: string | null;
  readonly latestTurnStartedAt?: string | null;
}): string | null {
  return maxIsoTimestamp(
    input.threadUpdatedAt,
    input.sessionUpdatedAt,
    input.latestTurnRequestedAt,
    input.latestTurnStartedAt,
  );
}

export function deriveStalledTurnState(input: {
  readonly isRunning: boolean;
  readonly lastActivityAt: string | null | undefined;
  readonly nowMs: number;
  readonly thresholdMs?: number;
}): StalledTurnState {
  if (!input.isRunning) {
    return { isStalled: false, silentForMs: 0 };
  }

  const thresholdMs = input.thresholdMs ?? STALLED_TURN_THRESHOLD_MS;
  const lastActivityMs = parseIsoToMs(input.lastActivityAt);
  if (lastActivityMs === null) {
    // Running with no activity clock: treat as stalled immediately so the UI
    // never shows endless "Working..." without a recovery affordance.
    return { isStalled: true, silentForMs: thresholdMs };
  }

  const silentForMs = Math.max(0, input.nowMs - lastActivityMs);
  return {
    isStalled: silentForMs >= thresholdMs,
    silentForMs,
  };
}

/** Format a silence duration for stalled-turn copy (e.g. "45s", "3m 20s"). */
export function formatStalledSilenceLabel(silentForMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(silentForMs / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function parseIsoToMs(value: string | null | undefined): number | null {
  if (value == null || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function maxIsoTimestamp(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const ms = parseIsoToMs(value);
    if (ms === null) {
      continue;
    }
    if (ms >= bestMs) {
      bestMs = ms;
      best = value ?? null;
    }
  }
  return best;
}
