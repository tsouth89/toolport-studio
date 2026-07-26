import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("humanizes structured tool names instead of generic Tool", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Tool",
        data: {
          rawInput: {
            tool_name: "toolport__toolport_run_script",
          },
        },
        fallbackSummary: "Tool",
      }),
    ).toEqual({
      summary: "Toolport run script",
    });
  });

  it("falls back to itemType labels when title is generic", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "web_search",
        title: "Tool",
        data: {
          kind: "search",
          rawInput: { pattern: "deriveThreadActivity" },
        },
        fallbackSummary: "Tool",
      }),
    ).toEqual({
      summary: "Searched files",
      detail: "deriveThreadActivity",
    });
  });
});
