import { describe, expect, it } from "@effect/vitest";

import type { ServerProvider } from "@toolport-studio/contracts";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@toolport-studio/contracts";

import { BUILT_IN_DRIVERS } from "../../builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "../../Layers/ProviderInstanceRegistryHydration.ts";
import { applyByokIdentity, ByokDriver } from "./ByokDriver.ts";
import { findByokPreset } from "./byokPresets.ts";

const deepseek = findByokPreset("deepseek")!;

const snapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("byok_deepseek"),
  driver: ProviderDriverKind.make("byok"),
  enabled: true,
  installed: true,
  version: "0.146.0",
  status: "ready",
  // What the Codex probe reports for a custom provider block: it has no way
  // to know whether the third party accepted the key.
  auth: { status: "unknown" },
  checkedAt: "2026-08-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

describe("applyByokIdentity", () => {
  it("reports the provider's own key rather than the harness account", () => {
    const result = applyByokIdentity({ preset: deepseek, keyStatus: "valid" })(snapshot);
    expect(result.auth).toEqual({
      status: "authenticated",
      type: "apiKey",
      label: "DeepSeek API Key",
    });
    expect(result.status).toBe("ready");
  });

  it("fails loudly when the key is missing instead of looking healthy", () => {
    // Codex would happily report `ready` here and only fail on the first
    // turn, which is the failure mode this exists to prevent.
    const result = applyByokIdentity({ preset: deepseek, keyStatus: "missing" })(snapshot);
    expect(result.status).toBe("error");
    expect(result.auth).toEqual({ status: "unauthenticated" });
    expect(result.message).toContain("DEEPSEEK_API_KEY");
    expect(result.message).toContain(deepseek.apiKeysUrl);
  });

  it("blames the key when the provider rejects it, not the harness", () => {
    const result = applyByokIdentity({ preset: deepseek, keyStatus: "invalid" })(snapshot);
    expect(result.status).toBe("error");
    expect(result.auth).toEqual({ status: "unauthenticated" });
    expect(result.message).toContain("rejected the API key");
    expect(result.message).toContain("DEEPSEEK_API_KEY");
  });

  it("warns rather than accusing the key when the provider is unreachable", () => {
    // A failed network call says nothing about the credential. Reporting it
    // as invalid would make an offline instance look permanently broken.
    const result = applyByokIdentity({ preset: deepseek, keyStatus: "unknown" })(snapshot);
    expect(result.status).toBe("warning");
    expect(result.auth).toEqual({ status: "unknown" });
    expect(result.message).toContain("Could not reach");
  });

  it("leaves everything else on the snapshot untouched", () => {
    const result = applyByokIdentity({ preset: deepseek, keyStatus: "valid" })(snapshot);
    expect(result.instanceId).toBe(snapshot.instanceId);
    expect(result.version).toBe(snapshot.version);
    expect(result.checkedAt).toBe(snapshot.checkedAt);
  });
});

describe("ByokDriver", () => {
  it("defaults to a preset that exists", () => {
    const config = ByokDriver.defaultConfig();
    expect(findByokPreset(config.preset)).toBeDefined();
  });

  it("supports multiple instances so several providers can coexist", () => {
    expect(ByokDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("is registered as a built-in driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain(ByokDriver.driverKind);
  });

  it("does not synthesize a default instance for every user", () => {
    // Hydration mirrors `settings.providers.<kind>` into a default instance
    // for built-in drivers. BYOK has no legacy mirror on purpose: an
    // auto-created instance would generate a provider home and show an
    // unconfigured, key-less provider to everyone who upgrades.
    const derived = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
    expect(Object.keys(derived)).not.toContain("byok");
  });
});
