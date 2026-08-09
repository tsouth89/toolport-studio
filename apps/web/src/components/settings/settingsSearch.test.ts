import { describe, expect, it } from "vite-plus/test";

import { searchSettings } from "./settingsSearch";

describe("searchSettings", () => {
  it("matches case-insensitively and ignores diacritics", () => {
    expect(
      searchSettings("THEME", [
        { id: "theme", title: "Thème", to: "/settings/appearance" },
        { id: "providers", title: "Providers", to: "/settings/providers" },
      ]).map((item) => item.id),
    ).toEqual(["theme"]);
  });

  it("returns no results for a blank query", () => {
    expect(searchSettings("   ")).toEqual([]);
  });
});
