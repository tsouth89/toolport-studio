/**
 * Process-local cold-start timing for Toolport Studio desktop.
 *
 * Marks are wall-clock offsets from the earliest module evaluation of this
 * file (imported as early as practical from main.ts). Summary logs help
 * budget work under SOU-359 without requiring full OTEL for day-to-day use.
 */

const originMs = performance.now();
const marks = new Map<string, number>();

/** Well-known mark names used across desktop startup. */
export const ColdStartMark = {
  processStart: "process_start",
  programStart: "program_start",
  electronReady: "electron_ready",
  bootstrapStart: "bootstrap_start",
  backendStartRequested: "backend_start_requested",
  backendReady: "backend_ready",
  mainWindowCreated: "main_window_created",
  mainWindowShown: "main_window_shown",
} as const;

export type ColdStartMarkName = (typeof ColdStartMark)[keyof typeof ColdStartMark] | string;

/** Record a named mark. Returns elapsed ms from process origin. */
export function markColdStart(name: ColdStartMarkName): number {
  const existing = marks.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const elapsedMs = Math.round(performance.now() - originMs);
  marks.set(name, elapsedMs);
  return elapsedMs;
}

export function getColdStartMark(name: ColdStartMarkName): number | undefined {
  return marks.get(name);
}

/** Elapsed ms from origin to now (not a stored mark). */
export function coldStartNowMs(): number {
  return Math.round(performance.now() - originMs);
}

/**
 * Ordered summary of known marks plus any custom marks, as elapsed-ms values.
 * Always includes `origin_ms` (0) for clarity in logs.
 */
export function coldStartSummary(): Record<string, number> {
  const knownOrder: readonly string[] = [
    ColdStartMark.processStart,
    ColdStartMark.programStart,
    ColdStartMark.electronReady,
    ColdStartMark.bootstrapStart,
    ColdStartMark.backendStartRequested,
    ColdStartMark.backendReady,
    ColdStartMark.mainWindowCreated,
    ColdStartMark.mainWindowShown,
  ];

  const summary: Record<string, number> = { origin_ms: 0 };
  for (const name of knownOrder) {
    const value = marks.get(name);
    if (value !== undefined) {
      summary[name] = value;
    }
  }
  for (const [name, value] of marks) {
    if (!(name in summary)) {
      summary[name] = value;
    }
  }
  summary.now_ms = coldStartNowMs();
  return summary;
}

/** Human-readable one-line summary for ops logs. */
export function formatColdStartSummary(
  summary: Record<string, number> = coldStartSummary(),
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(summary)) {
    if (key === "origin_ms") continue;
    parts.push(`${key}=${value}ms`);
  }
  return parts.join(" ");
}

/** Test helper: clear marks without resetting origin. */
export function resetColdStartMarksForTests(): void {
  marks.clear();
}
