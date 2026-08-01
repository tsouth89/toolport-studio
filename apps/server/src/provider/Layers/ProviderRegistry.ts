/**
 * ProviderRegistryLive — aggregates per-instance snapshot streams into a
 * single materialized list.
 *
 * Historically this Layer composed four per-kind Live Layers
 * (`CodexProviderLive`, `ClaudeProviderLive`, …) that each exposed a
 * `ServerProviderShape`. Those Lives were deleted during the driver /
 * instance refactor — every driver now carries its `snapshot: ServerProviderShape`
 * bundled onto the `ProviderInstance` the registry produces.
 *
 * Each configured instance (including multi-instance setups like
 * `codex_personal` + `codex_work`) contributes one `ProviderSnapshotSource`,
 * keyed by `instanceId`. Instances whose driver is unavailable or whose
 * config failed to decode are merged from `instanceRegistry.listUnavailable`
 * as shadow snapshots so the UI can render their exact unavailable reason.
 *
 * Cache paths on disk are now keyed by `instanceId`. Because
 * `defaultInstanceIdForDriver(kind) === kind` for built-in kinds, existing
 * `<kind>.json` files remain the on-disk location for that driver's default
 * instance. Identity-less legacy cache contents are ignored and replaced by
 * the first live refresh.
 *
 * @module ProviderRegistryLive
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@toolport-studio/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderSnapshotSource } from "../builtInProviderCatalog.ts";

/** How recent a full refresh must be for `refreshAllIfStale` to reuse it. */
const REFRESH_STALENESS_TTL_MS = 60_000;

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const shouldRetainMissingProviderModels = (provider: ServerProvider): boolean => {
  if (provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  // OpenCode's initial snapshot is deliberately non-authoritative while its
  // first probe is still running. A probe error from an installed CLI/server
  // is likewise partial: it could not establish the current inventory.
  // Conversely, disabled and missing-CLI snapshots are authoritative removals,
  // as are successful ready/warning inventories (including an empty one after
  // logout or plugin removal).
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";
  const didInstalledProviderProbeFail = provider.installed && provider.status === "error";
  return isPendingInitialProbe || didInstalledProviderProbeFail;
};

const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);

  if (shouldRetainMissingModels && nextModels.length === 0 && previousModels.length > 0) {
    return previousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return shouldRetainMissingModels
    ? [...mergedModels, ...previousModels.filter((model) => !nextSlugs.has(model.slug))]
    : mergedModels;
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider =>
  !previousProvider
    ? nextProvider
    : {
        ...nextProvider,
        models: mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models),
      };

/**
 * How many consecutive indeterminate probes are absorbed before the failure is
 * reported as the provider's status. One, so a single blip is invisible and a
 * second consecutive miss surfaces.
 */
export const INDETERMINATE_TOLERANCE = 1;

/** A snapshot we actually managed to observe, and would rather not lose. */
const isObservedSnapshot = (provider: ServerProvider): boolean =>
  provider.status === "ready" || provider.status === "warning";

const withoutTransientFields = (provider: ServerProvider): ServerProvider => {
  const { indeterminate: _indeterminate, refreshFailure: _refreshFailure, ...rest } = provider;
  return rest;
};

/**
 * Decide what an indeterminate probe result is allowed to do to what we already
 * knew.
 *
 * A timeout says nothing about a provider, but it used to be published as
 * `status: "error"` — indistinguishable from "not installed". Because
 * `isProviderInstancePickerReady` requires `status === "ready"`, one 4s blip on
 * a CLI that normally answers in 200ms made the provider unselectable, and once
 * the boot cache started restoring last known status that error persisted across
 * restarts until a probe happened to succeed.
 *
 * So an indeterminate result carries the previous snapshot's observed values
 * forward and records a `refreshFailure` alongside them, up to
 * {@link INDETERMINATE_TOLERANCE} consecutive times. Past that it is published
 * as-is: tolerating failures forever would mean a genuinely broken CLI reports
 * `ready` indefinitely, which is a worse lie than a spurious error.
 *
 * Only an *observed* previous snapshot is worth protecting. If the provider was
 * already failing, there is nothing to preserve and the new result goes straight
 * through.
 */
export const resolveIndeterminateSnapshot = (input: {
  readonly previous: ServerProvider | undefined;
  readonly next: ServerProvider;
  readonly consecutiveFailures: number;
  readonly now: string;
}): { readonly provider: ServerProvider; readonly consecutiveFailures: number } => {
  if (input.next.indeterminate !== true) {
    // A determinate result is the truth, whatever it says. Clear the streak and
    // drop any carried-over failure marker.
    return { provider: withoutTransientFields(input.next), consecutiveFailures: 0 };
  }

  const consecutiveFailures = input.consecutiveFailures + 1;
  const previous = input.previous;
  if (
    previous === undefined ||
    !isObservedSnapshot(previous) ||
    consecutiveFailures > INDETERMINATE_TOLERANCE
  ) {
    return { provider: withoutTransientFields(input.next), consecutiveFailures };
  }

  // The previous snapshot carries its own models, slash commands, and skills,
  // which is what we want: an indeterminate probe only ever returns the
  // settings-derived fallback inventory, so those would otherwise regress too.
  return {
    provider: {
      ...withoutTransientFields(previous),
      refreshFailure: {
        at: input.now,
        message: input.next.message ?? "The provider check did not complete.",
      },
    },
    consecutiveFailures,
  };
};

export const mergeProviderSnapshots = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => {
  const mergedProviders = new Map(
    previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
  );

  for (const provider of nextProviders) {
    mergedProviders.set(
      snapshotInstanceKey(provider),
      mergeProviderSnapshot(mergedProviders.get(snapshotInstanceKey(provider)), provider),
    );
  }

  return orderProviderSnapshots([...mergedProviders.values()]);
};

export const selectProvidersByKind = (
  providers: ReadonlyArray<ServerProvider>,
  providerKinds: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ServerProvider> =>
  providers.filter((provider) => providerKinds.has(provider.driver));

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  return Effect.succeed(snapshot);
};

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Project a live `ProviderInstance` into the aggregator's consumption
// shape. Each call re-captures the instance's `snapshot` closures, so
// after `ProviderInstanceRegistry` rebuilds an instance (e.g. because
// its settings changed), a fresh source rides the new PubSub instead
// of a closed one.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: instance.snapshot.getSnapshot,
  refresh: instance.snapshot.refresh,
  streamChanges: instance.snapshot.streamChanges,
});

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Aggregator PubSub — consumers (WS gateway, etc.) subscribe here for
    // coalesced updates across every instance.
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    // Boot-only: hydrate `providersRef` from the on-disk per-instance
    // cache so the UI has something to render during the first refresh.
    // Instances added post-boot skip this path; their first entry in
    // `providersRef` comes from the reactive `syncLiveSources` pass
    // below.
    const bootInstances = yield* instanceRegistry.listInstances;
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < fallbackProviders.length; index++) {
      const provider = fallbackProviders[index];
      const source = bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }

    const cachedProviders = yield* Effect.forEach(
      bootSources,
      (source) =>
        Effect.gen(function* () {
          // One cache file per configured instance. For the default
          // instance of a built-in kind the path equals `<kind>.json` —
          // identical to the legacy filename. We still require the cache
          // payload to carry matching instance id + driver kind; old
          // identity-less payloads are discarded and the awaited refresh
          // below repopulates the cache.
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: source.instanceId,
          }).pipe(Effect.provideService(Path.Path, path));
          const fallbackProvider = fallbackByInstance.get(source.instanceId);
          if (fallbackProvider === undefined) {
            return undefined;
          }
          return yield* readProviderStatusCache(filePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.flatMap((cachedProvider) => {
              if (cachedProvider === undefined) {
                return Effect.void.pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              const correlation = {
                cachedProvider,
                fallbackProvider,
              } as const;
              if (!isCachedProviderCorrelated(correlation)) {
                return Effect.logWarning("provider status cache identity mismatch, ignoring", {
                  path: filePath,
                  instanceId: source.instanceId,
                  cachedInstanceId: cachedProvider.instanceId ?? null,
                  driver: source.driverKind,
                  cachedDriver: cachedProvider.driver ?? null,
                }).pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              return Effect.succeed(hydrateCachedProvider(correlation));
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(cachedProviders);
    const lastFullRefreshAtMsRef = yield* Ref.make<number | null>(null);
    const refreshStalenessSemaphore = yield* Semaphore.make(1);
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());
    // Consecutive indeterminate probe results per instance. Reset by any
    // determinate result, and consulted by `resolveIndeterminateSnapshot` to
    // decide when a run of failures stops being absorbed. Deliberately not
    // persisted: a fresh process has not failed to check anything yet.
    const indeterminateStreaksRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, number>>(
      new Map(),
    );

    // Live-source registry — the dynamic counterpart to the boot-time
    // `bootSources`. Keyed by `instanceId`; the stored `ProviderInstance`
    // reference is used for identity equality so "no-op" reconciles
    // (settings unchanged) skip re-subscribing + re-probing.
    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    // Serialize `syncLiveSources` so a rapid burst of reconciles doesn't
    // interleave two passes clobbering each other's fiber bookkeeping.
    const syncSemaphore = yield* Semaphore.make(1);

    const getLiveSources: Effect.Effect<ReadonlyArray<ProviderSnapshotSource>> = Ref.get(
      liveSubsRef,
    ).pipe(Effect.map((map) => Array.from(map.values(), buildSnapshotSource)));

    const persistProvider = (provider: ServerProvider) =>
      Effect.gen(function* () {
        // Persist every instance — the file name is the instance id, so
        // multi-instance setups (e.g. `codex_personal`, `codex_work`) each
        // get their own cache. We resolve the path fresh so snapshots
        // produced by newly-added instances post-boot still land on disk
        // without the aggregator holding a stale `cachePathByInstance`
        // entry.
        const key = snapshotInstanceKey(provider);
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: key,
        }).pipe(Effect.provideService(Path.Path, path));
        // Persist observed values only. `refreshFailure` describes this
        // process's failure to re-check and would be stale and misleading on the
        // next boot, and `indeterminate` is a probe input the registry has
        // already acted on.
        yield* writeProviderStatusCache({
          filePath,
          provider: withoutTransientFields(provider),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.tapError(Effect.logError),
          Effect.ignore,
        );
      });

    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      if (!updateState) {
        const { updateState: _updateState, ...providerWithoutUpdateState } = provider;
        return providerWithoutUpdateState;
      }
      return {
        ...provider,
        updateState,
      };
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
      },
    ) {
      const nextProvidersWithUpdateState = yield* Effect.forEach(
        nextProviders,
        applyProviderUpdateState,
        {
          concurrency: "unbounded",
        },
      );

      // Absorb transient probe failures before they reach `providersRef`.
      //
      // Skipped for `replace`, which carries unavailable-driver shadows rather
      // than probe results. The read-resolve-write across two Refs is not one
      // atomic step, but the state is per-instance and each instance's
      // publishes are already serialised by its own refresh semaphore, so two
      // updates for the same instance cannot interleave here.
      const resolvedNextProviders = yield* Effect.gen(function* () {
        if (options?.replace === true) {
          return nextProvidersWithUpdateState;
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        const previousByKey = new Map(
          (yield* Ref.get(providersRef)).map(
            (provider) => [snapshotInstanceKey(provider), provider] as const,
          ),
        );
        const streaks = yield* Ref.get(indeterminateStreaksRef);
        const nextStreaks = new Map(streaks);
        const resolved: Array<ServerProvider> = [];
        const notices: Array<{
          readonly carried: boolean;
          readonly key: ProviderInstanceId;
          readonly driver: ProviderDriverKind;
          readonly consecutiveFailures: number;
          readonly message: string | null;
        }> = [];

        for (const provider of nextProvidersWithUpdateState) {
          const key = snapshotInstanceKey(provider);
          const outcome = resolveIndeterminateSnapshot({
            previous: previousByKey.get(key),
            next: provider,
            consecutiveFailures: streaks.get(key) ?? 0,
            now,
          });
          if (outcome.consecutiveFailures === 0) {
            nextStreaks.delete(key);
          } else {
            nextStreaks.set(key, outcome.consecutiveFailures);
          }
          if (provider.indeterminate === true) {
            notices.push({
              carried: outcome.provider.refreshFailure !== undefined,
              key,
              driver: provider.driver,
              consecutiveFailures: outcome.consecutiveFailures,
              message: provider.message ?? null,
            });
          }
          resolved.push(outcome.provider);
        }

        yield* Ref.set(indeterminateStreaksRef, nextStreaks);
        // Logged rather than silent: an absorbed failure is invisible in the UI
        // by design, so this is the only record that the probe is struggling.
        yield* Effect.forEach(
          notices,
          (notice) =>
            Effect.logInfo(
              notice.carried
                ? "provider probe was indeterminate, keeping last known status"
                : "provider probe was indeterminate past tolerance, reporting failure",
            ).pipe(
              Effect.annotateLogs({
                instanceId: notice.key,
                driver: notice.driver,
                consecutiveFailures: notice.consecutiveFailures,
                probeMessage: notice.message,
              }),
            ),
          { discard: true },
        );
        return resolved;
      });
      const [previousProviders, providers, providersToPersist] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
          );
          const updatedKeys = new Set<ProviderInstanceId>();

          for (const provider of resolvedNextProviders) {
            const key = snapshotInstanceKey(provider);
            updatedKeys.add(key);
            mergedProviders.set(
              key,
              options?.replace === true
                ? provider
                : mergeProviderSnapshot(mergedProviders.get(key), provider),
            );
          }

          const providers = orderProviderSnapshots([...mergedProviders.values()]);
          const providersToPersist = providers.filter((provider) =>
            updatedKeys.has(snapshotInstanceKey(provider)),
          );
          return [[previousProviders, providers, providersToPersist] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        if (options?.persist !== false) {
          yield* Effect.forEach(providersToPersist, persistProvider, {
            concurrency: "unbounded",
            discard: true,
          });
        }
        if (options?.publish !== false) {
          yield* PubSub.publish(changesPubSub, providers);
        }
      }

      return providers;
    });

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      return yield* upsertProviders([provider], options);
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
      }) {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const previousActions = previous.get(input.instanceId);
          const nextActions = { ...previousActions };
          if (input.state === null || input.state.status === "idle") {
            delete nextActions[input.action];
          } else {
            nextActions[input.action] = input.state;
          }

          const next = new Map(previous);
          if (Object.keys(nextActions).length === 0) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, nextActions);
          }
          return next;
        });

        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        const nextProvider = yield* applyProviderUpdateState(matchingProvider);
        return yield* upsertProviders([nextProvider], {
          persist: false,
        });
      },
    );

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (
      providerSource: ProviderSnapshotSource,
    ) {
      return yield* providerSource.refresh.pipe(
        Effect.flatMap((nextProvider) =>
          correlateSnapshotWithSource(providerSource, nextProvider).pipe(
            Effect.flatMap(syncProvider),
          ),
        ),
      );
    });

    const refreshAll = Effect.fn("refreshAll")(function* () {
      const sources = yield* getLiveSources;
      const providers = yield* Effect.forEach(sources, (source) => refreshOneSource(source), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.andThen(Ref.get(providersRef)));
      yield* Ref.set(lastFullRefreshAtMsRef, yield* Clock.currentTimeMillis);
      return providers;
    });

    /**
     * Every full refresh probes each configured provider CLI, which spawns a
     * subprocess and, for a binary that is not installed, walks the whole PATH
     * first. That is seconds of work, so a burst of client connections must not
     * turn into a burst of probes. Each provider also self-refreshes on its own
     * timer, so serving a recent result here loses nothing.
     */
    const refreshAllIfStale = Effect.fn("refreshAllIfStale")(function* () {
      // Serialized, and the staleness check re-run behind the permit. A burst
      // of connections is the case this exists for, and an unsynchronized
      // check would let every caller in that burst observe the same stale
      // timestamp and start its own full refresh.
      return yield* refreshStalenessSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const lastRefreshAtMs = yield* Ref.get(lastFullRefreshAtMsRef);
          if (lastRefreshAtMs !== null) {
            const now = yield* Clock.currentTimeMillis;
            if (now - lastRefreshAtMs < REFRESH_STALENESS_TTL_MS) {
              return yield* Ref.get(providersRef);
            }
          }
          return yield* refreshAll();
        }),
      );
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      // Kind-scoped refreshes target the default instance for that driver.
      const defaultInstanceId = defaultInstanceIdForDriver(provider);
      const sources = yield* getLiveSources;
      const providerSource = sources.find(
        (candidate) => candidate.instanceId === defaultInstanceId,
      );
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (instanceId: ProviderInstanceId, provider: ProviderDriverKind) {
      const instance = Array.from((yield* Ref.get(liveSubsRef)).values()).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      return (
        instance?.snapshot.maintenanceCapabilities ??
        makeManualProviderMaintenanceCapabilities(provider)
      );
    });

    /**
     * Diff the aggregator's live-source set against the current
     * `ProviderInstanceRegistry` and:
     *   - subscribe to each newly-added or rebuilt instance's
     *     `streamChanges` (so periodic + enrichment refreshes land in
     *     `providersRef`);
     *   - read each newly-added/rebuilt instance's current snapshot after
     *     subscribing, closing the race with its independently-running
     *     background startup probe;
     *   - prune `providersRef` of instances that no longer exist.
     *
     * Provider refreshes are owned by each managed provider and never run
     * on this layer's construction path. Consumers see cached or pending
     * snapshots immediately, then receive live probe results through the
     * already-attached change stream.
     *
     * Per-instance subscription fibers are not tracked explicitly. When
     * a rebuilt instance's old child scope closes, its PubSub shuts
     * down and our `Stream.runForEach` fiber exits naturally.
     */
    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = yield* Ref.get(liveSubsRef);

        // Carry over subscriptions for instances whose identity is
        // unchanged (reconcile treated them as no-op). Instances that
        // disappeared, or were rebuilt with a different reference,
        // fall through to the "newly-added" branch below.
        const carriedOver = new Map<ProviderInstanceId, ProviderInstance>();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== undefined && nextInstance === previousInstance) {
            carriedOver.set(instanceId, previousInstance);
          }
        }

        // Collect new/rebuilt instances in `nextByInstance` insertion
        // order (which preserves settings-author order).
        const newlyAdded: Array<readonly [ProviderInstanceId, ProviderInstance]> = [];
        for (const [instanceId, instance] of nextByInstance) {
          if (carriedOver.has(instanceId)) {
            continue;
          }
          newlyAdded.push([instanceId, instance] as const);
        }

        // Fork long-lived subscriptions to each new/rebuilt instance's
        // change stream before reading its current snapshot. If the
        // driver's own initial probe finishes during this sync, either
        // the current read or the active subscriber observes the result.
        for (const [, instance] of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* Stream.runForEach(source.streamChanges, (provider) =>
            correlateSnapshotWithSource(source, provider).pipe(Effect.flatMap(syncProvider)),
          ).pipe(Effect.forkScoped);
        }
        yield* Effect.yieldNow;

        // Snapshot current state without starting a probe. Managed providers
        // launch their startup refresh independently, so this closes the
        // subscription race without putting external work on the registry
        // or HTTP server construction path.
        yield* Effect.forEach(
          newlyAdded,
          ([instanceId, instance]) =>
            Effect.gen(function* () {
              const source = buildSnapshotSource(instance);
              const provider = yield* source.getSnapshot;
              // A snapshot still identical to the one read at boot means
              // this instance's probe has not produced a result yet, so
              // we are holding the driver's pre-probe placeholder. It
              // carries strictly less information than a hydrated cache
              // entry, and `mergeProviderSnapshot` is next-wins, so
              // upserting it would replace the on-disk `status`/`auth`/
              // `version` with "has not been checked in this session
              // yet" and strand the picker on that warning for the whole
              // probe. Leave `providersRef` alone — the subscription
              // attached above delivers the real result when it lands.
              if (Equal.equals(fallbackByInstance.get(instanceId), provider)) {
                return;
              }
              yield* correlateSnapshotWithSource(source, provider).pipe(
                Effect.flatMap(syncProvider),
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
        yield* upsertProviders(unavailableProviders, {
          persist: false,
          replace: true,
        });

        const nextSubs = new Map(carriedOver);
        for (const [instanceId, instance] of newlyAdded) {
          nextSubs.set(instanceId, instance);
        }
        yield* Ref.set(liveSubsRef, nextSubs);

        // Drop aggregator state for instances that have disappeared —
        // otherwise the UI would keep rendering ghosts.
        const [previousProviders, providers] = yield* Ref.modify(
          providersRef,
          (previousProviders) => {
            const providers = orderProviderSnapshots(
              previousProviders.filter((provider) =>
                knownInstanceIds.has(snapshotInstanceKey(provider)),
              ),
            );
            return [[previousProviders, providers] as const, providers];
          },
        );
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

    // Seed `providersRef` with the boot-time fallback snapshots so
    // consumers calling `getProviders` immediately after layer build see
    // a populated list — even before the first `syncLiveSources` refresh
    // resolves.
    //
    // Seed only the instances hydration did not already cover.
    // `upsertProviders` merges through `mergeProviderSnapshot`, which is
    // next-wins on every field except `models`, so re-seeding a hydrated
    // instance overwrites its on-disk `status`/`auth`/`version` with the
    // driver's pre-probe placeholder ("has not been checked in this
    // session yet") and strands the picker on that warning for the whole
    // probe. Nothing is lost by skipping them: `hydrateCachedProvider`
    // builds each hydrated entry by spreading this same fallback
    // snapshot, so presentation, models, and enablement are already
    // carried over with the cached status layered on top.
    //
    // `persist: false` — these are pre-probe placeholders. Writing them
    // back would destroy a good cache entry if the process exits before
    // the first probe resolves.
    const hydratedInstanceIds = new Set((yield* Ref.get(providersRef)).map(snapshotInstanceKey));
    const unhydratedFallbackProviders = fallbackProviders.filter(
      (provider) => !hydratedInstanceIds.has(snapshotInstanceKey(provider)),
    );
    if (unhydratedFallbackProviders.length > 0) {
      yield* upsertProviders(unhydratedFallbackProviders, {
        publish: false,
        persist: false,
      });
    }
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the dequeue synchronously in this
    // fibre; the subscription is active the instant this `yield*`
    // returns. Forking the consumer loop later cannot lose a publish
    // because no publish can reach a not-yet-subscribed dequeue.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `Stream.fromPubSub` defers `PubSub.subscribe` to stream start,
    // and `forkScoped` only schedules the fibre — so a reconcile that
    // published between "fibre scheduled" and "fibre starts running"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the `PubSub.Subscription` synchronously
    // in this fibre; the subscription is registered with the PubSub the
    // instant this `yield*` returns, so any subsequent publish is
    // buffered in the subscription regardless of when the consumer
    // fibre below actually starts running.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `instanceRegistry.streamChanges` is `Stream.fromPubSub(changes)`,
    // which defers `PubSub.subscribe` to stream start. `forkScoped` only
    // schedules the consumer fibre — so a reconcile that published
    // between "fibre scheduled" and "fibre starts running + subscribes"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    // Initial sync attaches subscriptions and snapshots current state for
    // every instance present at boot. Provider probes are already running in
    // their managed background fibers and never block this layer.
    yield* syncLiveSources;
    // React to registry mutations — instance added / removed / rebuilt.
    // `Stream.fromSubscription` builds a stream over the pre-acquired
    // subscription rather than subscribing on stream start, which is
    // what closes the race.
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshIfStale: () => refreshAllIfStale().pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      getProviderMaintenanceCapabilitiesForInstance,
      setProviderMaintenanceActionState,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
);
