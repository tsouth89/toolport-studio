import { describe, expect, it } from "vite-plus/test";

import { shouldMountPreviewAutomationHosts } from "./PreviewAutomationHosts";

describe("shouldMountPreviewAutomationHosts", () => {
  it("registers the full desktop shell as an automation host", () => {
    expect(
      shouldMountPreviewAutomationHosts({
        isElectron: true,
        automationAvailable: true,
        chatOnlyShell: false,
      }),
    ).toBe(true);
  });

  it("does not register chat-only pop-outs that cannot render a preview", () => {
    expect(
      shouldMountPreviewAutomationHosts({
        isElectron: true,
        automationAvailable: true,
        chatOnlyShell: true,
      }),
    ).toBe(false);
  });
});
