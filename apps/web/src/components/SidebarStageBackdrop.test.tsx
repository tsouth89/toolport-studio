import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveSidebarStageBackdropVariant,
  StageBackdropArt,
  StageBackdropButtonArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it.each(["nightly", "dev", "brand"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropButtonArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it("maps alpha/release stages to permanent brand atmosphere (SOU-386)", () => {
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBe("brand");
    expect(resolveSidebarStageBackdropVariant("Latest")).toBe("brand");
    expect(resolveSidebarStageBackdropVariant("")).toBe("brand");
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
  });

  it("renders brand blueprint CSS class for permanent identity", () => {
    const markup = renderToStaticMarkup(<StageBackdropArt variant="brand" />);
    expect(markup).toContain("stage-blueprint-brand");
  });
});
