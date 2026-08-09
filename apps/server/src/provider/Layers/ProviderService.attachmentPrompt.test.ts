import { describe, expect, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@toolport-studio/contracts";

import { withFileAttachmentPrompt } from "./ProviderService.ts";

const ATTACHMENTS_DIR = "/tmp/attachments";
const FILE_ID = "thread-1-11111111-2222-3333-4444-555555555555";

const fileAttachment = {
  type: "file" as const,
  id: FILE_ID,
  name: "Re_ GageSage setup.eml",
  mimeType: "message/rfc822",
  sizeBytes: 2048,
};

const imageAttachment = {
  type: "image" as const,
  id: "thread-1-99999999-2222-3333-4444-555555555555",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 1024,
};

describe("withFileAttachmentPrompt", () => {
  it("names the file and its path so the agent can read it", () => {
    const result = withFileAttachmentPrompt(
      { input: "what does this say?", attachments: [fileAttachment] },
      ATTACHMENTS_DIR,
    );
    expect(result).not.toBeNull();
    if (result === null) throw new Error("Expected the attachment prompt to fit");

    expect(result.input).toContain("what does this say?");
    // The stored file is `.bin`, so the original name is the only thing telling
    // the agent what it is about to open.
    expect(result.input).toContain("Re_ GageSage setup.eml");
    expect(result.input).toContain(`${FILE_ID}.bin`);
  });

  it("leaves a turn with no file attachments untouched", () => {
    const turn = { input: "hello", attachments: [imageAttachment] };
    // Images are handed to the model as content by each adapter. Describing
    // them here too would double-report them.
    expect(withFileAttachmentPrompt(turn, ATTACHMENTS_DIR)).toBe(turn);
    expect(withFileAttachmentPrompt({ input: "hello" }, ATTACHMENTS_DIR)?.input).toBe("hello");
  });

  it("still describes the file when the user sent no text", () => {
    const result = withFileAttachmentPrompt(
      { input: "", attachments: [fileAttachment] },
      ATTACHMENTS_DIR,
    );
    if (result === null) throw new Error("Expected the attachment prompt to fit");
    expect(result.input).toContain("Re_ GageSage setup.eml");
    expect(result.input.startsWith("\n")).toBe(false);
  });

  it("preserves every other field on the turn", () => {
    const result = withFileAttachmentPrompt(
      { input: "hi", attachments: [fileAttachment], threadId: "thread-1" as never },
      ATTACHMENTS_DIR,
    );
    if (result === null) throw new Error("Expected the attachment prompt to fit");
    expect(result.threadId).toBe("thread-1");
    expect(result.attachments).toHaveLength(1);
  });

  it("rejects a notice that would exceed the provider input limit", () => {
    expect(
      withFileAttachmentPrompt(
        { input: "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS), attachments: [fileAttachment] },
        ATTACHMENTS_DIR,
      ),
    ).toBeNull();
  });
});
