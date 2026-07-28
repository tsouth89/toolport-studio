import type { ToolLifecycleItemType } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

/**
 * Older builds (and providers copying them) persisted the whole shell string as
 * the headline: `Run git log --oneline -20; git status -sb; …`. Recover the
 * command so those rows re-render as a gist instead of a dump. Only treat the
 * tail as shell when it actually looks like shell — "Run tests" is a tool name.
 */
function legacyRunHeadlineCommand(title: string | undefined): string | undefined {
  const match = /^(?:run|ran|running)\s+(?<command>\S.*)$/iu.exec(title?.trim() ?? "");
  const command = match?.groups?.command?.trim();
  if (!command) {
    return undefined;
  }
  return /(?:\s-{1,2}[a-z0-9]|[;|&$"']|\d>|[/\\])/iu.test(command) ? command : undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

// ---------------------------------------------------------------------------
// Shell command gist
//
// Headlines name the action, never the argv. `git log --oneline -20; git
// status -sb; …` reads as "Ran git log +2 more"; the full string stays in the
// row tooltip and the expanded step body.
// ---------------------------------------------------------------------------

/** Programs whose first bare word is the real action (`git log`, `npm run build`). */
const SUBCOMMAND_PROGRAMS = new Set([
  "apt",
  "apt-get",
  "aws",
  "az",
  "brew",
  "bun",
  "bunx",
  "cargo",
  "deno",
  "docker",
  "dotnet",
  "flutter",
  "gcloud",
  "gh",
  "git",
  "glab",
  "go",
  "helm",
  "kubectl",
  "nix",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "podman",
  "poetry",
  "rustup",
  "systemctl",
  "terraform",
  "uv",
  "uvx",
  "yarn",
]);

/** Programs whose subcommands nest one level deeper (`gh pr checks`, `aws s3 ls`). */
const NESTED_SUBCOMMAND_PROGRAMS = new Set([
  "aws",
  "az",
  "docker",
  "gcloud",
  "gh",
  "glab",
  "helm",
  "kubectl",
  "nix",
  "podman",
]);

/** Words after which the next token is the real action (`npm run build`). */
const RUNNER_SUBCOMMANDS = new Set(["dlx", "exec", "run", "x"]);

/** Wrappers that precede the command the user actually cares about. */
const COMMAND_PREFIX_TOKENS = new Set([
  "command",
  "do",
  "env",
  "exec",
  "nohup",
  "sudo",
  "then",
  "time",
]);

/** Shell/PowerShell control words — not commands worth counting or naming. */
const CONTROL_KEYWORDS = new Set([
  "case",
  "catch",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "finally",
  "for",
  "foreach",
  "function",
  "if",
  "param",
  "return",
  "switch",
  "try",
  "while",
]);

/** Split on sequencing operators only — a pipeline is one step, not several. */
function splitShellSequence(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if ((char === "&" || char === "|") && command[index + 1] === char) {
      index += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);

  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** Quote-aware whitespace split, stopping at the first pipe/redirect. */
function shellHeadTokens(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const push = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (const char of segment) {
    if (quote !== null) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "|" || char === ">" || char === "<") {
      break;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    current += char;
  }
  push();

  return tokens;
}

function normalizeProgramToken(token: string): string | undefined {
  const unquoted = token.replace(/^["']|["']$/gu, "").trim();
  if (unquoted.length === 0 || /^[-$({[]/u.test(unquoted)) {
    return undefined;
  }
  const base = unquoted.split(/[/\\]/u).pop()?.trim();
  if (!base || base.length === 0) {
    return undefined;
  }
  const program = base.replace(/\.(?:exe|cmd|bat)$/iu, "");
  if (program.length === 0 || CONTROL_KEYWORDS.has(program.toLowerCase())) {
    return undefined;
  }
  return program;
}

/** Bare word that reads as a subcommand — not a flag, path, number, or value. */
function looksLikeSubcommandToken(token: string): boolean {
  return /^[a-z][a-z0-9:_-]{0,23}$/u.test(token);
}

function segmentCommandGist(segment: string): string | undefined {
  const tokens = shellHeadTokens(segment);
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1;
      continue;
    }
    const normalized = normalizeProgramToken(token)?.toLowerCase();
    if (normalized !== undefined && COMMAND_PREFIX_TOKENS.has(normalized)) {
      index += 1;
      continue;
    }
    break;
  }

  const program = normalizeProgramToken(tokens[index] ?? "");
  if (!program) {
    return undefined;
  }
  if (!SUBCOMMAND_PROGRAMS.has(program.toLowerCase())) {
    return program;
  }

  // One subcommand for most tools (`git fetch`, not `git fetch origin`), two for
  // nested CLIs, plus one more after a runner word (`pnpm exec vitest`).
  let allowance = NESTED_SUBCOMMAND_PROGRAMS.has(program.toLowerCase()) ? 2 : 1;
  const parts = [program];
  for (let next = index + 1; next < tokens.length && allowance > 0; next += 1) {
    const token = tokens[next]!;
    if (!looksLikeSubcommandToken(token)) {
      break;
    }
    parts.push(token);
    allowance -= 1;
    if (RUNNER_SUBCOMMANDS.has(token.toLowerCase())) {
      allowance += 1;
    }
  }
  return parts.join(" ");
}

export interface ShellCommandSummary {
  /** Program plus subcommand, e.g. `git log`, `npm run build`, `python`. */
  readonly gist: string;
  /** Additional sequenced commands beyond the first. */
  readonly extraCount: number;
}

/** Action gist for a shell string, or undefined when nothing nameable is in it. */
export function summarizeShellCommand(command: string): ShellCommandSummary | undefined {
  const gists: string[] = [];
  for (const segment of splitShellSequence(command)) {
    const gist = segmentCommandGist(segment);
    if (gist !== undefined) {
      gists.push(gist);
    }
  }
  const first = gists[0];
  if (first === undefined) {
    return undefined;
  }
  return { gist: truncateToolHeadline(first, 40), extraCount: gists.length - 1 };
}

/** `Ran git log +2 more` / `Running npm run build`. */
export function formatShellCommandHeadline(command: string, verb: string): string | undefined {
  const summary = summarizeShellCommand(command);
  if (!summary) {
    return undefined;
  }
  return summary.extraCount > 0
    ? `${verb} ${summary.gist} +${summary.extraCount} more`
    : `${verb} ${summary.gist}`;
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPaths(data: Record<string, unknown> | undefined): string[] {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths;
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

/**
 * Every headline is verb-first so the rail reads uniformly. Open tools use the
 * progressive form ("Running git log"); settled ones use the simple past.
 */
export type ToolActivityTense = "past" | "present";

const TOOL_ACTIVITY_VERBS = {
  run: { past: "Ran", present: "Running" },
  read: { past: "Read", present: "Reading" },
  edit: { past: "Edited", present: "Editing" },
  search: { past: "Searched", present: "Searching" },
  call: { past: "Called", present: "Calling" },
  view: { past: "Viewed", present: "Viewing" },
} as const;

function verb(kind: keyof typeof TOOL_ACTIVITY_VERBS, tense: ToolActivityTense): string {
  return TOOL_ACTIVITY_VERBS[kind][tense];
}

/** Headlines that name no specific action — safe for a better label to replace. */
const GENERIC_TOOL_TITLES = new Set([
  "",
  "calling a tool",
  "calling an agent",
  "ran a command",
  "ran a tool",
  "running a command",
  "running a tool",
  "terminal",
  "tool",
  "tool call",
  "toolcall",
]);

/** Public twin of the internal check — lets transports refuse title downgrades. */
export function isGenericToolActivityTitle(value: string | null | undefined): boolean {
  return isGenericToolTitle(value ?? undefined);
}

function isGenericToolTitle(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+(?:complete|completed|started|updated)\s*$/u, "")
    .trim();
  return GENERIC_TOOL_TITLES.has(normalized);
}

function humanizeServerSegment(server: string): string {
  const trimmed = server.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  // linear_2 / linear-2 → Linear (strip trailing instance suffixes first).
  const withoutInstance = trimmed.replace(/[_-]+\d+$/u, "");
  // Preserve already-branded registry labels (GitHub, OpenAI) — do not
  // force Titlecase that would turn GitHub into Github.
  if (
    !/[_-]/u.test(withoutInstance) &&
    /[a-z]/u.test(withoutInstance) &&
    /[A-Z]/u.test(withoutInstance.slice(1))
  ) {
    return withoutInstance;
  }
  const base = withoutInstance.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (base.length === 0) {
    return trimmed;
  }
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
}

function humanizeToolSegment(tool: string): string {
  const normalized = tool.trim().replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return tool.trim();
  }
  // Tool names read better as sentence-case: "list issues", "save comment".
  return normalized.toLowerCase();
}

function humanizeStructuredToolName(value: string): string {
  let name = value.trim();
  // Common MCP / Toolport prefixes: server__tool or toolport__toolport_run_script
  name = name.replace(/^(?:mcp__|toolport__)+/iu, "");
  // Gateway tools are often toolport__toolport_call_tool → remaining "toolport_call_tool"
  name = name.replace(/^toolport(?:__|_)+/iu, "");

  // Prefer server__tool splitting before collapsing underscores.
  if (name.includes("__")) {
    const parts = name
      .split("__")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const server = humanizeServerSegment(parts[0]!);
      const tool = humanizeToolSegment(parts.slice(1).join("_"));
      return `${server} · ${tool}`;
    }
  }

  name = name.replace(/__/gu, " · ");
  name = name.replace(/[_-]+/gu, " ");
  name = name.replace(/\s+/gu, " ").trim();
  // Drop redundant "toolport · " after prefix strip (call tool, search tools, …).
  name = name.replace(/^toolport\s*·\s*/iu, "").trim();
  if (name.length === 0) {
    return value.trim();
  }
  if (name.includes(" · ")) {
    const [serverPart, ...toolParts] = name.split(" · ");
    return `${humanizeServerSegment(serverPart ?? "")} · ${humanizeToolSegment(toolParts.join(" "))}`;
  }
  // Single token / phrase: "call tool", "search tools"
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/** Known Toolport gateway meta-tools (not the downstream MCP tool itself). */
function isToolportGatewayMetaToolName(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^(?:mcp__|toolport__)+/gu, "")
    .replace(/__/gu, "_")
    .replace(/^toolport_/u, "");
  return (
    normalized === "call_tool" ||
    normalized === "toolport_call_tool" ||
    normalized === "search_tools" ||
    normalized === "toolport_search_tools" ||
    normalized === "status" ||
    normalized === "toolport_status" ||
    normalized === "run_script" ||
    normalized === "toolport_run_script" ||
    normalized === "fetch_result" ||
    normalized === "toolport_fetch_result"
  );
}

function toolportGatewayMetaSummary(
  value: string,
  tense: ToolActivityTense,
  nestedToolName?: string,
): string | undefined {
  if (!isToolportGatewayMetaToolName(value)) {
    return undefined;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^(?:mcp__|toolport__)+/gu, "")
    .replace(/__/gu, "_")
    .replace(/^toolport_/u, "");
  if (normalized === "call_tool" || normalized === "toolport_call_tool") {
    if (nestedToolName) {
      return `${verb("call", tense)} ${nestedToolName}`;
    }
    return tense === "present" ? "Calling a tool via Toolport" : "Called a tool via Toolport";
  }
  if (normalized === "search_tools" || normalized === "toolport_search_tools") {
    return tense === "present" ? "Searching Toolport tools" : "Searched Toolport tools";
  }
  if (normalized === "status" || normalized === "toolport_status") {
    return tense === "present" ? "Checking Toolport status" : "Checked Toolport status";
  }
  if (normalized === "run_script" || normalized === "toolport_run_script") {
    return tense === "present" ? "Running a Toolport script" : "Ran a Toolport script";
  }
  if (normalized === "fetch_result" || normalized === "toolport_fetch_result") {
    return tense === "present" ? "Fetching a Toolport result" : "Fetched a Toolport result";
  }
  return undefined;
}

/**
 * Wire-form tool ids providers sometimes surface as titles
 * (`toolport__toolport_call_tool`, `mcp__linear__list_issues`). Friendly labels
 * with spaces (including `server · tool`) are left alone.
 */
export function looksLikeWireToolName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/\s/u.test(trimmed) && !/__/u.test(trimmed)) {
    return false;
  }
  return /__/u.test(trimmed) || /^(?:mcp|toolport)[_-]/iu.test(trimmed);
}

/** Humanize a tool title when it looks like a machine/wire name; otherwise pass through. */
export function humanizeToolDisplayName(value: string): string {
  const trimmed = value.trim();
  if (!looksLikeWireToolName(trimmed)) {
    // Still normalize short server ids (linear_2 → Linear) for chips/lists.
    if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/iu.test(trimmed) && trimmed.length <= 32) {
      return humanizeServerSegment(trimmed);
    }
    return trimmed;
  }
  return humanizeStructuredToolName(trimmed);
}

/** Display name for an MCP server id/label (linear_2 → Linear). */
export function formatMcpServerDisplayName(server: string): string {
  return humanizeServerSegment(server);
}

/**
 * One-line headline for expanded MCP tool rows / inspect panels.
 * Prefers routed Toolport tools over gateway meta noise.
 */
export function formatMcpToolInspectHeadline(toolData: unknown): string | null {
  if (toolData === null || typeof toolData !== "object") {
    return null;
  }
  const record = toolData as Record<string, unknown>;
  const asData: Record<string, unknown> = {
    item: record,
    rawInput: asRecord(record.rawInput) ?? record,
    arguments: record.arguments,
    input: record.input,
    server: record.server,
    tool: record.tool,
  };
  const routed = extractToolportRoutedToolName(asData);
  if (routed) {
    return routed;
  }
  const server = asTrimmedString(record.server);
  const tool = asTrimmedString(record.tool);
  if (server && tool && !isToolportGatewayMetaToolName(tool)) {
    return `${humanizeServerSegment(server)} · ${humanizeToolSegment(tool)}`;
  }
  if (tool && !isToolportGatewayMetaToolName(tool)) {
    return humanizeStructuredToolName(tool);
  }
  if (server) {
    return humanizeServerSegment(server);
  }
  return null;
}

/**
 * Expanded MCP body for timeline/tool inspect. Humanized headline first;
 * arguments/result as pretty JSON without restating the gateway wire id.
 */
export function formatMcpToolInspectBody(toolData: unknown): string | null {
  if (toolData === null || typeof toolData !== "object") {
    return null;
  }
  const record = toolData as Record<string, unknown>;
  const lines: string[] = [];
  const headline = formatMcpToolInspectHeadline(toolData);
  if (headline) {
    lines.push(headline);
  }

  const args = record.arguments ?? record.input ?? asRecord(record.rawInput)?.arguments;
  if (args !== undefined && args !== null) {
    if (typeof args === "string" && args.trim()) {
      const text = args.trim();
      // Skip pure wire names that only restate the headline.
      if (!looksLikeWireToolName(text) && text.toLowerCase() !== headline?.toLowerCase()) {
        lines.push(text.length > 1200 ? `${text.slice(0, 1199)}…` : text);
      }
    } else if (typeof args === "object") {
      const bag = args as Record<string, unknown>;
      // Prefer a short "name + other fields" view for toolport_call_tool payloads.
      const nestedName = asTrimmedString(bag.name) ?? asTrimmedString(bag.tool);
      const rest: Record<string, unknown> = { ...bag };
      if (nestedName) {
        delete rest.name;
        delete rest.tool;
      }
      const restKeys = Object.keys(rest);
      if (nestedName && restKeys.length === 0) {
        // Headline already carries the routed tool; skip empty args.
      } else {
        try {
          const pretty = JSON.stringify(restKeys.length > 0 ? rest : bag, null, 2);
          if (pretty.length > 0 && pretty !== "{}" && pretty !== "[]") {
            lines.push(pretty.length > 1200 ? `${pretty.slice(0, 1199)}…` : pretty);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const result = record.result ?? record.output ?? record.content;
  if (typeof result === "string" && result.trim()) {
    const text = result.trim();
    lines.push(text.length > 2000 ? `${text.slice(0, 1999)}…` : text);
  } else if (result && typeof result === "object") {
    try {
      const pretty = JSON.stringify(result, null, 2);
      if (pretty.length > 0 && pretty !== "{}" && pretty !== "[]") {
        lines.push(pretty.length > 1200 ? `${pretty.slice(0, 1199)}…` : pretty);
      }
    } catch {
      // ignore
    }
  }

  return lines.length > 0 ? lines.join("\n\n") : null;
}

/**
 * Nested tool name for Toolport gateway `call_tool` (arguments.name) so the
 * timeline shows "Called Linear · list issues" instead of "Called Toolport call tool".
 */
function extractToolportRoutedToolName(
  data: Record<string, unknown> | undefined,
): string | undefined {
  if (!data) {
    return undefined;
  }
  const rawInput = asRecord(data.rawInput);
  const item = asRecord(data.item);
  const argBags = [
    asRecord(rawInput?.arguments),
    asRecord(rawInput?.input),
    asRecord(item?.arguments),
    asRecord(item?.input),
    asRecord(data.arguments),
    asRecord(data.input),
  ];
  for (const bag of argBags) {
    if (!bag) continue;
    const nested =
      asTrimmedString(bag.name) ??
      asTrimmedString(bag.tool) ??
      asTrimmedString(bag.tool_name) ??
      asTrimmedString(bag.toolName);
    if (nested && !isGenericToolTitle(nested) && !isToolportGatewayMetaToolName(nested)) {
      return humanizeStructuredToolName(nested);
    }
  }
  return undefined;
}

function extractStructuredToolName(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const rawInput = asRecord(data.rawInput);
  const item = asRecord(data.item);
  // Prefer the routed downstream tool when this is a Toolport gateway call.
  const routed = extractToolportRoutedToolName(data);
  if (routed) {
    return routed;
  }
  const candidates = [
    asTrimmedString(rawInput?.tool_name),
    asTrimmedString(rawInput?.toolName),
    asTrimmedString(rawInput?.name),
    asTrimmedString(rawInput?.tool),
    asTrimmedString(item?.tool),
    asTrimmedString(item?.name),
    asTrimmedString(data.toolName),
    asTrimmedString(data.tool),
  ];
  for (const candidate of candidates) {
    if (candidate && !isGenericToolTitle(candidate) && !isToolportGatewayMetaToolName(candidate)) {
      return humanizeStructuredToolName(candidate);
    }
  }
  const server = asTrimmedString(item?.server) ?? asTrimmedString(data.server);
  const tool = asTrimmedString(item?.tool) ?? asTrimmedString(data.tool);
  if (server && tool && !isToolportGatewayMetaToolName(tool)) {
    // Prefer "Linear · list issues" over "Linear 2 · List issues".
    return `${humanizeServerSegment(server)} · ${humanizeToolSegment(tool)}`;
  }
  return undefined;
}

function defaultSummaryForItemType(
  itemType: ToolLifecycleItemType | undefined,
  tense: ToolActivityTense,
): string | undefined {
  switch (itemType) {
    case "command_execution":
      return `${verb("run", tense)} a command`;
    case "file_change":
      return `${verb("edit", tense)} files`;
    case "web_search":
      return verb("search", tense);
    case "image_view":
      return `${verb("view", tense)} an image`;
    case "mcp_tool_call":
      return `${verb("call", tense)} a tool`;
    case "dynamic_tool_call":
      return `${verb("run", tense)} a tool`;
    case "collab_agent_tool_call":
      return `${verb("call", tense)} an agent`;
    default:
      return undefined;
  }
}

function fileBasename(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

/** Short single-line headline for tool rows (Grok Build-style scannable lines). */
function truncateToolHeadline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function looksLikeShellToolTitle(title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  return (
    title === "terminal" ||
    title === "ran command" ||
    title === "bash" ||
    title === "shell" ||
    title === "powershell" ||
    title === "pwsh" ||
    title === "cmd" ||
    title === "zsh" ||
    title === "sh" ||
    title === "run command" ||
    title === "execute"
  );
}

function looksLikeReadToolTitle(title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  return (
    title === "read" ||
    title === "read file" ||
    title === "read files" ||
    title === "read_file" ||
    title === "readfile" ||
    title === "view" ||
    title === "view file" ||
    title === "cat"
  );
}

function looksLikeSearchToolTitle(title: string | undefined): boolean {
  if (!title) {
    return false;
  }
  return (
    title === "find" ||
    title === "grep" ||
    title === "rg" ||
    title === "glob" ||
    title === "search" ||
    title === "searched files" ||
    title === "web search" ||
    title === "web_search"
  );
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (
    itemType === "command_execution" ||
    kind === "execute" ||
    looksLikeShellToolTitle(title) ||
    legacyRunHeadlineCommand(input.title) !== undefined
  ) {
    return "command";
  }
  if (kind === "read" || looksLikeReadToolTitle(title)) {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (
    itemType === "web_search" ||
    kind === "search" ||
    kind === "fetch" ||
    looksLikeSearchToolTitle(title)
  ) {
    return "search";
  }
  // Nothing more specific matched, but the payload carries a real command —
  // "Ran sed" beats "Ran a tool" for providers that only send a generic title.
  if (isGenericToolTitle(title) && extractToolCommand(input.data, input.title) !== undefined) {
    return "command";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
  /** Open tools read "Running …"; settled tools read "Ran …". Defaults to past. */
  readonly tense?: ToolActivityTense | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const tense = input.tense ?? "past";
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title) ?? legacyRunHeadlineCommand(title);
  const paths = extractPaths(data);
  const primaryPath = paths[0];
  const structuredName = extractStructuredToolName(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    // Name the action, not the argv: "Ran git log +2 more". The full command
    // stays available as detail for tooltips and expanded rows.
    const headline = command ? formatShellCommandHeadline(command, verb("run", tense)) : undefined;
    return {
      summary: headline ?? `${verb("run", tense)} a command`,
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: `${verb("read", tense)} ${fileBasename(primaryPath)}`,
        detail: primaryPath,
      };
    }
    return {
      summary: `${verb("read", tense)} a file`,
    };
  }

  if (action === "file_change") {
    if (primaryPath) {
      const extra = paths.length - 1;
      const target =
        extra > 0 ? `${fileBasename(primaryPath)} +${extra}` : fileBasename(primaryPath);
      return {
        summary: `${verb("edit", tense)} ${target}`,
        detail: primaryPath,
      };
    }
    return {
      summary: `${verb("edit", tense)} files`,
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm) ??
      asTrimmedString(asRecord(data?.rawInput)?.path);
    const shortQuery = query ? truncateToolHeadline(query, 40) : undefined;
    return {
      summary: shortQuery ? `${verb("search", tense)} ${shortQuery}` : verb("search", tense),
      ...(query ? { detail: query } : {}),
    };
  }

  // Prefer a real structured tool name over generic "Tool" titles.
  if (structuredName) {
    const subtitle =
      detail && !isEquivalent(detail, title) && !isEquivalent(detail, structuredName)
        ? detail
        : (primaryPath ?? command);
    return {
      summary: `${verb("call", tense)} ${structuredName}`,
      ...(subtitle ? { detail: subtitle } : {}),
    };
  }

  const routedNested = extractToolportRoutedToolName(data);
  const wireTitleCandidates = [
    title,
    asTrimmedString(asRecord(data?.rawInput)?.tool_name),
    asTrimmedString(asRecord(data?.rawInput)?.toolName),
    asTrimmedString(asRecord(data?.rawInput)?.name),
    asTrimmedString(asRecord(data?.item)?.name),
    asTrimmedString(asRecord(data?.item)?.tool),
  ];
  for (const wire of wireTitleCandidates) {
    if (!wire) continue;
    const gatewaySummary = toolportGatewayMetaSummary(wire, tense, routedNested);
    if (gatewaySummary) {
      return { summary: gatewaySummary };
    }
  }

  if (title && !isGenericToolTitle(title)) {
    // Providers often set the raw wire id as title (toolport__toolport_call_tool).
    // Humanize those into a call phrase; human-authored titles ("Update plan")
    // are already verb-shaped and pass through untouched.
    const humanized = humanizeToolDisplayName(title);
    const summary = looksLikeWireToolName(title)
      ? `${verb("call", tense)} ${humanized}`
      : humanized;
    if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
      return { summary, detail };
    }
    return { summary };
  }

  const itemTypeDefault = defaultSummaryForItemType(input.itemType ?? undefined, tense);
  if (itemTypeDefault) {
    const subtitle =
      primaryPath ?? command ?? (detail && !isGenericToolTitle(detail) ? detail : undefined);
    return {
      summary: itemTypeDefault,
      ...(subtitle ? { detail: subtitle } : {}),
    };
  }

  const genericFallback = `${verb("run", tense)} a tool`;

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: isGenericToolTitle(fallbackSummary) ? genericFallback : fallbackSummary,
      detail,
    };
  }

  if (!isGenericToolTitle(fallbackSummary)) {
    return { summary: fallbackSummary };
  }

  return {
    summary: genericFallback,
  };
}
