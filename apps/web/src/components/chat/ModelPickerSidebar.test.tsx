import { ProviderDriverKind, ProviderInstanceId } from "@toolport-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelPickerSidebar } from "./ModelPickerSidebar";
import type { ProviderInstanceEntry } from "../../providerInstances";

function readyEntry(input: {
  instanceId: string;
  displayName: string;
  driverKind: string;
  presetId?: string;
}): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driverKind: ProviderDriverKind.make(input.driverKind),
    displayName: input.displayName,
    enabled: true,
    installed: true,
    status: "ready",
    isDefault: false,
    isAvailable: true,
    models: [],
    ...(input.presetId ? { presetId: input.presetId } : {}),
    snapshot: { message: undefined },
  } as unknown as ProviderInstanceEntry;
}

describe("ModelPickerSidebar", () => {
  it("keeps smart views and account identities persistently labeled", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        selectedInstanceId="recommended"
        onSelectInstance={() => {}}
        instanceEntries={[
          readyEntry({
            instanceId: "claude_personal",
            displayName: "Claude Personal",
            driverKind: "claudeAgent",
          }),
          readyEntry({
            instanceId: "deepseek_work",
            displayName: "DeepSeek Work",
            driverKind: "byok",
            presetId: "deepseek",
          }),
        ]}
        onManageProviders={() => {}}
      />,
    );

    expect(markup).toContain("Views");
    expect(markup).toContain("For you");
    expect(markup).not.toContain("Favorites");
    expect(markup).toContain("Accounts");
    expect(markup).toContain("Claude Personal");
    expect(markup).toContain("DeepSeek Work");
    expect(markup).toContain("Manage providers");
    expect(markup).toContain('data-model-picker-provider="claude_personal"');
    expect(markup).toContain('data-model-picker-provider="deepseek_work"');
  });
});
