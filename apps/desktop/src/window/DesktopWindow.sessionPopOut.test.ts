import { describe, expect, it } from "vite-plus/test";
import { buildSessionPopOutUrl, sessionPopOutKey } from "./DesktopWindow.ts";

describe("session pop-out URL helpers", () => {
  it("builds a hash route with shell=chat for the thread", () => {
    expect(
      buildSessionPopOutUrl({
        isDevelopment: false,
        environmentId: "local",
        threadId: "thread-abc",
      }),
    ).toBe("toolport-studio://app/#/local/thread-abc?shell=chat");
  });

  it("encodes special characters in ids", () => {
    expect(
      buildSessionPopOutUrl({
        isDevelopment: true,
        environmentId: "env/1",
        threadId: "t id",
      }),
    ).toBe("toolport-studio-dev://app/#/env%2F1/t%20id?shell=chat");
  });

  it("keys pop-outs by environment and thread", () => {
    expect(sessionPopOutKey("a", "b")).toBe("a\0b");
  });
});
