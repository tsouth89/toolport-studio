/**
 * BYOK presets — provider descriptions as data, not code.
 *
 * A preset says everything Toolport Studio needs in order to run a
 * third-party, API-key-authenticated model provider through a harness we
 * already ship: which endpoint to talk to, which wire protocol it speaks,
 * which environment variable carries the key, and what its models can
 * actually do.
 *
 * Adding a provider should be a new entry in {@link BYOK_PRESETS}, never a
 * new driver. The long-term intent is to load these from user-editable JSON
 * on disk (third-party lineups churn faster than our release cadence — e.g.
 * DeepSeek retired `deepseek-chat`/`deepseek-reasoner` in July 2026), so
 * keep this module free of behavior: values only.
 *
 * @module provider/Drivers/Byok/byokPresets
 */

import { BYOK_PRESET_CHOICES } from "@toolport-studio/contracts";

/**
 * Wire protocol a preset speaks, which in turn decides the harness.
 *
 * Only `responses` is implemented today (codex app-server). `anthropic`
 * (Claude Agent SDK) is the next family; it additionally needs per-model
 * capability descriptors to survive the snapshot, which the Claude driver
 * cannot express yet because its catalog is a module-level constant.
 */
export type ByokWireFormat = "responses";

/**
 * Reasoning effort levels are declared **per model**, never per provider.
 *
 * DeepSeek's API reference is explicit that availability differs between
 * models in the same family: `deepseek-v4-flash` accepts low/high/max while
 * `deepseek-v4-pro` "temporarily supports only `high` and `max`". Vendors
 * lift these limits without warning, which is another reason presets want to
 * be editable data rather than a shipped constant.
 */
export type ByokReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ByokPresetModel {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  /** Total context window in tokens. Drives auto-compaction thresholds. */
  readonly contextWindow: number;
  /**
   * Effort levels this specific model honors, in ascending order. Empty
   * means the model exposes no reasoning control at all.
   */
  readonly reasoningEfforts: ReadonlyArray<ByokReasoningEffort>;
  /** Must appear in {@link reasoningEfforts} when that list is non-empty. */
  readonly defaultReasoningEffort: ByokReasoningEffort | undefined;
  /**
   * Whether the model accepts image input. When false the harness is told
   * text-only, but note that this does **not** by itself stop an attachment
   * from being sent — see `ByokHome` docs.
   */
  readonly supportsVision: boolean;
  /** Provider executes tool calls in parallel and cannot be asked not to. */
  readonly supportsParallelToolCalls: boolean;
  /** Provider implements the `apply_patch` custom tool for Codex. */
  readonly supportsApplyPatch: boolean;
  /** Provider offers server-side web search. */
  readonly supportsWebSearch: boolean;
}

/**
 * How a preset's model list is obtained.
 *
 * Most providers ship a lineup small enough to write down, and {@link
 * ByokPreset.models} is the whole story. A router is not a provider though:
 * OpenRouter fronts hundreds of models from dozens of vendors and changes the
 * set weekly, so a literal array would be stale before the release ships.
 *
 * This stays a tagged *descriptor* rather than a function so this module
 * keeps its promise to hold values only — the fetching and mapping live in
 * `byokModelCatalog.ts`, which switches on `kind`. That is also what lets
 * presets move to user-editable JSON later without smuggling code into it.
 */
export interface ByokPresetCatalog {
  /**
   * Which listing dialect the endpoint speaks. Every gateway publishes the
   * same facts under different names — OpenRouter's `context_length` is
   * Vercel's `context_window`, its `architecture.input_modalities` is
   * `modalities.input` — so the shape has to be named, not sniffed.
   */
  readonly kind: "openrouter" | "vercel";
  /** Absolute URL of the provider's model listing endpoint. */
  readonly url: string;
}

export interface ByokPreset {
  /** Stable id persisted in instance config. Never rename in place. */
  readonly id: string;
  readonly label: string;
  readonly wireFormat: ByokWireFormat;
  /**
   * Base URL handed to the harness. For the `responses` family Codex POSTs
   * to `{baseUrl}/responses`, so a trailing path segment matters.
   */
  readonly baseUrl: string;
  /**
   * Environment variable the harness reads the API key from. Studio holds
   * the value in its secret store and injects it into the provider process;
   * it is never written into generated config on disk.
   */
  readonly envKey: string;
  /** Where a user goes to create a key. Surfaced in setup errors. */
  readonly apiKeysUrl: string;
  /**
   * Path under {@link baseUrl} that the key probe authenticates against.
   *
   * Defaults to `models` because the OpenAI-compatible listing requires a
   * bearer token almost everywhere. OpenRouter is the exception that forces
   * this to be configurable: its `/models` is public and answers 200 to a
   * garbage key, which would report every mistyped key as authenticated.
   */
  readonly probePath?: string;
  /**
   * Models this preset offers without any network call.
   *
   * For a static provider this is the complete lineup. For one with a {@link
   * catalog} it is the seed shown on a fresh instance, and doubles as the
   * offline fallback when the catalog cannot be reached.
   */
  readonly models: ReadonlyArray<ByokPresetModel>;
  /**
   * Present when the real lineup is fetched at runtime. Seeds and any models
   * the user added on the instance are resolved through it so their metadata
   * (context window, effort levels, vision) comes from the provider rather
   * than from a guess baked into this file.
   */
  readonly catalog?: ByokPresetCatalog;
}

const DEEPSEEK: ByokPreset = {
  id: "deepseek",
  label: "DeepSeek",
  wireFormat: "responses",
  // DeepSeek serves the Responses API at the root, so Codex resolves this to
  // https://api.deepseek.com/responses.
  baseUrl: "https://api.deepseek.com/",
  envKey: "DEEPSEEK_API_KEY",
  apiKeysUrl: "https://platform.deepseek.com/api_keys",
  models: [
    {
      slug: "deepseek-v4-flash",
      displayName: "DeepSeek-V4-Flash",
      description: "Fast frontier agentic coding model.",
      contextWindow: 1_000_000,
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
      // V4 has no vision through the API. The Responses endpoint documents
      // replacing image input with placeholder text rather than rejecting it.
      supportsVision: false,
      supportsParallelToolCalls: true,
      supportsApplyPatch: true,
      supportsWebSearch: true,
    },
    // deepseek-v4-pro is deliberately absent. DeepSeek's own Codex
    // integration says Pro support on the Responses API is not live yet and
    // to use Flash instead, and an unrecognized model name is silently
    // downgraded rather than rejected — so listing Pro would offer a model
    // that quietly answers as Flash. Restore it (efforts: high, max) once
    // DeepSeek ships it.
  ],
};

/**
 * Seed lineup for OpenRouter.
 *
 * Every field here is a fallback, not a fact: the catalog resolver overwrites
 * all of it from `/api/v1/models` on instance start. The values are kept
 * truthful anyway so an instance that starts offline offers something usable
 * rather than lying about context windows.
 *
 * `supportsApplyPatch` and `supportsWebSearch` are deliberately false for
 * every OpenRouter model, including ones whose upstream vendor supports them.
 * Both are OpenAI-shaped tool types, and OpenRouter routes a single slug to
 * whichever backend has capacity — so a tool that works on one request can
 * fail on the next. Codex falls back to its shell-based patch path, which
 * works everywhere. Revisit per model once the Responses beta stabilizes.
 */
const OPENROUTER_SEED_MODELS: ReadonlyArray<ByokPresetModel> = [
  {
    // OpenRouter's own meta-model: it classifies each prompt and picks a
    // model per request. This is the thing OpenRouter is named for, so it
    // belongs in the lineup — but it is a different bargain from the rest.
    //
    // It publishes no reasoning efforts, so the effort control disappears for
    // this model rather than silently doing nothing, and its pricing is "-1"
    // (whatever the chosen model costs). The routing is per request, so a
    // long session can change models underneath itself; some models handle a
    // multi-turn tool loop poorly, and this cannot promise you avoid them.
    // Good for exploration, not for a run you need to be reproducible.
    slug: "openrouter/auto",
    displayName: "Auto Router",
    description: "OpenRouter picks a model per prompt. No effort control; cost varies by pick.",
    contextWindow: 2_000_000,
    reasoningEfforts: [],
    defaultReasoningEffort: undefined,
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    // Same idea as Auto Router, different selection rule: it classifies the
    // task and picks whatever the market spends most on for that task.
    slug: "openrouter/auto-beta",
    displayName: "Auto Router (Beta)",
    description: "Task-aware routing by aggregate spend. No effort control; cost varies by pick.",
    contextWindow: 2_000_000,
    reasoningEfforts: [],
    defaultReasoningEffort: undefined,
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    // Free inference without pinning a specific donated backend: it picks a
    // free model at random per request. That spreads the risk one bad backend
    // creates, but it also means a session can land on a model that cannot
    // survive a multi-turn tool loop — the failure we already hit on
    // `openai/gpt-oss-20b:free`. The named free seed below is the predictable
    // one; this is the convenient one. Both share the same daily free cap.
    slug: "openrouter/free",
    displayName: "Free Models Router",
    description: "Routes to a random free model. Rate limited; picks vary per request.",
    contextWindow: 200_000,
    reasoningEfforts: [],
    defaultReasoningEffort: undefined,
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "anthropic/claude-opus-5",
    displayName: "Claude Opus 5",
    description: "Anthropic flagship. Strongest at long multi-step work.",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    description: "Balanced Anthropic model for everyday agentic coding.",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "openai/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    description: "OpenAI flagship. Strong at command-line and multi-step coding.",
    contextWindow: 1_050_000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "openai/gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    description: "Balanced OpenAI model for everyday coding and reasoning.",
    contextWindow: 1_050_000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "google/gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    description: "Fast long-context model with vision.",
    contextWindow: 1_048_576,
    reasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "medium",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash 0423",
    description: "Fast frontier agentic coding model.",
    contextWindow: 1_048_576,
    reasoningEfforts: ["high", "xhigh"],
    defaultReasoningEffort: "high",
    supportsVision: false,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "x-ai/grok-4.5",
    displayName: "Grok 4.5",
    description: "xAI agentic model with vision.",
    contextWindow: 500_000,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "qwen/qwen3.8-max",
    displayName: "Qwen3.8 Max",
    description: "Alibaba flagship with a long context window.",
    contextWindow: 1_000_000,
    reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "xhigh",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "z-ai/glm-5.2",
    displayName: "GLM 5.2",
    description: "Z.ai coding model with a long context window.",
    contextWindow: 1_048_576,
    reasoningEfforts: ["high", "xhigh"],
    defaultReasoningEffort: "high",
    supportsVision: false,
    supportsParallelToolCalls: true,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "moonshotai/kimi-k3",
    displayName: "Kimi K3",
    description: "Moonshot frontier model with vision.",
    contextWindow: 1_048_576,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "max",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    // The only seed that works on an account with no credits. OpenRouter
    // sizes every request against the remaining balance and Codex does not
    // ask for a small budget, so on a zero-balance key every paid model
    // above fails with a 402 that reads like a rejected key.
    //
    // Chosen over `openai/gpt-oss-20b:free`, which looks like the obvious
    // pick and is not: it answers a single request fine but fails the second
    // turn of a real Codex loop every time. Every `:free` slug is pinned to
    // one donated backend with no failover, so its reliability is that one
    // machine's rather than the model's; this one's backend is Nvidia's own.
    slug: "nvidia/nemotron-3-super-120b-a12b:free",
    displayName: "Nemotron 3 Super (free)",
    description: "Free open-weight model. Rate limited; good for trying the setup.",
    contextWindow: 262_144,
    reasoningEfforts: ["low", "medium"],
    defaultReasoningEffort: "medium",
    supportsVision: false,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
];

/**
 * OpenRouter — one key, many vendors, resolved live.
 *
 * Note the base URL is `/api/v1`, not `/api`. The latter is OpenRouter's
 * Anthropic-compatible surface, which belongs to the Claude harness and is
 * documented separately; pointing Codex at it fails in a way that reads like
 * a key problem.
 *
 * OpenRouter's Responses API is explicitly a stateless beta: it rejects
 * `store: true` and any non-null `previous_response_id` with a 400. The
 * generated config's `forced_login_method = "api"` is what keeps Codex on the
 * store-false, full-history path, so that line is load-bearing here rather
 * than merely tidy.
 */
const OPENROUTER: ByokPreset = {
  id: "openrouter",
  label: "OpenRouter",
  wireFormat: "responses",
  baseUrl: "https://openrouter.ai/api/v1/",
  envKey: "OPENROUTER_API_KEY",
  apiKeysUrl: "https://openrouter.ai/keys",
  // `/models` is public here and answers 200 to any key, valid or not.
  // `/key` is the cheapest endpoint that actually authenticates.
  probePath: "key",
  models: OPENROUTER_SEED_MODELS,
  catalog: { kind: "openrouter", url: "https://openrouter.ai/api/v1/models" },
};

/**
 * Seed lineup for Vercel AI Gateway. Generated from its live catalog, same as
 * OpenRouter's — note the vendor prefixes differ between the two gateways
 * ("xai/" and "zai/" here, "x-ai/" and "z-ai/" there), so slugs are not
 * portable between them.
 */
const VERCEL_SEED_MODELS: ReadonlyArray<ByokPresetModel> = [
  {
    slug: "anthropic/claude-opus-5",
    displayName: "Claude Opus 5",
    description: "Anthropic flagship. Strongest at long multi-step work.",
    contextWindow: 1_000_000,
    reasoningEfforts: [],
    defaultReasoningEffort: undefined,
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "anthropic/claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    description: "Balanced Anthropic model for everyday agentic coding.",
    contextWindow: 1_000_000,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "openai/gpt-5.6-sol",
    displayName: "GPT 5.6 Sol",
    description: "OpenAI flagship. Strong at command-line and multi-step coding.",
    contextWindow: 1_050_000,
    reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "google/gemini-3.6-flash",
    displayName: "Gemini 3.6 Flash",
    description: "Fast long-context model with vision.",
    contextWindow: 1_000_000,
    reasoningEfforts: [],
    defaultReasoningEffort: undefined,
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "deepseek/deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    description: "Fast frontier agentic coding model.",
    contextWindow: 1_000_000,
    reasoningEfforts: ["high", "xhigh"],
    defaultReasoningEffort: "high",
    supportsVision: false,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "xai/grok-4.5",
    displayName: "Grok 4.5",
    description: "xAI agentic model with vision.",
    contextWindow: 500_000,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "zai/glm-5.2",
    displayName: "GLM 5.2",
    description: "Z.ai coding model with a long context window.",
    contextWindow: 1_000_000,
    reasoningEfforts: ["high", "xhigh"],
    defaultReasoningEffort: "high",
    supportsVision: false,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
  {
    slug: "moonshotai/kimi-k3",
    displayName: "Kimi K3",
    description: "Moonshot frontier model with vision.",
    contextWindow: 1_000_000,
    reasoningEfforts: [],
    defaultReasoningEffort: undefined,
    supportsVision: true,
    supportsParallelToolCalls: false,
    supportsApplyPatch: false,
    supportsWebSearch: false,
  },
];

/**
 * Vercel AI Gateway — one key, many vendors, with BYOK and spend controls on
 * Vercel's side.
 *
 * Its published API reference documents only Chat Completions, but the
 * Responses route is real: it answers 400 to a malformed body exactly as the
 * documented endpoints do, where an unrouted path answers 404. That matters
 * because Codex dropped the older "chat" wire format, so an
 * undocumented-but-present Responses endpoint is the difference between this
 * provider working and not existing here at all. Being undocumented, it is
 * also the thing most likely to change under us.
 *
 * Reasoning is the one place this gateway is genuinely poorer than OpenRouter:
 * most models expose reasoning as an on/off toggle rather than named levels,
 * and only the minority publishing an "effort" option get a level picker. The
 * rest correctly show no effort control at all.
 */
const VERCEL: ByokPreset = {
  id: "vercel",
  label: "Vercel AI Gateway",
  wireFormat: "responses",
  baseUrl: "https://ai-gateway.vercel.sh/v1/",
  envKey: "AI_GATEWAY_API_KEY",
  apiKeysUrl: "https://vercel.com/dashboard/ai-gateway/api-keys",
  // /v1/models is public here too, so it cannot tell a good key from a typo.
  probePath: "credits",
  models: VERCEL_SEED_MODELS,
  catalog: { kind: "vercel", url: "https://ai-gateway.vercel.sh/v1/models" },
};

export const BYOK_PRESETS: ReadonlyArray<ByokPreset> = [DEEPSEEK, OPENROUTER, VERCEL];

/**
 * Ids offered by the settings picker. Contracts owns the (id, label) pairs so
 * the form and this table cannot disagree about which providers exist; a
 * preset missing from either side is a bug, which `byokPresets.test.ts`
 * pins down.
 */
export const BYOK_PRESET_CHOICE_IDS: ReadonlyArray<string> = BYOK_PRESET_CHOICES.map(
  (choice) => choice.value,
);

export const BYOK_PRESET_BY_ID: ReadonlyMap<string, ByokPreset> = new Map(
  BYOK_PRESETS.map((preset) => [preset.id, preset]),
);

export function findByokPreset(id: string): ByokPreset | undefined {
  return BYOK_PRESET_BY_ID.get(id.trim());
}
