import { describe, expect, it } from "vite-plus/test";

import {
  appearanceFontStack,
  clampCodeFontSize,
  clampInterfaceFontSize,
  cssFontFamilies,
} from "./appearanceFonts";

describe("appearance fonts", () => {
  it("quotes multi-word family names and keeps fallback coverage", () => {
    expect(cssFontFamilies("Segoe UI, Inter")).toBe('"Segoe UI", Inter');
    expect(appearanceFontStack("Cascadia Mono", "monospace")).toBe('"Cascadia Mono", monospace');
  });

  it("clamps sizes to layout-safe ranges", () => {
    expect(clampInterfaceFontSize(99)).toBe(20);
    expect(clampCodeFontSize(1)).toBe(10);
  });
});
