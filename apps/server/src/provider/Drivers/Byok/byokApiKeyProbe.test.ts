import { describe, expect, it } from "@effect/vitest";

import { classifyApiKeyResponseStatus, joinProviderUrl } from "./byokApiKeyProbe.ts";

describe("joinProviderUrl", () => {
  it("does not double or drop the separator", () => {
    expect(joinProviderUrl("https://api.deepseek.com/", "models")).toBe(
      "https://api.deepseek.com/models",
    );
    expect(joinProviderUrl("https://api.deepseek.com", "/models")).toBe(
      "https://api.deepseek.com/models",
    );
  });
});

describe("classifyApiKeyResponseStatus", () => {
  it("treats only credential rejections as invalid", () => {
    expect(classifyApiKeyResponseStatus(401)).toBe("invalid");
    expect(classifyApiKeyResponseStatus(403)).toBe("invalid");
  });

  it("accepts any success", () => {
    expect(classifyApiKeyResponseStatus(200)).toBe("valid");
  });

  it("does not blame the key for rate limits or provider outages", () => {
    // 429 means the key worked well enough to be throttled, and 5xx is the
    // provider's problem. Calling either one invalid would send the user off
    // to regenerate a perfectly good key.
    expect(classifyApiKeyResponseStatus(429)).toBe("unknown");
    expect(classifyApiKeyResponseStatus(500)).toBe("unknown");
    expect(classifyApiKeyResponseStatus(503)).toBe("unknown");
  });
});
