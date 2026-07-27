/**
 * Core-loop conformance suite entry point (SOU-426).
 *
 * Every provider adapter runs the same contract here. Adding a provider means
 * adding a binding below — the cases live in `runner.ts` and are not
 * per-provider, which is the property that makes a missing behaviour a test
 * failure instead of an undiscovered dogfood bug.
 *
 * Bindings still to land: codex (SOU-421 is expected to surface here as a
 * `send-while-running-has-one-behavior` failure), cursor, grok, opencode.
 */
import { claudeConformanceBinding } from "./bindings/claude.ts";
import { codexConformanceBinding } from "./bindings/codex.ts";
import { cursorConformanceBinding } from "./bindings/cursor.ts";
import { grokConformanceBinding } from "./bindings/grok.ts";
import { openCodeConformanceBinding } from "./bindings/opencode.ts";
import { runCoreLoopConformance } from "./runner.ts";

runCoreLoopConformance(claudeConformanceBinding);
runCoreLoopConformance(codexConformanceBinding);
runCoreLoopConformance(grokConformanceBinding);
runCoreLoopConformance(cursorConformanceBinding);
runCoreLoopConformance(openCodeConformanceBinding);
