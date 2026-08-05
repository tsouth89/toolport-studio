import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@toolport-studio/contracts";

import {
  deriveProviderModelsForDisplay,
  resolveProviderInstanceDisplayName,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("resolveProviderInstanceDisplayName", () => {
  const base = {
    explicitName: undefined,
    byokPresetId: undefined,
    driverLabel: "Codex",
    driverKind: "codex",
  };

  it("prefers the name the user typed", () => {
    expect(resolveProviderInstanceDisplayName({ ...base, explicitName: "  Work  " })).toBe("Work");
  });

  it("names an unlabelled API-key instance after its provider, not its driver", () => {
    // One driver serves every preset, so its label is the generic "API Key
    // Provider" — using it would render a DeepSeek and an OpenRouter instance
    // identically in the list they exist to distinguish.
    expect(
      resolveProviderInstanceDisplayName({
        ...base,
        byokPresetId: "openrouter",
        driverLabel: "API Key Provider",
        driverKind: "byok",
      }),
    ).toBe("OpenRouter");
  });

  it("falls back to the driver label for non-preset drivers", () => {
    expect(resolveProviderInstanceDisplayName(base)).toBe("Codex");
  });

  it("falls back to the driver kind when nothing else is known", () => {
    expect(resolveProviderInstanceDisplayName({ ...base, driverLabel: undefined })).toBe("codex");
  });

  it("ignores a preset this build does not know", () => {
    expect(
      resolveProviderInstanceDisplayName({
        ...base,
        byokPresetId: "from-a-newer-build",
        driverLabel: "API Key Provider",
        driverKind: "byok",
      }),
    ).toBe("API Key Provider");
  });
});
