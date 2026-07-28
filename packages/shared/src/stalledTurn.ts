/**
 * Detect when a provider turn is still marked running but the client has not
 * received stream/orchestration updates for a while.
 *
 * Shared across providers: any adapter that leaves a session "running" while
 * silent will surface the same quiet signal.
 *
 * Product note (SOU-386 / SOU-399): this is a **soft wait notice only**, not a
 * hang kill. Server never silence-kills open tools; post-tool/think use a long
 * (15m) ceiling only when no tool is open. Do not surface Stop on the Working
 * row (composer already has it) and do not auto-interrupt from silence.
 */

/**
 * Default silence window before the Working row shows a calm quiet notice.
 * Raised from 30s so long tools / monitors do not flash every half minute.
 */
export const STALLED_TURN_THRESHOLD_MS = 120_000;

/**
 * When an execute/monitor-style tool is open, suppress the wait notice unless
 * silence exceeds this ceiling. Long tools are expected to be quiet; recovery
 * is the composer Stop control (server does not auto-kill open tools).
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

/**
 * Quiet-clock for the live Working row. Never older than the current work
 * window: after Enter, projection still carries the prior turn's timestamps
 * for a frame, and `?? localDispatchStartedAt` only helped when derivation was
 * null — a 5-minute-old thread.updatedAt still looked like a long wait on
 * Enter until the new turn projected.
 */
export function resolveLiveStreamActivityAt(input: {
  readonly threadUpdatedAt?: string | null;
  readonly sessionUpdatedAt?: string | null;
  readonly latestTurnRequestedAt?: string | null;
  readonly latestTurnStartedAt?: string | null;
  /** Only pass these when the latest turn is still unsettled. */
  readonly includeLatestTurnAnchors?: boolean;
  readonly localDispatchStartedAt?: string | null;
  readonly activeWorkStartedAt?: string | null;
}): string | null {
  const includeLatestTurn = input.includeLatestTurnAnchors !== false;
  // Coalesce to null so exactOptionalPropertyTypes accepts the nested call.
  const fromStream = deriveLastStreamActivityAt({
    threadUpdatedAt: input.threadUpdatedAt ?? null,
    sessionUpdatedAt: input.sessionUpdatedAt ?? null,
    latestTurnRequestedAt: includeLatestTurn ? (input.latestTurnRequestedAt ?? null) : null,
    latestTurnStartedAt: includeLatestTurn ? (input.latestTurnStartedAt ?? null) : null,
  });
  return maxIsoTimestamp(fromStream, input.localDispatchStartedAt, input.activeWorkStartedAt);
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
 * Calm Working-row copy when the stream has been silent for a while.
 * Silence is usually wait (model think / long tool), not a hang — never imply Stop.
 * When an open/last tool title is known, name it so the wait has a subject.
 */
export function formatQuietTurnNotice(
  silentForMs: number,
  options?: {
    readonly activeToolLabel?: string | null;
  },
): string {
  const silence = formatStalledSilenceLabel(silentForMs);
  const toolLabel = options?.activeToolLabel?.trim();
  if (!toolLabel) {
    // No open tool signal: still treat as wait, not failure.
    return `Waiting · no updates for ${silence}`;
  }
  // Open-tool labels are already progressive ("Running git log"), so splice them
  // in as the verb instead of stacking "still running Running git log".
  const progressive = splitProgressiveVerb(toolLabel);
  if (progressive) {
    const { verb, rest } = progressive;
    return rest ? `Waiting · still ${verb} ${rest}` : `Waiting · still ${verb}`;
  }
  return `Waiting · still running ${toolLabel}`;
}

/**
 * Splits "Running git log" into its progressive verb and the remainder.
 *
 * Scanned rather than matched with /^[a-z]+ing\b\s*.*$/i, which is quadratic:
 * on a long run of letters the engine retries the run from every position
 * before the "ing" tail rules it out.
 */
function splitProgressiveVerb(label: string): { verb: string; rest: string } | null {
  let end = 0;
  while (end < label.length && isAsciiLetter(label[end]!)) {
    end++;
  }
  const word = label.slice(0, end);
  if (word.length <= 3 || !word.toLowerCase().endsWith("ing")) {
    return null;
  }
  return { verb: word.toLowerCase(), rest: label.slice(end).trim() };
}

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

function parseIsoToMs(value: string | null | undefined): number | null {
  if (value == null || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

export function maxIsoTimestamp(...values: Array<string | null | undefined>): string | null {
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
