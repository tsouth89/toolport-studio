import { describe, expect, it } from "vite-plus/test";

import {
  formatInterjectionText,
  shouldEmitSyntheticFollowUpChrome,
  shouldForceCloseOpenToolsOnSteer,
} from "./InterjectionPolicy.ts";

describe("formatInterjectionText", () => {
  const userText = "dont deploy this one directly";

  it("defaults to raw pass-through when steering", () => {
    expect(formatInterjectionText({ userText, isSteering: true })).toBe(userText);
  });

  it("returns userText for framing raw", () => {
    expect(formatInterjectionText({ userText, isSteering: true, framing: "raw" })).toBe(userText);
  });

  it("prepends abandon-work lead-in only when steering", () => {
    const result = formatInterjectionText({
      userText,
      isSteering: true,
      framing: "abandon-work",
    });
    expect(result).toBe(
      "The user interjected while you were working. Stop the previous plan and prioritize this instruction:\n\n" +
        userText,
    );
  });

  it("never applies abandon-work when not steering", () => {
    expect(
      formatInterjectionText({
        userText,
        isSteering: false,
        framing: "abandon-work",
      }),
    ).toBe(userText);
  });

  it("preserves userText as provided (no forced trim)", () => {
    const spaced = "  keep spaces  ";
    expect(formatInterjectionText({ userText: spaced, isSteering: true })).toBe(spaced);
  });
});

describe("product defaults", () => {
  it("does not emit synthetic follow-up chrome", () => {
    expect(shouldEmitSyntheticFollowUpChrome()).toBe(false);
  });

  it("does not force-close open tools on steer", () => {
    expect(shouldForceCloseOpenToolsOnSteer()).toBe(false);
  });
});
