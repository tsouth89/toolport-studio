import { describe, expect, it } from "vite-plus/test";

import { trimChars, trimLeadingChars, trimTrailingChars, truncate } from "./String.ts";

describe("trimTrailingChars", () => {
  it("removes a trailing run of the given characters", () => {
    expect(trimTrailingChars("https://example.com///", "/")).toBe("https://example.com");
    expect(trimTrailingChars("C:\\some\\dir\\\\", "\\/")).toBe("C:\\some\\dir");
  });

  it("leaves strings without a trailing run untouched", () => {
    expect(trimTrailingChars("plain", "/")).toBe("plain");
    expect(trimTrailingChars("", "/")).toBe("");
  });

  it("returns empty when the value is entirely trimmable", () => {
    expect(trimTrailingChars("////", "/")).toBe("");
  });

  it("stays linear on a long run that is not at the end", () => {
    // The regex shape this replaces is quadratic on exactly this input.
    const value = `${"/".repeat(50_000)}x`;
    const started = performance.now();
    expect(trimTrailingChars(value, "/")).toBe(value);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("trimLeadingChars", () => {
  it("removes a leading run of the given characters", () => {
    expect(trimLeadingChars("...name", ".")).toBe("name");
    expect(trimLeadingChars("name", ".")).toBe("name");
  });
});

describe("trimChars", () => {
  it("trims both ends", () => {
    expect(trimChars("__name__", "_")).toBe("name");
    expect(trimChars('"quoted"', '"')).toBe("quoted");
  });
});

describe("truncate", () => {
  it("trims surrounding whitespace", () => {
    expect(truncate("   hello world   ")).toBe("hello world");
  });

  it("returns shorter strings unchanged", () => {
    expect(truncate("alpha", 10)).toBe("alpha");
  });

  it("truncates long strings and appends an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcde...");
  });
});
