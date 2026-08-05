/**
 * ByokModelCatalog — resolves a preset's models against the provider's own
 * listing endpoint.
 *
 * A static preset says what its models can do. A router cannot: OpenRouter
 * fronts hundreds of models whose context windows, reasoning levels, and
 * vision support belong to whichever vendor is behind the slug, and the set
 * changes faster than our release cadence. Writing that table by hand means
 * shipping a build every time someone wants a model we did not guess, and
 * being wrong in the meantime.
 *
 * So the preset carries a {@link ByokPresetCatalog} descriptor and this
 * module does the fetching. The resolved models feed the same generated
 * `models.json` a static preset produces, which is what keeps the rest of the
 * driver — and every consumer of the snapshot — unaware that anything is
 * dynamic.
 *
 * Three properties matter more than completeness:
 *
 *   1. **Never fail the instance.** A provider that will not start because a
 *      metadata endpoint was slow is worse than one with slightly stale
 *      metadata. Every failure path falls back to the cache, then the seed.
 *   2. **Filter to what can actually run a turn.** A model without tool
 *      support cannot drive a coding agent; offering it produces a session
 *      that fails on the first command. Those are dropped, not degraded.
 *   3. **Resolve only what is asked for.** The picker is a list a human
 *      reads. Seeds plus the slugs the user added is the right size; all 300
 *      is not.
 *
 * @module provider/Drivers/Byok/byokModelCatalog
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type {
  ByokPreset,
  ByokPresetCatalog,
  ByokPresetModel,
  ByokReasoningEffort,
} from "./byokPresets.ts";

/** Cached listing, so a cold start without network still has real metadata. */
export const BYOK_CATALOG_CACHE_FILE_NAME = "catalog-cache.json";

const CATALOG_TIMEOUT_MS = 10_000;

/**
 * Effort names OpenRouter publishes happen to be exactly the ones a preset
 * may declare. Anything outside the set is dropped rather than coerced: a
 * guessed mapping would show the user an effort level the provider ignores.
 */
const REASONING_EFFORTS = new Set<string>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * Ascending order for effort lists. OpenRouter returns them descending and
 * the catalog contract is ascending, so this is a sort key rather than a
 * reverse — their ordering is not guaranteed and should not be trusted.
 */
const EFFORT_RANK: Record<ByokReasoningEffort, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/**
 * The subset of OpenRouter's model listing we read.
 *
 * Deliberately permissive: every field a model might omit is optional, and
 * unknown fields are ignored. The schema of record belongs to OpenRouter and
 * tracks their releases — a strict shape here would turn any field they add
 * or a single malformed row into a provider that will not start.
 */
const OpenRouterModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  context_length: Schema.optional(Schema.Number),
  architecture: Schema.optional(
    Schema.Struct({
      input_modalities: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  supported_parameters: Schema.optional(Schema.Array(Schema.String)),
  reasoning: Schema.optional(
    Schema.Struct({
      supported_efforts: Schema.optional(Schema.Array(Schema.String)),
      default_effort: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const OpenRouterModelList = Schema.Struct({ data: Schema.Array(OpenRouterModel) });
const decodeOpenRouterModelList = Schema.decodeUnknownOption(OpenRouterModelList);

type OpenRouterModel = typeof OpenRouterModel.Type;

const CachedCatalog = Schema.fromJsonString(Schema.Struct({ data: Schema.Array(Schema.Unknown) }));
const decodeCachedCatalog = Schema.decodeUnknownOption(CachedCatalog);

/**
 * Can this model drive a coding agent at all?
 *
 * Tool calling is the floor. Codex's entire loop is function calls, so a
 * text-only model produces a session that greets the user and then fails on
 * the first command — a worse outcome than the model simply not being
 * offered.
 */
export function isAgentCapableModel(model: {
  readonly supported_parameters?: ReadonlyArray<string> | undefined;
}): boolean {
  return (model.supported_parameters ?? []).includes("tools");
}

export function toReasoningEfforts(
  supported: ReadonlyArray<string> | undefined,
): ReadonlyArray<ByokReasoningEffort> {
  const efforts = (supported ?? []).filter((effort): effort is ByokReasoningEffort =>
    REASONING_EFFORTS.has(effort),
  );
  return [...new Set(efforts)].sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right]);
}

/**
 * Map one listing row onto a preset model.
 *
 * `supportsApplyPatch` and `supportsWebSearch` stay false regardless of what
 * the upstream vendor supports — see the note on the OpenRouter preset: a
 * single slug can land on different backends between requests, so a tool that
 * works once is not a tool that works.
 */
export function toByokPresetModel(
  model: OpenRouterModel,
  fallback: ByokPresetModel | undefined,
): ByokPresetModel {
  const efforts = toReasoningEfforts(model.reasoning?.supported_efforts);
  const declaredDefault = model.reasoning?.default_effort ?? undefined;
  const defaultEffort =
    declaredDefault && efforts.includes(declaredDefault as ByokReasoningEffort)
      ? (declaredDefault as ByokReasoningEffort)
      : // Providers do publish a default outside their own supported set.
        // Prefer the strongest level they admit to over echoing a value the
        // catalog would then reject as inconsistent.
        efforts.at(-1);

  return {
    slug: model.id,
    displayName: model.name ?? fallback?.displayName ?? model.id,
    description: (model.description ?? fallback?.description ?? "").slice(0, 280),
    contextWindow: model.context_length ?? fallback?.contextWindow ?? 128_000,
    reasoningEfforts: efforts,
    defaultReasoningEffort: efforts.length === 0 ? undefined : defaultEffort,
    supportsVision: (model.architecture?.input_modalities ?? []).includes("image"),
    // OpenRouter accepts `parallel_tool_calls` per model, but a slug that
    // omits it still runs tools serially rather than erroring, so treating
    // the absence as "not parallel" costs nothing and never overpromises.
    supportsParallelToolCalls: (model.supported_parameters ?? []).includes("parallel_tool_calls"),
    supportsApplyPatch: false,
    supportsWebSearch: false,
  };
}

/**
 * Vercel AI Gateway's listing.
 *
 * Same facts as OpenRouter's, different names throughout, which is why the
 * preset names its dialect rather than this module sniffing for one.
 */
const VercelModel = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  context_window: Schema.optional(Schema.Number),
  modalities: Schema.optional(
    Schema.Struct({ input: Schema.optional(Schema.Array(Schema.String)) }),
  ),
  supported_parameters: Schema.optional(Schema.Array(Schema.String)),
  /**
   * A list of the reasoning controls a model offers, e.g.
   * `[{ type: "toggle" }, { type: "effort", values: ["low","medium","high"] }]`.
   * Only the `effort` entry maps onto a level picker; a toggle-only model has
   * no levels to show, and saying so is better than inventing two.
   */
  reasoning_options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        values: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
});
type VercelModel = typeof VercelModel.Type;

const VercelModelList = Schema.Struct({ data: Schema.Array(VercelModel) });
const decodeVercelModelList = Schema.decodeUnknownOption(VercelModelList);

export function toVercelPresetModel(model: VercelModel): ByokPresetModel {
  const effortOption = (model.reasoning_options ?? []).find((option) => option.type === "effort");
  const efforts = toReasoningEfforts(effortOption?.values);
  return {
    slug: model.id,
    displayName: model.name ?? model.id,
    description: (model.description ?? "").slice(0, 280),
    contextWindow: model.context_window ?? 128_000,
    reasoningEfforts: efforts,
    // Vercel publishes no default, so take the middle of what is offered
    // rather than the strongest: an unasked-for default should not be the
    // most expensive one the model has.
    defaultReasoningEffort:
      efforts.length === 0 ? undefined : efforts[Math.floor((efforts.length - 1) / 2)],
    supportsVision: (model.modalities?.input ?? []).includes("image"),
    supportsParallelToolCalls: (model.supported_parameters ?? []).includes("parallel_tool_calls"),
    supportsApplyPatch: false,
    supportsWebSearch: false,
  };
}

/**
 * Turn a raw listing into preset models, in whichever dialect the preset
 * speaks, keeping only what could actually run a session.
 *
 * Normalizing here is what lets everything downstream — selection, browsing,
 * the generated catalog — stay unaware that there is more than one gateway.
 */
export function decodeCatalogModels(
  kind: ByokPresetCatalog["kind"],
  value: unknown,
  seeds: ReadonlyArray<ByokPresetModel> = [],
): Option.Option<ReadonlyArray<ByokPresetModel>> {
  const seedBySlug = new Map(seeds.map((seed) => [seed.slug, seed]));
  if (kind === "vercel") {
    return Option.map(decodeVercelModelList(value), (listing) =>
      listing.data.filter(isAgentCapableModel).map(toVercelPresetModel),
    );
  }
  return Option.map(decodeOpenRouterModelList(value), (listing) =>
    listing.data
      .filter(isAgentCapableModel)
      .map((model) => toByokPresetModel(model, seedBySlug.get(model.id))),
  );
}

/**
 * Pick the requested slugs out of a listing, in the order they were asked
 * for, dropping anything unusable.
 *
 * A slug the user typed that OpenRouter does not serve is silently absent
 * rather than an error. It is almost always a typo, and the alternative — a
 * provider that refuses to start over one bad row in a list of ten — is a far
 * worse trade.
 */
export function selectCatalogModels(input: {
  readonly catalog: ReadonlyArray<ByokPresetModel>;
  readonly slugs: ReadonlyArray<string>;
}): ReadonlyArray<ByokPresetModel> {
  const bySlug = new Map(input.catalog.map((model) => [model.slug, model]));
  const resolved: ByokPresetModel[] = [];
  const seen = new Set<string>();

  for (const slug of input.slugs) {
    const normalized = slug.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    const listed = bySlug.get(normalized);
    if (!listed) continue;
    seen.add(normalized);
    resolved.push(listed);
  }

  return resolved;
}

/**
 * Everything the provider serves that could actually run a session.
 *
 * The resolver deliberately narrows to the slugs an instance asked for,
 * because `models.json` is a list the harness loads and the picker is a list a
 * human reads. Browsing is the opposite problem: the user wants to see what
 * exists before choosing. Same filter, no slug narrowing.
 */
export function listCatalogModels(
  catalog: ReadonlyArray<ByokPresetModel>,
): ReadonlyArray<ByokPresetModel> {
  return [...catalog].sort((left, right) => left.slug.localeCompare(right.slug));
}

const fetchListing = Effect.fn("fetchByokCatalogListing")(function* (
  catalogUrl: string,
  apiKey: string,
): Effect.fn.Return<Option.Option<unknown>, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(catalogUrl).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    // The listing is public on OpenRouter, but sending the key makes the
    // response reflect the account: models gated behind a BYOK integration or
    // a provider preference show up as they will actually resolve at turn time.
    // Callers with no key (the browse path) omit it rather than sending an
    // empty bearer, which some proxies treat as a malformed credential.
    apiKey.length > 0
      ? HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`)
      : (identity) => identity,
  );

  return yield* client.execute(request).pipe(
    Effect.flatMap((response) => response.json),
    Effect.timeoutOption(CATALOG_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
});

const readCache = Effect.fn("readByokCatalogCache")(function* (
  cachePath: string,
): Effect.fn.Return<Option.Option<unknown>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(cachePath).pipe(
    Effect.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(contents)) return Option.none();
  return decodeCachedCatalog(contents.value) as Option.Option<unknown>;
});

export interface ResolveByokCatalogInput {
  readonly preset: ByokPreset;
  readonly apiKey: string;
  /**
   * Extra slugs the user added on this instance. Resolved alongside the
   * seeds, which is what upgrades a typed slug from an opaque "custom model"
   * with guessed capabilities into a real catalog entry.
   */
  readonly requestedSlugs: ReadonlyArray<string>;
  /** Where the last good listing is kept, inside the instance's own home. */
  readonly cachePath: string;
}

/**
 * Resolve the models this instance should offer.
 *
 * Order of preference is live listing, then the cached one, then the preset's
 * seeds untouched. The seed fallback is what guarantees a usable instance on
 * a machine that has never reached OpenRouter.
 */
export const resolveByokCatalogModels = Effect.fn("resolveByokCatalogModels")(function* (
  input: ResolveByokCatalogInput,
): Effect.fn.Return<
  ReadonlyArray<ByokPresetModel>,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  const { preset, apiKey, requestedSlugs, cachePath } = input;
  const catalog = preset.catalog;
  if (!catalog) return preset.models;

  const slugs = [...preset.models.map((model) => model.slug), ...requestedSlugs];

  const live =
    apiKey.length === 0
      ? Option.none<unknown>()
      : yield* fetchListing(catalog.url, apiKey).pipe(Effect.orElseSucceed(() => Option.none()));

  const liveRaw = Option.isSome(live) ? live.value : undefined;
  const decodedLive = Option.isSome(live)
    ? decodeCatalogModels(catalog.kind, live.value, preset.models)
    : Option.none();

  if (Option.isSome(decodedLive)) {
    const resolved = selectCatalogModels({ catalog: decodedLive.value, slugs });
    if (resolved.length > 0) {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Best effort. A cache we could not write is a slower next start, not a
      // failure, and must never take the instance down with it.
      yield* fileSystem.makeDirectory(path.dirname(cachePath), { recursive: true }).pipe(
        Effect.andThen(() =>
          fileSystem.writeFileString(
            cachePath,
            // Persist the provider's own payload, not our normalized view:
            // the cache is re-decoded in the preset's dialect on read, so
            // storing the raw rows keeps it valid across mapper changes.
            JSON.stringify(liveRaw),
          ),
        ),
        Effect.ignore,
      );
      return resolved;
    }
  }

  const cached = yield* readCache(cachePath);
  const decodedCache = Option.isSome(cached)
    ? decodeCatalogModels(catalog.kind, cached.value, preset.models)
    : Option.none();
  if (Option.isSome(decodedCache)) {
    const resolved = selectCatalogModels({ catalog: decodedCache.value, slugs });
    if (resolved.length > 0) return resolved;
  }

  return preset.models;
});

export interface ByokCatalogBrowseResult {
  readonly models: ReadonlyArray<ByokPresetModel>;
  /** Where the list came from, so the client can say when it is stale. */
  readonly source: "live" | "cache" | "seeds";
}

/**
 * The full browsable catalog for an instance, read from its cache.
 *
 * Deliberately does not reach the network. The cache is rewritten on every
 * instance start, so it is rarely far behind, and staying local keeps three
 * promises: browsing is instant, opening a model list cannot leak a key
 * (it never touches the secret store), and the websocket layer does not have
 * to grow an HTTP dependency to serve a settings screen.
 *
 * An instance whose cache does not exist yet — one configured but never
 * started — falls back to the preset's seeds and says so, rather than showing
 * an empty list that reads as "this provider serves nothing".
 */
export const browseByokCatalog = Effect.fn("browseByokCatalog")(function* (input: {
  readonly preset: ByokPreset;
  readonly cachePath: string;
}): Effect.fn.Return<ByokCatalogBrowseResult, never, FileSystem.FileSystem> {
  if (!input.preset.catalog) return { models: input.preset.models, source: "seeds" };

  const cached = yield* readCache(input.cachePath);
  const decodedCache = Option.isSome(cached)
    ? decodeCatalogModels(input.preset.catalog.kind, cached.value, input.preset.models)
    : Option.none();
  if (Option.isSome(decodedCache)) {
    const models = listCatalogModels(decodedCache.value);
    if (models.length > 0) return { models, source: "cache" };
  }

  return { models: input.preset.models, source: "seeds" };
});
