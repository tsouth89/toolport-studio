import { describe, expect, it } from "vite-plus/test";

import { sanitizeStoredActivityPayload } from "./toolActivitySanitize.ts";

const big = (chars: number) => "x".repeat(chars);

describe("sanitizeStoredActivityPayload", () => {
  it("truncates a heavy rawOutput object while keeping presentation fields", () => {
    const stored = JSON.stringify({
      itemType: "tool",
      data: {
        toolCallId: "call_123",
        rawOutput: { content: big(80_000), totalFiles: 12 },
      },
    });

    const next = sanitizeStoredActivityPayload(stored);
    expect(next).not.toBeNull();

    const parsed = JSON.parse(next as string);
    expect(parsed.itemType).toBe("tool");
    expect(parsed.data.toolCallId).toBe("call_123");
    expect(parsed.data.rawOutput._truncated).toBe(true);
    expect((next as string).length).toBeLessThan(stored.length);
  });

  it("leaves rows it cannot understand byte-for-byte alone", () => {
    // A backfill must never rewrite a row whose shape it does not recognise.
    expect(sanitizeStoredActivityPayload("{ not json")).toBeNull();
    expect(sanitizeStoredActivityPayload("[1,2,3]")).toBeNull();
    expect(sanitizeStoredActivityPayload("null")).toBeNull();
    expect(sanitizeStoredActivityPayload(JSON.stringify({ noDataBag: true }))).toBeNull();
    expect(sanitizeStoredActivityPayload(JSON.stringify({ data: "not-an-object" }))).toBeNull();
    expect(sanitizeStoredActivityPayload(JSON.stringify({ data: [1, 2] }))).toBeNull();
  });

  it("skips rows that would not get smaller", () => {
    const small = JSON.stringify({ data: { toolCallId: "call_1", totalFiles: 3 } });

    expect(sanitizeStoredActivityPayload(small)).toBeNull();
  });

  it("is idempotent, so a re-run cannot degrade an already-truncated row", () => {
    const stored = JSON.stringify({
      data: { stdout: big(50_000), toolCallId: "call_9" },
    });

    const once = sanitizeStoredActivityPayload(stored);
    expect(once).not.toBeNull();
    expect(sanitizeStoredActivityPayload(once as string)).toBeNull();
  });

  it("preserves small non-heavy values untouched", () => {
    const stored = JSON.stringify({
      data: { title: "Read file", itemType: "tool", count: 7, ok: true, rawOutput: big(9_000) },
    });

    const parsed = JSON.parse(sanitizeStoredActivityPayload(stored) as string);
    expect(parsed.data.title).toBe("Read file");
    expect(parsed.data.itemType).toBe("tool");
    expect(parsed.data.count).toBe(7);
    expect(parsed.data.ok).toBe(true);
  });
});
