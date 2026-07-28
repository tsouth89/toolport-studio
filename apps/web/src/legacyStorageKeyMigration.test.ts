import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The migration ships as an inline <script> in index.html so it runs before
 * hydration — the theme is read in the same block to paint the right
 * background on first frame. That means it cannot be imported, so this test
 * evaluates the real shipped source rather than a copy that could drift.
 */
function runBootScript(initial: Record<string, string>): Record<string, string> {
  const indexHtml = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script || !script.includes("t3code:")) {
    throw new Error("Could not find the pre-hydration boot script in index.html.");
  }

  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  // Object.keys(storage) must enumerate the stored keys, as it does on a real
  // Storage instance.
  const localStorage = new Proxy(storage, {
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });

  const windowStub = {
    localStorage,
    matchMedia: () => ({ matches: false }),
  };
  const documentStub = {
    querySelector: () => null,
    documentElement: { classList: { toggle: () => {}, add: () => {} }, style: {} },
  };

  new Function("window", "document", script)(windowStub, documentStub);
  return Object.fromEntries(store);
}

describe("pre-hydration legacy storage key migration", () => {
  it("renames both legacy prefixes and drops the old keys", () => {
    expect(
      runBootScript({
        "t3code:composer-drafts:v1": "draft",
        "t3code.fileExplorerOpen": "true",
      }),
    ).toEqual({
      "toolport-studio:composer-drafts:v1": "draft",
      "toolport-studio.fileExplorerOpen": "true",
    });
  });

  it("leaves unrelated keys alone", () => {
    expect(runBootScript({ "other:key": "value" })).toEqual({ "other:key": "value" });
  });

  it("does not clobber a value already stored under the new name", () => {
    expect(
      runBootScript({
        "t3code:theme": "stale",
        "toolport-studio:theme": "current",
      }),
    ).toEqual({ "toolport-studio:theme": "current" });
  });

  it("is a no-op on a second run", () => {
    const once = runBootScript({ "t3code:theme": "dark" });
    expect(once).toEqual({ "toolport-studio:theme": "dark" });
    expect(runBootScript(once)).toEqual(once);
  });
});
