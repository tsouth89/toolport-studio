import { describe, expect, it } from "vite-plus/test";

import {
  ColdStartMark,
  coldStartSummary,
  formatColdStartSummary,
  getColdStartMark,
  markColdStart,
  resetColdStartMarksForTests,
} from "./DesktopColdStart.ts";

describe("DesktopColdStart", () => {
  it("records first mark only and builds a summary", () => {
    resetColdStartMarksForTests();

    const first = markColdStart(ColdStartMark.processStart);
    const second = markColdStart(ColdStartMark.processStart);
    expect(second).toBe(first);
    expect(getColdStartMark(ColdStartMark.processStart)).toBe(first);

    markColdStart(ColdStartMark.electronReady);
    const summary = coldStartSummary();
    expect(summary.origin_ms).toBe(0);
    expect(summary.process_start).toBe(first);
    expect(typeof summary.electron_ready).toBe("number");
    expect(typeof summary.now_ms).toBe("number");

    const formatted = formatColdStartSummary(summary);
    expect(formatted).toContain("process_start=");
    expect(formatted).toContain("electron_ready=");
  });
});
