import {
  type GrokSettings,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@toolport-studio/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@toolport-studio/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
} from "@toolport-studio/shared/model";
import { resolveSpawnCommand } from "@toolport-studio/shared/shell";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeGrokAcpRuntime, resolveGrokAcpBaseModelId } from "../acp/GrokAcpSupport.ts";

const GROK_PRESENTATION = {
  displayName: "Grok",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

/**
 * Grok agent reports live fill via `_meta.totalTokens` but not window size.
 * Grok 4.5 API class is 500k context (xAI docs); use that so the composer ring
 * can fill until/unless the agent starts reporting an explicit max.
 */
export const GROK_ASSUMED_CONTEXT_WINDOW_TOKENS = 500_000;

/** Matches Grok Build TUI / CLI: high | medium | low (default high). */
export const GROK_REASONING_EFFORT_LEVELS = ["high", "medium", "low"] as const;
export type GrokReasoningEffort = (typeof GROK_REASONING_EFFORT_LEVELS)[number];
export const GROK_DEFAULT_REASONING_EFFORT: GrokReasoningEffort = "high";

export function isGrokReasoningEffort(
  value: string | null | undefined,
): value is GrokReasoningEffort {
  return (
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "HIGH" ||
    value === "MEDIUM" ||
    value === "LOW"
  );
}

export function normalizeGrokReasoningEffort(
  value: string | null | undefined,
): GrokReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return isGrokReasoningEffort(normalized) ? (normalized as GrokReasoningEffort) : undefined;
}

export function resolveGrokReasoningEffort(
  modelSelection: ModelSelection | null | undefined,
): GrokReasoningEffort {
  return (
    normalizeGrokReasoningEffort(getModelSelectionStringOptionValue(modelSelection, "reasoning")) ??
    normalizeGrokReasoningEffort(getModelSelectionStringOptionValue(modelSelection, "effort")) ??
    GROK_DEFAULT_REASONING_EFFORT
  );
}

function buildGrokReasoningOptionDescriptor(
  levels: ReadonlyArray<{ value: string; label: string; isDefault?: boolean }> = [
    { value: "high", label: "High", isDefault: true },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
  ],
) {
  return buildSelectOptionDescriptor({
    id: "reasoning",
    label: "Reasoning",
    description: "Grok reasoning effort (same levels as the Grok terminal).",
    options: levels,
  });
}

const DEFAULT_GROK_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [buildGrokReasoningOptionDescriptor()],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const GROK_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "grok-build",
    name: "Grok Build",
    isCustom: false,
    capabilities: DEFAULT_GROK_CAPABILITIES,
  },
];

export function grokAuthAfterSuccessfulAcpDiscovery(): ServerProviderAuth {
  return { status: "authenticated", label: "Grok Account" };
}

export function buildInitialGrokProviderSnapshot(
  grokSettings: GrokSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = grokModelsFromSettings(grokSettings.customModels);

    if (!grokSettings.enabled) {
      return buildServerProvider({
        presentation: GROK_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Grok is disabled in Toolport Studio settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Grok CLI availability...",
      },
    });
  });
}

function grokModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = GROK_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], DEFAULT_GROK_CAPABILITIES);
}

function reasoningLevelsFromGrokModelMeta(
  meta: { readonly [x: string]: unknown } | null | undefined,
): ReadonlyArray<{ value: string; label: string; isDefault?: boolean }> | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const efforts = meta.reasoningEfforts;
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return undefined;
  }
  const levels = efforts.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const valueRaw =
      typeof record.value === "string"
        ? record.value
        : typeof record.id === "string"
          ? record.id
          : undefined;
    const value = normalizeGrokReasoningEffort(valueRaw);
    if (!value) {
      return [];
    }
    const label =
      typeof record.label === "string" && record.label.trim().length > 0
        ? record.label.trim()
        : value.charAt(0).toUpperCase() + value.slice(1);
    const isDefault = record.default === true;
    return [{ value, label, ...(isDefault ? { isDefault: true as const } : {}) }];
  });
  if (levels.length === 0) {
    return undefined;
  }
  // Prefer agent-advertised default; else mark high or first entry.
  if (!levels.some((level) => level.isDefault)) {
    const high = levels.find((level) => level.value === GROK_DEFAULT_REASONING_EFFORT);
    if (high) {
      high.isDefault = true;
    } else {
      levels[0] = { ...levels[0]!, isDefault: true };
    }
  }
  // If meta also reports current reasoningEffort, prefer that as default.
  const current = normalizeGrokReasoningEffort(
    typeof meta.reasoningEffort === "string" ? meta.reasoningEffort : undefined,
  );
  if (current) {
    for (const level of levels) {
      if (level.value === current) {
        level.isDefault = true;
      } else if (level.isDefault && level.value !== current) {
        delete level.isDefault;
      }
    }
  }
  return levels;
}

function capabilitiesFromGrokModelInfo(model: EffectAcpSchema.ModelInfo): ModelCapabilities {
  const levels = reasoningLevelsFromGrokModelMeta(model._meta ?? undefined);
  if (levels && levels.length > 0) {
    return createModelCapabilities({
      optionDescriptors: [buildGrokReasoningOptionDescriptor(levels)],
    });
  }
  // Agent omitted effort metadata — still offer the standard TUI levels.
  if (
    model._meta &&
    (model._meta as { supportsReasoningEffort?: unknown }).supportsReasoningEffort === true
  ) {
    return DEFAULT_GROK_CAPABILITIES;
  }
  return DEFAULT_GROK_CAPABILITIES;
}

function buildGrokDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveGrokAcpBaseModelId(model.modelId);
      if (!slug || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: capabilitiesFromGrokModelInfo(model),
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

const discoverGrokModelsViaAcp = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeGrokAcpRuntime({
      grokSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildGrokDiscoveredModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

const runGrokVersionCommand = (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = grokSettings.binaryPath || "grok";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(function* (
  grokSettings: GrokSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = grokModelsFromSettings(grokSettings.customModels);

  if (!grokSettings.enabled) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Grok is disabled in Toolport Studio settings.",
      },
    });
  }

  const versionResult = yield* runGrokVersionCommand(grokSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Grok CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Grok CLI (`grok`) is not installed or not on PATH."
          : "Failed to execute Grok CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but timed out while running `grok --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Grok CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverGrokModelsViaAcp(grokSettings, environment).pipe(
    Effect.timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Grok ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Grok CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Grok ACP model discovery timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: GROK_PRESENTATION,
      enabled: grokSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Grok CLI is installed but ACP startup timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? grokModelsFromSettings(grokSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: GROK_PRESENTATION,
    enabled: grokSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      // A successful ACP session and model discovery requires usable Grok
      // credentials, even though Grok does not expose account metadata.
      auth: grokAuthAfterSuccessfulAcpDiscovery(),
    },
  });
});

export const enrichGrokSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Grok version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
