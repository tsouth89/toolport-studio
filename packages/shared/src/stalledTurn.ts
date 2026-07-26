/**
 * Detect when a provider turn is still marked running but the client has not
 * received stream/orchestration updates for a while.
 *
 * Shared across providers: any adapter that leaves a session "running" while
 * silent will surface the same quiet signal.
 *
 * Product note (SOU-386 / SOU-399): this is a **soft quiet notice only**, not a
 * hang kill. Server never silence-kills open tools; post-tool/think use a long
 * (15m) ceiling only when no tool is open. Do not add a second client-side
 * interrupt here. Hard recovery is user Stop + ACP process death settlement.
 */

/**
 * Default silence window before the Working row shows a calm quiet notice.
 * Raised from 30s so long tools / monitors do not flash every half minute.
 */
export const STALLED_TURN_THRESHOLD_MS = 120_000;

/**
 * When an execute/monitor-style tool is open, suppress the quiet notice unless
 * silence exceeds this ceiling. Long tools are expected to be quiet; user Stop
 * is the recovery path (server does not auto-kill open tools).
 */
export const STALLED_TURN_LONG_RUNNING_THRESHOLD_MS = 10 * 60_000;

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

export function resolveStalledTurnThresholdMs(input: {
  readonly hasLongRunningOpenTool?: boolean;
}): number {
  return input.hasLongRunningOpenTool
    ? STALLED_TURN_LONG_RUNNING_THRESHOLD_MS
    : STALLED_TURN_THRESHOLD_MS;
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
    // Running with no activity clock: treat as quiet immediately so the UI
    // can still show calm recovery copy if needed.
    return { isStalled: true, silentForMs: thresholdMs };
  }

  const silentForMs = Math.max(0, input.nowMs - lastActivityMs);
  return {
    isStalled: silentForMs >= thresholdMs,
    silentForMs,
  };
}

/** Format a silence duration for quiet-turn copy (e.g. "45s", "3m 20s"). */
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

/**
 * Calm Working-row copy — no panic language, no auto-kill.
 * When an open/last tool title is known, name it so the user can tell quiet
 * long work from a blank hang.
 */
export function formatQuietTurnNotice(
  silentForMs: number,
  options?: {
    readonly activeToolLabel?: string | null;
  },
): string {
  const base = `Quiet for ${formatStalledSilenceLabel(silentForMs)}`;
  const toolLabel = options?.activeToolLabel?.trim();
  if (!toolLabel) {
    return base;
  }
  return `${base} · still running ${toolLabel}`;
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
