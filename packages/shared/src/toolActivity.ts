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

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
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

function isGenericToolTitle(value: string | undefined): boolean {
  if (!value) {
    return true;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+(?:complete|completed|started|updated)\s*$/u, "")
    .trim();
  return (
    normalized.length === 0 ||
    normalized === "tool" ||
    normalized === "tool call" ||
    normalized === "toolcall" ||
    normalized === "terminal"
  );
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
): string | undefined {
  switch (itemType) {
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "Changed files";
    case "web_search":
      return "Searched";
    case "image_view":
      return "Viewed image";
    case "mcp_tool_call":
      return "MCP tool";
    case "dynamic_tool_call":
      return "Tool call";
    case "collab_agent_tool_call":
      return "Agent tool";
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
  if (itemType === "command_execution" || kind === "execute" || looksLikeShellToolTitle(title)) {
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
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const structuredName = extractStructuredToolName(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    // Grok Build style: "Run git status" rather than "Ran command" + muted dump.
    const headline = command ? truncateToolHeadline(command, 88) : undefined;
    return {
      summary: headline ? `Run ${headline}` : "Ran command",
      ...(command && headline !== command
        ? { detail: command }
        : command
          ? { detail: command }
          : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: `Read ${fileBasename(primaryPath)}`,
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    if (primaryPath) {
      return {
        summary: `Edited ${fileBasename(primaryPath)}`,
        detail: primaryPath,
      };
    }
    return {
      summary: "Changed files",
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm) ??
      asTrimmedString(asRecord(data?.rawInput)?.path);
    const shortQuery = query ? truncateToolHeadline(query, 64) : undefined;
    return {
      summary: shortQuery ? `Searched ${shortQuery}` : "Searched",
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
      summary: structuredName,
      ...(subtitle ? { detail: subtitle } : {}),
    };
  }

  if (title && !isGenericToolTitle(title)) {
    // Providers often set the raw wire id as title (toolport__toolport_call_tool).
    // Humanize those so Activity / timeline never show double-underscore names.
    const summary = humanizeToolDisplayName(title);
    if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
      return { summary, detail };
    }
    return { summary };
  }

  const itemTypeDefault = defaultSummaryForItemType(input.itemType ?? undefined);
  if (itemTypeDefault) {
    const subtitle =
      primaryPath ?? command ?? (detail && !isGenericToolTitle(detail) ? detail : undefined);
    return {
      summary: itemTypeDefault,
      ...(subtitle ? { detail: subtitle } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: isGenericToolTitle(fallbackSummary) ? "Tool call" : fallbackSummary,
      detail,
    };
  }

  if (!isGenericToolTitle(fallbackSummary)) {
    return { summary: fallbackSummary };
  }

  return {
    summary: "Tool call",
  };
}
