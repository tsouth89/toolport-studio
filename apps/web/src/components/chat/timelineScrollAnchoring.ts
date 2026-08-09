export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

export interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
  readonly anchorTop: number;
  readonly lastBottom: number;
  readonly turnHeight: number;
  readonly usableViewportHeight: number;
  readonly visibleUsableBottom: number;
  readonly overflowsUsableViewport: boolean;
  readonly targetScrollToRevealEnd: number;
  readonly scrollDeltaToRevealEnd: number;
}

export interface TimelineEndConvergenceState {
  readonly previousEnd: number | null;
  readonly stableFrames: number;
}

export function advanceTimelineEndConvergence(
  state: TimelineEndConvergenceState,
  currentEnd: number | null,
  requiredStableFrames: number,
): TimelineEndConvergenceState & { readonly settled: boolean } {
  const stableFrames =
    currentEnd !== null &&
    state.previousEnd !== null &&
    Math.abs(currentEnd - state.previousEnd) < 1
      ? state.stableFrames + 1
      : 0;
  return {
    previousEnd: currentEnd,
    stableFrames,
    settled: stableFrames >= requiredStableFrames,
  };
}

export function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * LegendList resolves a scrollToEnd target through `state.positions[index] || 0`,
 * so a last row whose position has not been computed yet resolves to offset 0 —
 * the top of the thread — instead of the end. Positions are filled lazily and the
 * fill loop breaks a few rows past the visible area, so only virtualized (long)
 * threads reach that state, and only in the frames right after a row is appended.
 * The library's own readiness gate for this only arms when `anchoredEndSpace` is
 * set, which the timeline does not use.
 */
export function isTimelineEndPositionKnown(state: TimelineListMeasurementState): boolean {
  const lastIndex = state.data.length - 1;
  if (lastIndex < 0) {
    return false;
  }

  const lastTop = state.positionAtIndex(lastIndex);
  return typeof lastTop === "number" && Number.isFinite(lastTop);
}

export function getAnchoredTurnMetrics({
  state,
  anchorIndex,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly state: TimelineListMeasurementState;
  readonly anchorIndex: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): AnchoredTurnMetrics | null {
  if (state.data.length === 0) {
    return null;
  }

  const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
  const anchorTop = state.positionAtIndex(boundedAnchorIndex);
  const lastBottom = getRowBottom(state, state.data.length - 1);
  if (typeof anchorTop !== "number" || !Number.isFinite(anchorTop) || lastBottom === null) {
    return null;
  }

  const usableViewportHeight = Math.max(
    0,
    state.scrollLength - composerOverlayHeight - anchorOffset,
  );
  const turnHeight = Math.max(0, lastBottom - anchorTop);
  const visibleUsableBottom = state.scroll + usableViewportHeight;
  const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
  const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

  return {
    anchorTop,
    lastBottom,
    turnHeight,
    usableViewportHeight,
    visibleUsableBottom,
    overflowsUsableViewport: turnHeight > usableViewportHeight,
    targetScrollToRevealEnd,
    scrollDeltaToRevealEnd,
  };
}
