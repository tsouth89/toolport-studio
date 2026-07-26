import { describe, expect, it } from "vite-plus/test";

import {
  appendConversationHistoryText,
  buildConversationRehydrationPrefix,
  orchestrationMessagesToConversationHistory,
} from "./conversationRehydration.ts";

describe("orchestrationMessagesToConversationHistory", () => {
  it("keeps user/assistant text and drops system/empty rows", () => {
    expect(
      orchestrationMessagesToConversationHistory([
        { id: "m1", role: "user", text: " hello " },
        { id: "m2", role: "system", text: "ignore" },
        { id: "m3", role: "assistant", text: "  " },
        { id: "m4", role: "assistant", text: "world" },
      ]),
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);
  });

  it("excludes the message currently being sent", () => {
    expect(
      orchestrationMessagesToConversationHistory(
        [
          { id: "m1", role: "user", text: "prior" },
          { id: "m2", role: "assistant", text: "reply" },
          { id: "m3", role: "user", text: "latest" },
        ],
        { excludeMessageId: "m3" },
      ),
    ).toEqual([
      { role: "user", text: "prior" },
      { role: "assistant", text: "reply" },
    ]);
  });
});

describe("buildConversationRehydrationPrefix", () => {
  it("returns undefined for empty logs", () => {
    expect(buildConversationRehydrationPrefix([])).toBeUndefined();
  });

  it("includes Studio history and a latest-message delimiter", () => {
    const prefix = buildConversationRehydrationPrefix([
      { role: "user", text: "Secret code is zebra-42" },
      { role: "assistant", text: "Got it." },
    ]);
    expect(prefix).toContain("Secret code is zebra-42");
    expect(prefix).toContain("Got it.");
    expect(prefix).toContain("Latest user message:");
    expect(prefix).toContain("Toolport Studio");
  });

  it("prefers newest turns when over the char budget", () => {
    const prefix = buildConversationRehydrationPrefix(
      [
        { role: "user", text: "OLD " + "x".repeat(200) },
        { role: "assistant", text: "mid" },
        { role: "user", text: "NEW " + "y".repeat(50) },
      ],
      { maxChars: 120 },
    );
    expect(prefix).toBeDefined();
    expect(prefix).toContain("NEW");
    expect(prefix).not.toContain("OLD");
  });
});

describe("appendConversationHistoryText", () => {
  it("merges consecutive same-role turns", () => {
    const once = appendConversationHistoryText([], "user", "a");
    const twice = appendConversationHistoryText(once, "user", "b");
    expect(twice).toEqual([{ role: "user", text: "a\nb" }]);
    const withAssistant = appendConversationHistoryText(twice, "assistant", "c");
    expect(withAssistant).toEqual([
      { role: "user", text: "a\nb" },
      { role: "assistant", text: "c" },
    ]);
  });
});
