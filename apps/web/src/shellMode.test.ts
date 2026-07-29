import { describe, expect, it } from "vite-plus/test";
import { isChatOnlyShellHref, isChatOnlyShellWindow } from "./shellMode";

describe("isChatOnlyShellHref", () => {
  it("detects shell=chat on hash routes used by Electron", () => {
    expect(isChatOnlyShellHref("toolport-studio://app/#/env-1/thread-1?shell=chat")).toBe(true);
    expect(isChatOnlyShellHref("toolport-studio://app/#/env-1/thread-1?foo=1&shell=chat")).toBe(
      true,
    );
  });

  it("returns false for normal app URLs", () => {
    expect(isChatOnlyShellHref("toolport-studio://app/#/env-1/thread-1")).toBe(false);
    expect(isChatOnlyShellHref("http://localhost:5173/env-1/thread-1")).toBe(false);
  });
});

describe("isChatOnlyShellWindow", () => {
  it("is safe without a DOM and stable across calls", () => {
    // Resolved once at module load. Without a window there is nothing to read,
    // and it must not throw — this module is imported from render paths that
    // also run outside the browser.
    const first = isChatOnlyShellWindow();

    expect(typeof first).toBe("boolean");
    expect(isChatOnlyShellWindow()).toBe(first);
  });
});
