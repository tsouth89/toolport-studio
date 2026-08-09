import type { ProviderDriverKind, ProviderInstanceId } from "@toolport-studio/contracts";

import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "./providerInstances";

export type ExplicitProviderSelectionBlock = {
  readonly requestedInstanceId: ProviderInstanceId;
  readonly requestedDisplayName: string;
  readonly reason: "disabled" | "unavailable" | "removed";
  readonly fallback: ProviderInstanceEntry | null;
};

export type ComposerProviderSelection = {
  readonly instanceId: ProviderInstanceId;
  readonly entry: ProviderInstanceEntry | undefined;
  readonly explicitSelectionBlock: ExplicitProviderSelectionBlock | null;
};

/**
 * Resolve the provider the composer can offer without treating that fallback
 * as user consent. An explicit unavailable pick remains a blocking state until
 * the user deliberately accepts the suggested replacement (SBS-570).
 */
export function resolveComposerProviderSelection(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly candidateInstanceIds: ReadonlyArray<string | null | undefined>;
  readonly explicitSelectedInstanceId: ProviderInstanceId | null;
  readonly requestedDriverKind: ProviderDriverKind;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
}): ComposerProviderSelection {
  const isCompatible = (entry: ProviderInstanceEntry): boolean =>
    (!input.lockedProvider || entry.driverKind === input.lockedProvider) &&
    (!input.lockedContinuationGroupKey ||
      entry.continuationGroupKey === input.lockedContinuationGroupKey);

  let instanceId: ProviderInstanceId | null = null;
  for (const candidate of input.candidateInstanceIds) {
    if (!candidate) continue;
    const match = input.entries.find(
      (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
    );
    if (match && isCompatible(match)) {
      instanceId = match.instanceId;
      break;
    }
  }

  if (instanceId === null) {
    const compatibleEntries = input.entries.filter(isCompatible);
    const requestedDriverEntries = compatibleEntries.filter(
      (entry) => entry.driverKind === input.requestedDriverKind,
    );
    instanceId =
      resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined)?.instanceId ??
      resolveSelectableProviderInstanceEntry(compatibleEntries, undefined)?.instanceId ??
      NO_PROVIDER_MODEL_SELECTION.instanceId;
  }

  const entry = input.entries.find((candidate) => candidate.instanceId === instanceId);
  const explicitInstanceId = input.explicitSelectedInstanceId;
  if (!explicitInstanceId || explicitInstanceId === instanceId) {
    return { instanceId, entry, explicitSelectionBlock: null };
  }

  const requestedEntry = input.entries.find(
    (candidate) => candidate.instanceId === explicitInstanceId,
  );
  // A selectable explicit entry can only have been skipped by the thread's
  // provider/continuation lock. That is an expected continuation constraint,
  // not an availability substitution.
  if (requestedEntry?.enabled && requestedEntry.isAvailable) {
    return { instanceId, entry, explicitSelectionBlock: null };
  }
  if (requestedEntry && !isCompatible(requestedEntry)) {
    return { instanceId, entry, explicitSelectionBlock: null };
  }

  return {
    instanceId,
    entry,
    explicitSelectionBlock: {
      requestedInstanceId: explicitInstanceId,
      requestedDisplayName: requestedEntry?.displayName ?? "Selected provider",
      reason: requestedEntry ? (requestedEntry.enabled ? "unavailable" : "disabled") : "removed",
      fallback: entry ?? null,
    },
  };
}
