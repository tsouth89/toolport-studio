import { describe, expect, it } from "vite-plus/test";

import { formatCodexProtocolLogPayload } from "./CodexNativeLogging.ts";

describe("formatCodexProtocolLogPayload", () => {
  it("records frame shape and the method name, never the contents", () => {
    // The method name is what identifies a dropped notification; the params
    // carry prompt text and must not reach the log.
    const formatted = formatCodexProtocolLogPayload({
      direction: "incoming",
      stage: "decoded",
      payload: { method: "turn/started", params: { secret: "prompt text" } },
    });

    expect(formatted).toEqual({
      direction: "incoming",
      stage: "decoded",
      payload: { valueType: "object", fieldCount: 2, method: "turn/started" },
    });
    expect(JSON.stringify(formatted)).not.toContain("prompt text");
  });

  it("reduces a raw frame to its byte length", () => {
    expect(
      formatCodexProtocolLogPayload({
        direction: "incoming",
        stage: "raw",
        payload: '{"method":"item/agentMessage/delta"}',
      }),
    ).toEqual({
      direction: "incoming",
      stage: "raw",
      payload: { valueType: "string", byteLength: 36 },
    });
  });

  it("keeps decode_failed distinguishable from a frame that never arrived", () => {
    const formatted = formatCodexProtocolLogPayload({
      direction: "incoming",
      stage: "decode_failed",
      payload: { method: "turn/completed" },
    });

    expect(formatted.stage).toBe("decode_failed");
    expect(formatted.payload).toMatchObject({ method: "turn/completed" });
  });

  it("refuses to echo a method name that is not method-shaped", () => {
    expect(
      formatCodexProtocolLogPayload({
        direction: "outgoing",
        stage: "decoded",
        payload: { method: "not a method\nwith newlines" },
      }).payload,
    ).toMatchObject({ method: "unknown" });
  });
});
