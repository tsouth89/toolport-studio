import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { selectRecommendedModels } from "./modelRecommendations";

describe("model recommendations", () => {
  it("promotes the default and keeps distinct Claude families", () => {
    const models = [
      { slug: "claude-fable-5" },
      { slug: "claude-opus-5", isDefault: true },
      { slug: "claude-opus-4-8" },
      { slug: "claude-sonnet-5" },
      { slug: "claude-haiku-4-5" },
    ];

    expect(
      selectRecommendedModels(ProviderDriverKind.make("claudeAgent"), models).map(
        (model) => model.slug,
      ),
    ).toEqual(["claude-opus-5", "claude-fable-5", "claude-sonnet-5"]);
  });

  it("offers a flagship and compact Codex choice", () => {
    const models = [
      { slug: "gpt-5.5", isDefault: true },
      { slug: "gpt-5.4" },
      { slug: "gpt-5.4-mini" },
      { slug: "gpt-5.3-codex" },
    ];

    expect(
      selectRecommendedModels(ProviderDriverKind.make("codex"), models).map((model) => model.slug),
    ).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });

  it("never recommends custom models and gracefully handles a short catalog", () => {
    const models = [{ slug: "grok-build" }, { slug: "my-private-grok", isCustom: true }];

    expect(
      selectRecommendedModels(ProviderDriverKind.make("grok"), models).map((model) => model.slug),
    ).toEqual(["grok-build"]);
  });
});
