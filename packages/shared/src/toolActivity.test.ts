import { describe, expect, it } from "vite-plus/test";

import {
  deriveToolActivityPresentation,
  formatMcpServerDisplayName,
  formatMcpToolInspectBody,
  formatMcpToolInspectHeadline,
  formatShellCommandHeadline,
  humanizeToolDisplayName,
  looksLikeWireToolName,
  summarizeShellCommand,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a verb-first action gist", () => {
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
      summary: "Ran bun run lint",
      detail: "bun run lint",
    });
  });

  it("gists chained shell commands instead of dumping the whole string", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        data: {
          command:
            "git log --oneline -20; git status -sb; git log origin/main..HEAD --oneline 2>$null; if ($?) { echo ok }",
        },
        fallbackSummary: "Terminal",
      }).summary,
    ).toBe("Ran git log +2 more");

    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        data: {
          command: `python -c "from pathlib import Path; p=Path(r'C:\\Users\\me\\.grok'); print(p)"`,
        },
        fallbackSummary: "Terminal",
      }).summary,
    ).toBe("Ran python");
  });

  it("keeps subcommands for tools whose first word is the action", () => {
    const summaryFor = (command: string) =>
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        data: { command },
        fallbackSummary: "Terminal",
      }).summary;

    expect(summaryFor("npm run build")).toBe("Ran npm run build");
    expect(summaryFor("gh pr checks 479 --watch")).toBe("Ran gh pr checks");
    expect(summaryFor("git commit -m 'wip; not done'")).toBe("Ran git commit");
    expect(summaryFor("rg --files-with-matches foo | head -20")).toBe("Ran rg");
    expect(summaryFor("sudo NODE_ENV=production /usr/local/bin/pnpm exec vitest")).toBe(
      "Ran pnpm exec vitest",
    );
    expect(summaryFor("$env:CI = '1'")).toBe("Ran a command");
  });

  it("gists the shell shapes that used to dump into the Working row", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        "git log --oneline -20; git status -sb; git log origin/main..HEAD --oneline 2>$null",
        "git log +2 more",
      ],
      [
        "git fetch origin production; git checkout -B polish/account-settings-density origin/production",
        "git fetch +1 more",
      ],
      ["pnpm vp test apps/web && pnpm lint", "pnpm vp +1 more"],
      ["cd apps/web && npm run build", "cd +1 more"],
      ["docker compose up -d", "docker compose up"],
      ["kubectl get pods -n prod", "kubectl get pods"],
      ["cat package.json | jq .scripts", "cat"],
      ["C:\\Python311\\python.exe -m pytest -q", "python"],
    ];

    for (const [command, expected] of cases) {
      expect(summarizeShellCommand(command)).toBeDefined();
      expect(formatShellCommandHeadline(command, "Ran")).toBe(`Ran ${expected}`);
    }
  });

  it("narrates open tools in the present tense", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        tense: "present",
        data: { command: "git log --oneline -20; git status -sb" },
        fallbackSummary: "Terminal",
      }).summary,
    ).toBe("Running git log +1 more");

    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        tense: "present",
        data: { kind: "read", locations: [{ path: "/tmp/app.ts" }] },
        fallbackSummary: "Read File",
      }).summary,
    ).toBe("Reading app.ts");
  });

  it("re-gists legacy headlines that baked the whole command into the title", () => {
    expect(
      deriveToolActivityPresentation({
        title: "Run git log --oneline -20; git status -sb",
        fallbackSummary: "Terminal",
      }).summary,
    ).toBe("Ran git log +1 more");

    // A tool genuinely named "Run tests" is not shell — leave it alone.
    expect(
      deriveToolActivityPresentation({
        title: "Run tests",
        fallbackSummary: "Run tests",
      }).summary,
    ).toBe("Run tests");
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
      summary: "Read a file",
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
      summary: "Ran a Toolport script",
    });
  });

  it("humanizes wire-form titles that providers set as the display name", () => {
    expect(looksLikeWireToolName("toolport__toolport_call_tool")).toBe(true);
    expect(looksLikeWireToolName("mcp__linear__list_issues")).toBe(true);
    expect(looksLikeWireToolName("t3-code · preview_status")).toBe(false);
    expect(humanizeToolDisplayName("toolport__toolport_call_tool")).toBe("Call tool");
    expect(humanizeToolDisplayName("mcp__linear__list_issues")).toBe("Linear · list issues");
    expect(humanizeToolDisplayName("t3-code · preview_status")).toBe("t3-code · preview_status");

    expect(
      deriveToolActivityPresentation({
        itemType: "mcp_tool_call",
        title: "toolport__toolport_search_tools",
        fallbackSummary: "toolport__toolport_search_tools",
      }),
    ).toEqual({
      summary: "Searched Toolport tools",
    });
  });

  it("surfaces the routed Toolport tool instead of call_tool gateway noise", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "mcp_tool_call",
        title: "toolport__toolport_call_tool",
        data: {
          rawInput: {
            name: "toolport__toolport_call_tool",
            arguments: { name: "linear_2__list_issues" },
          },
        },
        fallbackSummary: "toolport__toolport_call_tool",
      }),
    ).toEqual({
      summary: "Called Linear · list issues",
    });
    expect(
      deriveToolActivityPresentation({
        itemType: "mcp_tool_call",
        title: "toolport__toolport_call_tool",
        fallbackSummary: "toolport__toolport_call_tool",
      }),
    ).toEqual({
      summary: "Called a tool via Toolport",
    });
  });

  it("humanizes MCP inspect headlines and bodies for Toolport routes", () => {
    expect(formatMcpServerDisplayName("linear_2")).toBe("Linear");
    // Registry/branded labels keep their casing (GitHub, not Github).
    expect(formatMcpServerDisplayName("GitHub")).toBe("GitHub");
    expect(formatMcpServerDisplayName("OpenAI")).toBe("OpenAI");
    expect(
      formatMcpToolInspectHeadline({
        arguments: { name: "linear_2__save_comment", body: "hi" },
      }),
    ).toBe("Linear · save comment");
    const body = formatMcpToolInspectBody({
      arguments: { name: "linear_2__save_comment", body: "hi" },
    });
    expect(body).toContain("Linear · save comment");
    expect(body).toContain('"body": "hi"');
    expect(body).not.toContain("toolport__");
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

  it("classifies bash/shell titles as command lines even without command_execution itemType", () => {
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
      summary: "Ran git status",
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
