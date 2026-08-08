/**
 * Core-loop conformance suite entry point (SOU-426).
 *
 * Every provider adapter runs the same contract here. Adding a provider means
 * adding a binding below — the cases live in `runner.ts` and are not
 * per-provider, which is the property that makes a missing behaviour a test
 * failure instead of an undiscovered dogfood bug.
 *
 * The registry guard below keeps the suite aligned with the drivers shipped
 * by the server. A driver may share an adapter family (BYOK uses Codex), but
 * it cannot disappear from conformance by omission.
 */
import { assert, describe, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import type { BuiltInTurnEngineProvider } from "../turnEngine/index.ts";
import { claudeConformanceBinding } from "./bindings/claude.ts";
import { codexConformanceBinding } from "./bindings/codex.ts";
import { cursorConformanceBinding } from "./bindings/cursor.ts";
import { grokConformanceBinding } from "./bindings/grok.ts";
import { openCodeConformanceBinding } from "./bindings/opencode.ts";
import type { ConformanceBinding } from "./contract.ts";
import { runCoreLoopConformance } from "./runner.ts";

const CONFORMANCE_BINDINGS = {
  claudeAgent: claudeConformanceBinding,
  codex: codexConformanceBinding,
  cursor: cursorConformanceBinding,
  grok: grokConformanceBinding,
  opencode: openCodeConformanceBinding,
} satisfies Record<BuiltInTurnEngineProvider, ConformanceBinding>;

const DRIVER_CONFORMANCE_ALIASES = {
  byok: "codex",
} as const satisfies Readonly<Record<string, BuiltInTurnEngineProvider>>;

describe("core-loop conformance registry", () => {
  it("covers every shipped driver directly or through an explicit adapter-family alias", () => {
    const bindingKeys = new Set<string>(Object.keys(CONFORMANCE_BINDINGS));
    const uncovered = BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)).filter(
      (driverKind) =>
        !bindingKeys.has(driverKind) &&
        !Object.prototype.hasOwnProperty.call(DRIVER_CONFORMANCE_ALIASES, driverKind),
    );

    assert.deepEqual(uncovered, []);
  });
});

for (const binding of Object.values(CONFORMANCE_BINDINGS)) {
  runCoreLoopConformance(binding);
}
