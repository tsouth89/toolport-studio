import { describe, expect, it } from "@effect/vitest";

import {
  classifyApiKeyResponseStatus,
  DEFAULT_PROBE_PATH,
  joinProviderUrl,
} from "./byokApiKeyProbe.ts";
import { BYOK_PRESETS } from "./byokPresets.ts";

describe("preset probe endpoints", () => {
  it("probes an endpoint that requires the key", () => {
    // The failure mode here is silent. OpenRouter serves its model listing
    // publicly and answers 200 to a key that does not exist, so a preset that
    // probed the default `models` path would mark every mistyped key
    // authenticated and only fail on the user's first turn.
    const publicListings = new Set(["https://openrouter.ai/api/v1/"]);
    for (const preset of BYOK_PRESETS) {
      if (!publicListings.has(preset.baseUrl)) continue;
      expect(preset.probePath, `${preset.id} probes a public endpoint`).toBeDefined();
      expect(preset.probePath).not.toBe(DEFAULT_PROBE_PATH);
    }
  });
});

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
