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
});
