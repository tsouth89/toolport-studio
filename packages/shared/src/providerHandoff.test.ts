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

    expect(envelope).toContain("Claude was handling");
    // Say what is present, not what is missing. The first wording said "you do
    // not have its history" and the incoming provider quoted it back as its
    // reason for redoing work it had just been given.
    expect(envelope).toContain("carry on from it rather than starting over");
    expect(envelope).not.toContain("You do not have");
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
    expect(envelope).toContain("Grok was handling");
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

describe("recent exchange", () => {
  const exchange = [
    { role: "user" as const, text: "list the linear projects" },
    { role: "assistant" as const, text: "Toolport Studio, Ceiling, Burnwatch" },
  ];

  it("carries what was answered, not only what was asked", () => {
    // The gap this closes: an informational turn leaves no diff behind, so the
    // reply itself was the entire result. Without it the incoming provider has
    // to redo the work.
    const envelope = buildProviderHandoff({ ...base, recentExchange: exchange });

    expect(envelope).toContain("Toolport Studio, Ceiling, Burnwatch");
    expect(envelope).toContain("Previous assistant:");
  });

  it("keeps only the tail, oldest first", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      text: `message ${index}`,
    }));
    const envelope = buildProviderHandoff({ ...base, recentExchange: many });

    expect(envelope).toContain("message 19");
    expect(envelope).not.toContain("message 0\n");
  });

  it("omits the section when there is nothing to show", () => {
    expect(buildProviderHandoff({ ...base, recentExchange: [] })).not.toContain(
      "How the conversation ended",
    );
    expect(
      buildProviderHandoff({ ...base, recentExchange: [{ role: "user", text: "   " }] }),
    ).not.toContain("How the conversation ended");
  });

  it("stays bounded with a huge exchange", () => {
    const envelope = buildProviderHandoff({
      ...base,
      recentExchange: Array.from({ length: 500 }, () => ({
        role: "assistant" as const,
        text: "z".repeat(10_000),
      })),
    });

    expect(envelope.length).toBeLessThanOrEqual(DEFAULT_PROVIDER_HANDOFF_LIMITS.maxTotalChars);
  });

  it("keeps the newest exchange when other handoff sections exhaust the total budget", () => {
    const newestAnswer = "LATEST_ASSISTANT_RESULT";
    const envelope = buildProviderHandoff({
      ...base,
      firstUserMessage: "f".repeat(50_000),
      lastUserMessage: "l".repeat(50_000),
      diffStat: "d".repeat(50_000),
      filesInPlay: Array.from({ length: 5_000 }, (_, index) => `src/file-${index}.ts`),
      recentExchange: [
        { role: "user", text: "u".repeat(10_000) },
        { role: "assistant", text: newestAnswer },
      ],
    });

    expect(envelope).toContain(newestAnswer);
    expect(envelope.length).toBeLessThanOrEqual(DEFAULT_PROVIDER_HANDOFF_LIMITS.maxTotalChars);
  });
});
