import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@toolport-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "./providerStatus";

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make("byok_deepseek"),
    driver: ProviderDriverKind.make("byok"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-08-02T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as ServerProvider;

describe("getProviderSummary", () => {
  it("reports an auth problem as auth, even when the harness never started", () => {
    // A missing key stops the harness from launching, so `installed` stays
    // false. Reporting "Not found" then blames the binary and sends the user
    // hunting for a CLI that is fine.
    const summary = getProviderSummary(
      provider({
        installed: false,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "DeepSeek needs an API key. Add DEEPSEEK_API_KEY ...",
      }),
    );

    expect(summary.headline).toBe("Not authenticated");
    expect(summary.detail).toContain("DEEPSEEK_API_KEY");
  });

  it("still reports a genuinely missing binary as not found", () => {
    const summary = getProviderSummary(provider({ installed: false, auth: { status: "unknown" } }));
    expect(summary.headline).toBe("Not found");
  });

  it("keeps the disabled state ahead of everything else", () => {
    const summary = getProviderSummary(
      provider({ enabled: false, installed: false, auth: { status: "unauthenticated" } }),
    );
    expect(summary.headline).toBe("Disabled");
  });

  it("labels an authenticated provider with its own auth type", () => {
    const summary = getProviderSummary(
      provider({ auth: { status: "authenticated", type: "apiKey", label: "DeepSeek API Key" } }),
    );
    expect(summary.headline).toBe("Authenticated · DeepSeek API Key");
  });
});
