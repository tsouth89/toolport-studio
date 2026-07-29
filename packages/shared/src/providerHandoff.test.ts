import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderHandoff,
  DEFAULT_PROVIDER_HANDOFF_LIMITS,
  summariseFilesInPlay,
} from "./providerHandoff.ts";

const base = {
  previousProviderLabel: "Claude",
  firstUserMessage: "Add rate limiting to the upload endpoint",
  lastUserMessage: "Now cover the batch route too",
  branch: "feat/rate-limit",
  cwd: "/repo",
  diffStat: " src/upload.ts | 42 ++++++\n 1 file changed",
  filesInPlay: ["src/upload.ts", "src/limiter.ts"],
};

describe("summariseFilesInPlay", () => {
  it("dedupes while keeping first-seen order", () => {
    // Checkpoints record files per turn, so a file edited across ten turns
    // arrives ten times.
    expect(summariseFilesInPlay(["a.ts", "b.ts", "a.ts", "c.ts", "b.ts"], 10)).toEqual({
      files: ["a.ts", "b.ts", "c.ts"],
      omitted: 0,
    });
  });

  it("caps and reports how many were dropped", () => {
    expect(summariseFilesInPlay(["a", "b", "c", "d"], 2)).toEqual({
      files: ["a", "b"],
      omitted: 2,
    });
  });

  it("ignores blank entries and handles nothing to summarise", () => {
    expect(summariseFilesInPlay(["  ", "a.ts", ""], 10).files).toEqual(["a.ts"]);
    expect(summariseFilesInPlay(null, 10)).toEqual({ files: [], omitted: 0 });
    expect(summariseFilesInPlay(["a"], 0)).toEqual({ files: [], omitted: 0 });
  });
});

describe("buildProviderHandoff", () => {
  it("states what it is and is not", () => {
    const envelope = buildProviderHandoff(base);

    expect(envelope).toContain("was being handled by Claude");
    // The receiving model must not assume it has the conversation.
    expect(envelope).toContain("You do not have its history");
    expect(envelope).toContain("not a transcript");
  });

  it("includes intent, workspace, diff, and files", () => {
    const envelope = buildProviderHandoff(base);

    expect(envelope).toContain("Add rate limiting to the upload endpoint");
    expect(envelope).toContain("Now cover the batch route too");
    expect(envelope).toContain("Branch: feat/rate-limit");
    expect(envelope).toContain("1 file changed");
    expect(envelope).toContain("- src/limiter.ts");
  });

  it("does not repeat a single request twice", () => {
    // A one-turn thread has the same first and last message.
    const envelope = buildProviderHandoff({
      ...base,
      lastUserMessage: base.firstUserMessage,
    });

    expect(envelope).toContain("## Original request");
    expect(envelope).not.toContain("## Most recent request");
  });

  it("omits sections it has no data for rather than emitting empty headings", () => {
    const envelope = buildProviderHandoff({ previousProviderLabel: "Grok" });

    expect(envelope).not.toContain("## Original request");
    expect(envelope).not.toContain("## Workspace");
    expect(envelope).not.toContain("## Uncommitted changes");
    expect(envelope).not.toContain("## Files touched so far");
    expect(envelope).toContain("was being handled by Grok");
  });

  it("stays bounded regardless of thread age", () => {
    // The property that matters: a huge thread must not produce a huge
    // envelope, which is the whole reason for not replaying the transcript.
    const envelope = buildProviderHandoff({
      previousProviderLabel: "Codex",
      firstUserMessage: "x".repeat(50_000),
      lastUserMessage: "y".repeat(50_000),
      diffStat: "z".repeat(50_000),
      filesInPlay: Array.from({ length: 5_000 }, (_, index) => `src/file-${index}.ts`),
    });

    expect(envelope.length).toBeLessThanOrEqual(DEFAULT_PROVIDER_HANDOFF_LIMITS.maxTotalChars);
  });

  it("marks truncated content instead of ending mid-sentence", () => {
    const envelope = buildProviderHandoff(
      { previousProviderLabel: "Codex", firstUserMessage: "a".repeat(500) },
      { ...DEFAULT_PROVIDER_HANDOFF_LIMITS, maxMessageChars: 50 },
    );

    expect(envelope).toContain("...");
    expect(envelope).not.toContain("a".repeat(51));
  });

  it("is deterministic, so the preview matches what is sent", () => {
    expect(buildProviderHandoff(base)).toBe(buildProviderHandoff(base));
  });

  it("tells the receiving model to verify rather than trust the summary", () => {
    expect(buildProviderHandoff(base)).toContain("Read the code and the diff directly");
  });
});
