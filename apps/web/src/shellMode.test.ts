import { describe, expect, it } from "vite-plus/test";
import { isChatOnlyShellHref } from "./shellMode";

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
