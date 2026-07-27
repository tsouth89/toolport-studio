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

function humanizeStructuredToolName(value: string): string {
  let name = value.trim();
  // Common MCP / Toolport prefixes: server__tool or toolport__toolport_run_script
  name = name.replace(/^(?:mcp__|toolport__)+/iu, "");
  name = name.replace(/__/gu, " · ");
  name = name.replace(/[_-]+/gu, " ");
  name = name.replace(/\s+/gu, " ").trim();
  if (name.length === 0) {
    return value.trim();
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
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
    return trimmed;
  }
  return humanizeStructuredToolName(trimmed);
}

function extractStructuredToolName(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }
  const rawInput = asRecord(data.rawInput);
  const item = asRecord(data.item);
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
    if (candidate && !isGenericToolTitle(candidate)) {
      return humanizeStructuredToolName(candidate);
    }
  }
  const server = asTrimmedString(item?.server) ?? asTrimmedString(data.server);
  const tool = asTrimmedString(item?.tool) ?? asTrimmedString(data.tool);
  if (server && tool) {
    return `${server} · ${humanizeStructuredToolName(tool)}`;
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
