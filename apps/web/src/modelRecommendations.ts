import type { ProviderDriverKind } from "@t3tools/contracts";

export interface RecommendationCandidate {
  readonly slug: string;
  readonly isCustom?: boolean | undefined;
  readonly isDefault?: boolean | undefined;
}

function recommendationLimit(provider: ProviderDriverKind): number {
  switch (provider) {
    case "claudeAgent":
    case "cursor":
    case "opencode":
      return 3;
    case "codex":
      return 2;
    case "grok":
      return 1;
    default:
      return 2;
  }
}

function modelFamily(provider: ProviderDriverKind, slug: string): string {
  const normalized = slug.toLowerCase().replace(/\[.*$/u, "");

  if (provider === "claudeAgent") {
    return normalized.match(/^claude-(fable|opus|sonnet|haiku)/u)?.[1] ?? normalized;
  }

  if (provider === "codex") {
    if (normalized.includes("mini")) return "mini";
    if (normalized.includes("nano")) return "nano";
    if (normalized.includes("codex")) return "codex";
    return "flagship";
  }

  if (normalized === "auto" || normalized === "default") return "auto";
  if (normalized.includes("composer")) return "composer";
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("gpt") || normalized.includes("codex")) return "openai";
  if (normalized.includes("grok")) return "grok";

  return normalized.split(/[/:_-]/u, 1)[0] || normalized;
}

/**
 * Builds a compact recommendation set from the live provider catalog.
 *
 * Provider catalogs are already ordered newest/preferred first. We keep that
 * ordering, promote the provider's declared default, and favor distinct model
 * families so the shortlist offers meaningful choices instead of three older
 * revisions of the same model.
 */
export function selectRecommendedModels<T extends RecommendationCandidate>(
  provider: ProviderDriverKind,
  models: ReadonlyArray<T>,
): T[] {
  const limit = recommendationLimit(provider);
  const eligible = models.filter((model) => !model.isCustom);
  const selected: T[] = [];
  const selectedSlugs = new Set<string>();
  const selectedFamilies = new Set<string>();

  const add = (model: T | undefined) => {
    if (!model || selectedSlugs.has(model.slug) || selected.length >= limit) return;
    selected.push(model);
    selectedSlugs.add(model.slug);
    selectedFamilies.add(modelFamily(provider, model.slug));
  };

  add(eligible.find((model) => model.isDefault));

  for (const model of eligible) {
    if (selected.length >= limit) break;
    if (!selectedFamilies.has(modelFamily(provider, model.slug))) {
      add(model);
    }
  }

  for (const model of eligible) {
    if (selected.length >= limit) break;
    add(model);
  }

  return selected;
}
