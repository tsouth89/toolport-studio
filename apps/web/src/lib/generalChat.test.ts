import { describe, expect, it } from "vite-plus/test";

import {
  GENERAL_CHAT_TITLE,
  GENERAL_CHAT_WORKSPACE_ROOT,
  isGeneralChatProject,
} from "./generalChat.ts";

describe("generalChat", () => {
  it("exports a stable home-relative workspace root", () => {
    expect(GENERAL_CHAT_TITLE).toBe("General");
    expect(GENERAL_CHAT_WORKSPACE_ROOT.startsWith("~/")).toBe(true);
  });

  it("detects the system project by path without hiding real projects named General", () => {
    expect(
      isGeneralChatProject({
        title: "General",
        workspaceRoot: "C:\\Users\\me\\somewhere",
      }),
    ).toBe(false);
    expect(
      isGeneralChatProject({
        title: "Other",
        workspaceRoot: "C:\\Users\\me\\Toolport Studio\\General",
      }),
    ).toBe(true);
    expect(
      isGeneralChatProject({
        title: "toolport-studio",
        workspaceRoot: "/home/me/code/toolport-studio",
      }),
    ).toBe(false);
  });
});
