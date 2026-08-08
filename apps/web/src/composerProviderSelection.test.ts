import { ProviderDriverKind, ProviderInstanceId } from "@toolport-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveComposerProviderSelection } from "./composerProviderSelection";
import type { ProviderInstanceEntry } from "./providerInstances";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

function entry(input: {
  readonly id: string;
  readonly driver: ProviderDriverKind;
  readonly name: string;
  readonly enabled?: boolean;
  readonly available?: boolean;
  readonly continuationGroupKey?: string;
}): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(input.id),
    driverKind: input.driver,
    displayName: input.name,
    enabled: input.enabled ?? true,
    installed: true,
    status: "ready",
    isDefault: true,
    isAvailable: input.available ?? true,
    models: [],
    snapshot: {} as ProviderInstanceEntry["snapshot"],
    ...(input.continuationGroupKey ? { continuationGroupKey: input.continuationGroupKey } : {}),
  };
}

function resolve(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  explicitSelectedInstanceId: string,
  options?: {
    readonly lockedProvider?: ProviderDriverKind | null;
    readonly lockedContinuationGroupKey?: string | null;
  },
) {
  return resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [explicitSelectedInstanceId],
    explicitSelectedInstanceId: ProviderInstanceId.make(explicitSelectedInstanceId),
    requestedDriverKind: entries[0]?.driverKind ?? codex,
    lockedProvider: options?.lockedProvider ?? null,
    lockedContinuationGroupKey: options?.lockedContinuationGroupKey ?? null,
  });
}

describe("resolveComposerProviderSelection", () => {
  it.each([
    { enabled: true, available: false, reason: "unavailable" as const },
    { enabled: false, available: true, reason: "disabled" as const },
  ])("blocks an explicit $reason pick instead of consenting to fallback", (state) => {
    const result = resolve(
      [
        entry({ id: "grok", driver: codex, name: "Grok", ...state }),
        entry({ id: "cursor", driver: claude, name: "Cursor" }),
      ],
      "grok",
    );

    expect(result.instanceId).toBe("cursor");
    expect(result.explicitSelectionBlock).toMatchObject({
      requestedDisplayName: "Grok",
      reason: state.reason,
      fallback: { instanceId: "cursor", displayName: "Cursor" },
    });
  });

  it("blocks when the explicit instance was removed from configuration", () => {
    const result = resolve([entry({ id: "cursor", driver: claude, name: "Cursor" })], "grok");

    expect(result.instanceId).toBe("cursor");
    expect(result.explicitSelectionBlock).toMatchObject({
      requestedDisplayName: "Selected provider",
      reason: "removed",
    });
  });

  it("uses an available explicit pick without a block", () => {
    const result = resolve(
      [
        entry({ id: "grok", driver: codex, name: "Grok" }),
        entry({ id: "cursor", driver: claude, name: "Cursor" }),
      ],
      "grok",
    );

    expect(result.instanceId).toBe("grok");
    expect(result.explicitSelectionBlock).toBeNull();
  });

  it("does not mistake an expected continuation lock for availability substitution", () => {
    const result = resolve(
      [
        entry({ id: "grok", driver: codex, name: "Grok" }),
        entry({ id: "cursor", driver: claude, name: "Cursor" }),
      ],
      "grok",
      { lockedProvider: claude },
    );

    expect(result.instanceId).toBe("cursor");
    expect(result.explicitSelectionBlock).toBeNull();
  });
});
