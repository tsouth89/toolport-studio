import { BYOK_PRESET_CHOICES } from "@toolport-studio/contracts";
import { describe, expect, it } from "@effect/vitest";

import { BYOK_PRESETS, findByokPreset } from "./byokPresets.ts";

describe("BYOK presets", () => {
  it("offers exactly the presets the settings picker lists", () => {
    // The picker's choices live in contracts and this table lives on the
    // server. A provider in one and not the other is either an unselectable
    // preset or a picker entry that fails with "Unknown BYOK preset".
    expect(BYOK_PRESETS.map((preset) => preset.id).toSorted()).toEqual(
      BYOK_PRESET_CHOICES.map((choice) => choice.value).toSorted(),
    );
  });

  it("labels each preset the same way the picker does", () => {
    for (const choice of BYOK_PRESET_CHOICES) {
      expect(findByokPreset(choice.value)?.label).toBe(choice.label);
    }
  });

  it("agrees with the picker about where each key goes", () => {
    // The wizard offers the key row pre-named from the contracts choice. If
    // it named a variable the server does not read, the user would paste a
    // valid key into a field that does nothing.
    for (const choice of BYOK_PRESET_CHOICES) {
      expect(findByokPreset(choice.value)?.envKey).toBe(choice.envKey);
    }
  });

  it("keeps every model's default effort within its supported set", () => {
    for (const preset of BYOK_PRESETS) {
      for (const model of preset.models) {
        if (model.reasoningEfforts.length === 0) continue;
        expect(model.reasoningEfforts).toContain(model.defaultReasoningEffort);
      }
    }
  });

  it("declares a key variable and a place to get one for every preset", () => {
    for (const preset of BYOK_PRESETS) {
      expect(preset.envKey).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(preset.apiKeysUrl).toMatch(/^https:\/\//);
    }
  });

  it("only sends the API key over HTTPS", () => {
    // baseUrl is where the harness sends the bearer token. Presets are meant
    // to become user-editable data, so a plaintext endpoint would leak the
    // key rather than merely fail.
    for (const preset of BYOK_PRESETS) {
      expect(preset.baseUrl).toMatch(/^https:\/\//);
    }
  });
});
