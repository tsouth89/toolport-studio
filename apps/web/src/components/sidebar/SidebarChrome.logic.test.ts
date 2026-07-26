import { describe, expect, it } from "vite-plus/test";
import {
  formatSidebarChromeNavAriaLabel,
  resolveSidebarChromeNavItems,
} from "./SidebarChrome.logic";

describe("resolveSidebarChromeNavItems", () => {
  it("returns the mockup-shaped footer stack in order", () => {
    const items = resolveSidebarChromeNavItems();
    expect(items.map((item) => item.id)).toEqual(["providers", "mcp", "settings", "help"]);
    expect(items[0]).toMatchObject({ kind: "route", target: "/settings/providers" });
    expect(items[1]).toMatchObject({ kind: "external", target: "https://toolport.app" });
    expect(items[2]).toMatchObject({ kind: "route", target: "/settings" });
    expect(items[3]).toMatchObject({ kind: "external", target: "https://toolport.studio" });
  });
});

describe("formatSidebarChromeNavAriaLabel", () => {
  it("marks external destinations for assistive tech", () => {
    expect(formatSidebarChromeNavAriaLabel("Help", "external")).toBe("Help (opens externally)");
    expect(formatSidebarChromeNavAriaLabel("Settings", "route")).toBe("Settings");
  });
});
