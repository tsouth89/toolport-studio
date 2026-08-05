import { describe, expect, it } from "@effect/vitest";

import {
  DISMISSAL_COMMENT,
  DISMISSAL_COMMENT_MAX_LENGTH,
  isVendoredManifestPath,
  parseOpenAlerts,
  partitionVendoredAlerts,
  vendoredPrefixes,
} from "./dismiss-vendored-alerts.ts";

const PREFIXES = [".repos/effect-smol"];

function alert(partial: Partial<Parameters<typeof partitionVendoredAlerts>[0][number]> = {}) {
  return {
    number: 1,
    manifestPath: ".repos/effect-smol/pnpm-lock.yaml",
    packageName: "undici",
    severity: "high",
    ...partial,
  };
}

describe("dismiss-vendored-alerts", () => {
  it("keeps the dismissal comment inside GitHub's limit", () => {
    // A longer body is rejected with HTTP 422, which would silently no-op the
    // whole run.
    expect(DISMISSAL_COMMENT.length).toBeLessThanOrEqual(DISMISSAL_COMMENT_MAX_LENGTH);
  });

  it("derives prefixes from the configured reference repos", () => {
    expect(vendoredPrefixes()).toContain(".repos/effect-smol");
  });

  it("matches manifests inside a vendored prefix", () => {
    expect(isVendoredManifestPath(".repos/effect-smol/pnpm-lock.yaml", PREFIXES)).toBe(true);
    expect(isVendoredManifestPath(".repos/effect-smol/ai-docs/package.json", PREFIXES)).toBe(true);
  });

  it("does not treat a name-stem sibling as vendored", () => {
    // A bare startsWith would sweep this up under the neighbouring prefix.
    expect(isVendoredManifestPath(".repos/effect-smol-fork/package.json", PREFIXES)).toBe(false);
  });

  it("never claims a shipping manifest is vendored", () => {
    expect(isVendoredManifestPath("pnpm-lock.yaml", PREFIXES)).toBe(false);
    expect(isVendoredManifestPath("apps/server/package.json", PREFIXES)).toBe(false);
    expect(isVendoredManifestPath("packages/shared/package.json", PREFIXES)).toBe(false);
  });

  it("leaves non-vendored alerts out of the dismissal set", () => {
    // The property that matters: an advisory against installed code must never
    // be dismissed by this script, whatever else is in the batch.
    const partition = partitionVendoredAlerts(
      [
        alert({ number: 1 }),
        alert({ number: 2, manifestPath: "apps/server/package.json", packageName: "hono" }),
        alert({ number: 3, manifestPath: ".repos/effect-smol/package.json" }),
      ],
      PREFIXES,
    );

    expect(partition.vendored.map((entry) => entry.number)).toEqual([1, 3]);
    expect(partition.other.map((entry) => entry.number)).toEqual([2]);
  });

  it("parses the fields it needs out of the GitHub payload", () => {
    const alerts = parseOpenAlerts(
      JSON.stringify([
        {
          number: 136,
          dependency: {
            package: { ecosystem: "npm", name: "undici" },
            manifest_path: ".repos/effect-smol/pnpm-lock.yaml",
          },
          security_advisory: { severity: "high" },
        },
      ]),
    );

    expect(alerts).toEqual([
      {
        number: 136,
        manifestPath: ".repos/effect-smol/pnpm-lock.yaml",
        packageName: "undici",
        severity: "high",
      },
    ]);
  });

  it("skips entries missing the fields a dismissal needs", () => {
    // Dismissing on a guessed alert number is worse than skipping the row.
    const alerts = parseOpenAlerts(
      JSON.stringify([
        { dependency: { manifest_path: ".repos/effect-smol/pnpm-lock.yaml" } },
        { number: 7 },
        { number: 8, dependency: { manifest_path: ".repos/effect-smol/package.json" } },
      ]),
    );

    expect(alerts.map((entry) => entry.number)).toEqual([8]);
    expect(alerts[0]?.packageName).toBe("unknown");
  });

  it("treats a non-array payload as no alerts", () => {
    expect(parseOpenAlerts(JSON.stringify({ message: "Not Found" }))).toEqual([]);
  });
});
