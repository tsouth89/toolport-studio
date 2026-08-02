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
  readonly models: ReadonlyArray<ByokPresetModel>;
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
    {
      slug: "deepseek-v4-pro",
      displayName: "DeepSeek-V4-Pro",
      description: "Most capable frontier agentic coding model.",
      contextWindow: 1_000_000,
      // Documented as temporary: pro does not accept `low` yet.
      reasoningEfforts: ["high", "max"],
      defaultReasoningEffort: "high",
      supportsVision: false,
      supportsParallelToolCalls: true,
      supportsApplyPatch: true,
      supportsWebSearch: true,
    },
  ],
};

export const BYOK_PRESETS: ReadonlyArray<ByokPreset> = [DEEPSEEK];

export const BYOK_PRESET_BY_ID: ReadonlyMap<string, ByokPreset> = new Map(
  BYOK_PRESETS.map((preset) => [preset.id, preset]),
);

export function findByokPreset(id: string): ByokPreset | undefined {
  return BYOK_PRESET_BY_ID.get(id.trim());
}
