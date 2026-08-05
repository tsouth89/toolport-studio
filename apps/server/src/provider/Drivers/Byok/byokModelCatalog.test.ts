import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  decodeCatalogModels,
  isAgentCapableModel,
  selectCatalogModels,
  toByokPresetModel,
  toReasoningEfforts,
} from "./byokModelCatalog.ts";
import { findByokPreset, type ByokPresetModel } from "./byokPresets.ts";

const openrouter = findByokPreset("openrouter")!;

const listedModel = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "anthropic/claude-sonnet-5",
    name: "Anthropic: Claude Sonnet 5",
    description: "A model.",
    context_length: 1_000_000,
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: ["tools", "reasoning", "parallel_tool_calls"],
    reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
    ...overrides,
  }) as never;

describe("isAgentCapableModel", () => {
  it("keeps models that can call tools", () => {
    expect(isAgentCapableModel(listedModel())).toBe(true);
  });

  it("drops models without tool support", () => {
    // Codex's whole loop is function calls. A text-only model produces a
    // session that greets the user and fails on the first command, which is
    // worse than the model simply not being offered.
    expect(isAgentCapableModel(listedModel({ supported_parameters: ["temperature"] }))).toBe(false);
    expect(isAgentCapableModel(listedModel({ supported_parameters: undefined }))).toBe(false);
  });
});

describe("toReasoningEfforts", () => {
  it("sorts ascending regardless of the order the provider used", () => {
    // OpenRouter returns these descending; the catalog contract is ascending
    // and their ordering is not guaranteed, so it must be re-derived.
    expect(toReasoningEfforts(["max", "high", "low"])).toEqual(["low", "high", "max"]);
  });

  it("drops effort names the catalog cannot express", () => {
    // Coercing an unknown level would advertise a control the provider
    // ignores, which reads as a setting that silently does nothing.
    expect(toReasoningEfforts(["low", "ultra", "high"])).toEqual(["low", "high"]);
  });

  it("treats a missing reasoning block as no effort control", () => {
    expect(toReasoningEfforts(undefined)).toEqual([]);
  });
});

describe("toByokPresetModel", () => {
  it("takes context window, vision, and efforts from the provider", () => {
    const model = toByokPresetModel(listedModel(), undefined);
    expect(model).toMatchObject({
      slug: "anthropic/claude-sonnet-5",
      displayName: "Anthropic: Claude Sonnet 5",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsParallelToolCalls: true,
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    });
  });

  it("reports text-only models as text-only", () => {
    expect(
      toByokPresetModel(listedModel({ architecture: { input_modalities: ["text"] } }), undefined)
        .supportsVision,
    ).toBe(false);
  });

  it("never claims apply_patch or web search", () => {
    // One OpenRouter slug can land on different backends between requests, so
    // a tool that worked once is not a tool that works.
    const model = toByokPresetModel(listedModel(), undefined);
    expect(model.supportsApplyPatch).toBe(false);
    expect(model.supportsWebSearch).toBe(false);
  });

  it("keeps the default effort inside the supported set", () => {
    // Providers do publish a default outside their own list. Echoing it would
    // produce a catalog entry the picker treats as inconsistent.
    const model = toByokPresetModel(
      listedModel({ reasoning: { supported_efforts: ["high", "low"], default_effort: "medium" } }),
      undefined,
    );
    expect(model.reasoningEfforts).toContain(model.defaultReasoningEffort);
  });

  it("omits a default when the model has no effort control", () => {
    const model = toByokPresetModel(listedModel({ reasoning: undefined }), undefined);
    expect(model.reasoningEfforts).toEqual([]);
    expect(model.defaultReasoningEffort).toBeUndefined();
  });

  it("falls back to the seed for fields the listing omits", () => {
    const seed: ByokPresetModel = {
      slug: "anthropic/claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      description: "Seeded.",
      contextWindow: 200_000,
      reasoningEfforts: [],
      defaultReasoningEffort: undefined,
      supportsVision: false,
      supportsParallelToolCalls: false,
      supportsApplyPatch: false,
      supportsWebSearch: false,
    };
    const model = toByokPresetModel(
      listedModel({ name: undefined, description: undefined, context_length: undefined }),
      seed,
    );
    expect(model.displayName).toBe("Claude Sonnet 5");
    expect(model.contextWindow).toBe(200_000);
  });
});

describe("selectCatalogModels", () => {
  // Selection runs on the normalized catalog, so the tool-capability filter
  // has already been applied by the decoder — `a/text-only` never reaches it.
  const catalog = Option.getOrThrow(
    decodeCatalogModels("openrouter", {
      data: [
        listedModel({ id: "a/one" }),
        listedModel({ id: "a/two" }),
        listedModel({ id: "a/text-only", supported_parameters: ["temperature"] }),
      ],
    }),
  );

  it("returns the requested slugs in the order they were asked for", () => {
    expect(selectCatalogModels({ catalog, slugs: ["a/two", "a/one"] }).map((m) => m.slug)).toEqual([
      "a/two",
      "a/one",
    ]);
  });

  it("skips slugs the provider does not serve instead of failing", () => {
    // Almost always a typo. Refusing to start the whole instance over one bad
    // row in a list of ten is a far worse trade than quietly omitting it.
    expect(selectCatalogModels({ catalog, slugs: ["a/one", "a/typo"] }).map((m) => m.slug)).toEqual(
      ["a/one"],
    );
  });

  it("skips models that cannot call tools", () => {
    expect(selectCatalogModels({ catalog, slugs: ["a/text-only"] })).toEqual([]);
  });

  it("deduplicates a slug the user added that is already a seed", () => {
    expect(selectCatalogModels({ catalog, slugs: ["a/one", "a/one"] }).map((m) => m.slug)).toEqual([
      "a/one",
    ]);
  });
});

describe("the OpenRouter preset", () => {
  it("resolves its lineup at runtime rather than shipping one", () => {
    expect(openrouter.catalog?.kind).toBe("openrouter");
  });

  it("probes an endpoint that actually authenticates", () => {
    // OpenRouter's /models is public and answers 200 to a key that does not
    // exist, so probing it would report every mistyped key as authenticated
    // and defer the failure to the user's first turn.
    expect(openrouter.probePath).toBe("key");
  });

  it("points at the v1 API, not the Anthropic-compatible surface", () => {
    // https://openrouter.ai/api is the Claude harness's path. Pointing Codex
    // at it fails in a way that reads like a bad key.
    expect(openrouter.baseUrl).toBe("https://openrouter.ai/api/v1/");
  });

  it("ships seeds that stand in when the catalog cannot be reached", () => {
    expect(openrouter.models.length).toBeGreaterThan(0);
    for (const model of openrouter.models) {
      expect(model.slug).toContain("/");
    }
  });
});

const vercelModel = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "anthropic/claude-sonnet-5",
    name: "Claude Sonnet 5",
    description: "A model.",
    context_window: 1_000_000,
    modalities: { input: ["text", "image"] },
    supported_parameters: ["tools"],
    reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "high"] }],
    ...overrides,
  }) as never;

describe("the Vercel dialect", () => {
  const decode = (rows: ReadonlyArray<unknown>) =>
    Option.getOrThrow(decodeCatalogModels("vercel", { data: rows }));

  it("reads the fields Vercel names differently", () => {
    // context_window, not context_length; modalities.input, not
    // architecture.input_modalities. Sniffing for one shape would have
    // silently produced a 128K text-only model here.
    expect(decode([vercelModel()])[0]).toMatchObject({
      slug: "anthropic/claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      contextWindow: 1_000_000,
      supportsVision: true,
    });
  });

  it("maps the effort option onto reasoning levels", () => {
    expect(decode([vercelModel()])[0]?.reasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  it("gives a toggle-only model no effort levels rather than inventing two", () => {
    const model = decode([vercelModel({ reasoning_options: [{ type: "toggle" }] })])[0];
    expect(model?.reasoningEfforts).toEqual([]);
    expect(model?.defaultReasoningEffort).toBeUndefined();
  });

  it("defaults to the middle level, not the most expensive one", () => {
    // Vercel publishes no default, so an unasked-for choice should not be the
    // priciest level the model offers.
    expect(decode([vercelModel()])[0]?.defaultReasoningEffort).toBe("medium");
  });

  it("still drops models that cannot call tools", () => {
    expect(decode([vercelModel({ supported_parameters: ["temperature"] })])).toEqual([]);
  });
});

describe("the Vercel preset", () => {
  const vercel = findByokPreset("vercel")!;

  it("speaks the vercel catalog dialect", () => {
    expect(vercel.catalog?.kind).toBe("vercel");
  });

  it("probes an endpoint that requires the key", () => {
    // /v1/models is public here too, so it cannot tell a good key from a typo.
    expect(vercel.probePath).toBe("credits");
  });

  it("keeps every seed's default effort inside its supported set", () => {
    for (const model of vercel.models) {
      if (model.reasoningEfforts.length === 0) {
        expect(model.defaultReasoningEffort).toBeUndefined();
        continue;
      }
      expect(model.reasoningEfforts).toContain(model.defaultReasoningEffort);
    }
  });
});
