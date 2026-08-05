/**
 * ByokDriver — one driver for every API-key ("bring your own key") provider.
 *
 * Toolport Studio has no in-house agent loop; every provider wraps a harness
 * we ship. So supporting a third-party model endpoint is not a matter of
 * writing another adapter, it is a matter of *configuring* an existing one.
 * This driver does exactly that: it generates a private `CODEX_HOME` from a
 * {@link ByokPreset} and then delegates to the same Codex adapter, snapshot
 * probe, and text-generation shares the first-party Codex driver uses.
 *
 * Adding a provider is therefore a row in `byokPresets.ts`, not a new module.
 *
 * Identity is the part that cannot be delegated. Codex reports its own
 * account state, which for a custom provider block is simply "unknown" — it
 * has no idea whether the third party accepted the key. The snapshot is
 * post-processed here so the instance says who it really is: the preset's
 * name, and whether the key that provider needs is actually present.
 *
 * @module provider/Drivers/Byok/ByokDriver
 */
import {
  ByokSettings,
  CodexSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@toolport-studio/contracts";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../../textGeneration/CodexTextGeneration.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProviderDriverError } from "../../Errors.ts";
import { makeCodexAdapter } from "../../Layers/CodexAdapter.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "../../Layers/CodexProvider.ts";
import { ProviderEventLoggers } from "../../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../../ProviderDriver.ts";
import type { ServerProviderDraft } from "../../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../../providerUpdateSettings.ts";
import { type ByokApiKeyStatus, probeByokApiKey } from "./byokApiKeyProbe.ts";
import { materializeByokCodexHome } from "./byokCodexHome.ts";
import { BYOK_CATALOG_CACHE_FILE_NAME, resolveByokCatalogModels } from "./byokModelCatalog.ts";
import { findByokPreset, type ByokPreset } from "./byokPresets.ts";

const decodeByokSettings = Schema.decodeSync(ByokSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("byok");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});
/** Generated homes live here, one directory per instance id. */
const BYOK_HOME_DIRECTORY = "byok";

export type ByokDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Replace the harness's account reporting with the provider's own.
 *
 * Codex cannot tell us anything useful here: a custom `model_providers`
 * block does not require OpenAI auth, so its probe returns `unknown` whether
 * or not the third-party key exists. What we *can* check cheaply and
 * truthfully is whether the environment variable the preset names is
 * present. A missing key is reported as an error naming the exact variable,
 * because the alternative is a provider that looks healthy and fails on the
 * first turn.
 *
 * Note this proves the key is *present*, not that it is valid. Validating it
 * against the provider's `/models` endpoint is worth doing, but it is a
 * network call on every refresh and belongs behind its own change.
 */
export function applyByokIdentity(input: {
  readonly preset: ByokPreset;
  readonly keyStatus: ByokApiKeyStatus | "missing";
}): (snapshot: ServerProvider) => ServerProvider {
  const { preset, keyStatus } = input;
  return (snapshot) => {
    if (keyStatus === "missing") {
      return {
        ...snapshot,
        status: "error",
        auth: { status: "unauthenticated" },
        message: `${preset.label} needs an API key. Add ${preset.envKey} as a sensitive environment variable on this instance (create one at ${preset.apiKeysUrl}).`,
      };
    }
    if (keyStatus === "invalid") {
      return {
        ...snapshot,
        status: "error",
        auth: { status: "unauthenticated" },
        message: `${preset.label} rejected the API key in ${preset.envKey}. Check it has not been revoked, or create a new one at ${preset.apiKeysUrl}.`,
      };
    }
    if (keyStatus === "unknown") {
      // Reaching the provider failed. The key may be perfectly good, so warn
      // rather than accuse it, and leave the instance usable.
      return {
        ...snapshot,
        status: "warning",
        auth: { status: "unknown" },
        message: `Could not reach ${preset.label} to verify the API key. Turns may still work.`,
      };
    }
    return {
      ...snapshot,
      auth: {
        status: "authenticated",
        type: "apiKey",
        label: `${preset.label} API Key`,
      },
    };
  };
}

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
    readonly presetId: string;
    readonly supportsImageInput: boolean;
    /** Only set when the instance's models disagree about vision. */
    readonly visionModelSlugs: ReadonlyArray<string> | undefined;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    // The driver kind is shared by every API-key provider, so the snapshot
    // has to say which one this is for the client to brand it.
    presetId: input.presetId,
    supportsImageInput: input.supportsImageInput,
    ...(input.visionModelSlugs ? { visionModelSlugs: input.visionModelSlugs } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ByokDriver: ProviderDriver<ByokSettings, ByokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "API Key Provider",
    supportsMultipleInstances: true,
  },
  configSchema: ByokSettings,
  defaultConfig: (): ByokSettings => decodeByokSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const path = yield* Path.Path;

      const preset = findByokPreset(config.preset);
      if (!preset) {
        // Surfaces as an unavailable shadow snapshot rather than a crash, so
        // an instance configured against a preset this build does not know
        // (a fork, a downgrade) round-trips instead of breaking startup.
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: `Unknown BYOK preset '${config.preset}'.`,
        });
      }

      const processEnv = mergeProviderInstanceEnvironment(environment);
      const apiKey = (processEnv[preset.envKey] ?? "").trim();

      const homePath = path.join(serverConfig.stateDir, BYOK_HOME_DIRECTORY, instanceId);
      // Resolved once per instance start. Codex reads `models.json` at
      // startup only, so refreshing more often than this would write a file
      // nothing re-reads; picking up a newly released model is a restart.
      const models = yield* resolveByokCatalogModels({
        preset,
        apiKey,
        // Slugs the user added on this instance are resolved alongside the
        // seeds, which is what turns a typed slug into a real catalog entry
        // with the provider's own context window and effort levels instead of
        // an opaque custom entry carrying guessed capabilities.
        requestedSlugs: config.customModels,
        cachePath: path.join(homePath, BYOK_CATALOG_CACHE_FILE_NAME),
      });
      const defaultModel = models[0]?.slug ?? "";

      yield* materializeByokCodexHome({ homePath, preset, models, modelSlug: defaultModel }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to generate ${preset.label} provider config: ${cause.message}`,
              cause,
            }),
        ),
      );

      // From here on this is a Codex instance in everything but identity.
      const codexConfig = {
        ...decodeCodexSettings({
          binaryPath: config.binaryPath,
          homePath,
          customModels: config.customModels,
        }),
        enabled,
      } satisfies CodexSettings;

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName: displayName ?? preset.label,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
        presetId: preset.id,
        // True when *any* model can see, which is what gates the attachment
        // affordance for the instance as a whole. OpenRouter mixes vision and
        // text-only models under one key, so the per-model flag stamped onto
        // the snapshot below is what actually decides a given turn.
        supportsImageInput: models.some((model) => model.supportsVision),
        // Only worth sending when the models actually disagree. A uniform
        // preset like DeepSeek keeps the plain instance-wide answer it had
        // before this existed.
        visionModelSlugs: models.every((model) => model.supportsVision)
          ? undefined
          : models.filter((model) => model.supportsVision).map((model) => model.slug),
      });
      // Re-run per refresh so a key added, fixed, or revoked after startup is
      // reflected without restarting the instance.
      const resolveKeyStatus: Effect.Effect<ByokApiKeyStatus | "missing"> =
        apiKey.length === 0
          ? Effect.succeed("missing" as const)
          : probeByokApiKey({ preset, apiKey }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
            );

      const adapter = yield* makeCodexAdapter(codexConfig, {
        instanceId,
        // Turn requests carry this instance's driver kind, not the harness's,
        // so the adapter must be told which one it is serving.
        driverKind: DRIVER_KIND,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeCodexTextGeneration(codexConfig, processEnv);

      const checkProvider = Effect.gen(function* () {
        const snapshot = yield* checkCodexProviderStatus(codexConfig, undefined, processEnv).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const keyStatus = yield* resolveKeyStatus;
        return applyByokIdentity({ preset, keyStatus })(snapshot);
      });

      const snapshotSettings = makeProviderSnapshotSettingsSource(codexConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
        // Manual-only on purpose. The binary being updated is the harness,
        // which the first-party Codex instance already tracks; offering a
        // one-click update on every BYOK instance would nag about the same
        // upgrade once per configured provider.
        maintenanceCapabilities: MAINTENANCE,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingCodexProvider(settings.provider).pipe(
            Effect.map(stampIdentity),
            // Before the first probe all we know is whether a key exists.
            Effect.map(
              applyByokIdentity({
                preset,
                keyStatus: apiKey.length === 0 ? "missing" : "unknown",
              }),
            ),
          ),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) => publishSnapshot(snapshot),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ${preset.label} snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName: displayName ?? preset.label,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
