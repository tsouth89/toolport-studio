import { describe, expect, it } from "vite-plus/test";

import {
  deriveToolActivityPresentation,
  humanizeToolDisplayName,
  looksLikeWireToolName,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a Grok Build-style Run headline", () => {
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
      summary: "Run bun run lint",
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
      summary: "Read app.ts",
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

  it("humanizes wire-form titles that providers set as the display name", () => {
    expect(looksLikeWireToolName("toolport__toolport_call_tool")).toBe(true);
    expect(looksLikeWireToolName("mcp__linear__list_issues")).toBe(true);
    expect(looksLikeWireToolName("t3-code · preview_status")).toBe(false);
    expect(humanizeToolDisplayName("toolport__toolport_call_tool")).toBe("Toolport call tool");
    expect(humanizeToolDisplayName("mcp__linear__list_issues")).toBe("Linear · list issues");
    expect(humanizeToolDisplayName("t3-code · preview_status")).toBe("t3-code · preview_status");

    expect(
      deriveToolActivityPresentation({
        itemType: "mcp_tool_call",
        title: "toolport__toolport_search_tools",
        fallbackSummary: "toolport__toolport_search_tools",
      }),
    ).toEqual({
      summary: "Toolport search tools",
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
      summary: "Searched deriveThreadActivity",
      detail: "deriveThreadActivity",
    });
  });

  it("classifies bash/shell titles as Run lines even without command_execution itemType", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Bash",
        data: {
          command: "git status --short",
        },
        fallbackSummary: "Bash",
      }),
    ).toEqual({
      summary: "Run git status --short",
      detail: "git status --short",
    });
  });

  it("classifies Read/grep wire titles without relying on itemType alone", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "read_file",
        data: {
          locations: [{ path: "apps/web/src/App.tsx" }],
        },
        fallbackSummary: "read_file",
      }),
    ).toEqual({
      summary: "Read App.tsx",
      detail: "apps/web/src/App.tsx",
    });
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "grep",
        data: {
          rawInput: { pattern: "formatWorkLogTimelineLine" },
        },
        fallbackSummary: "grep",
      }),
    ).toEqual({
      summary: "Searched formatWorkLogTimelineLine",
      detail: "formatWorkLogTimelineLine",
    });
  });
});
