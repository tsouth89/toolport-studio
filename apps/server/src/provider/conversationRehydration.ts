/**
 * Rebuild provider-visible conversation context from Studio projected messages
 * when a native provider session cannot be resumed (app update, cold start,
 * Stop → blank session, Path not found).
 *
 * This is a prompt prefix only — not a second client kill, and not a durable
 * provider transcript store.
 */

export type ConversationHistoryTurn = {
  readonly role: "user" | "assistant";
  readonly text: string;
};

/** Soft cap so a long thread cannot blow the next prompt (matches Grok). */
export const DEFAULT_CONVERSATION_REHYDRATION_MAX_CHARS = 60_000;

const DEFAULT_REHYDRATION_REASON =
  "This Toolport Studio thread has prior conversation history that is not loaded in the current provider session (common after app restart, update, or Stop).";

/**
 * Map projected thread messages into a role/text log for rehydration.
 * Skips system rows, empty text, and optionally the message about to be sent.
 */
export function orchestrationMessagesToConversationHistory(
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
  }>,
  options?: {
    readonly excludeMessageId?: string;
  },
): Array<ConversationHistoryTurn> {
  const excludeId = options?.excludeMessageId;
  const out: Array<ConversationHistoryTurn> = [];
  for (const message of messages) {
    if (excludeId !== undefined && message.id === excludeId) {
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }
    out.push({ role: message.role, text });
  }
  return out;
}

/**
 * Build a prompt prefix that restores Studio-known history when the provider
 * session could not be resumed. Newest turns are preferred within maxChars.
 * Optional tool summaries capture work that never landed as assistant text.
 */
export function buildConversationRehydrationPrefix(
  log: ReadonlyArray<ConversationHistoryTurn>,
  options?: {
    readonly maxChars?: number;
    readonly reason?: string;
    readonly toolSummaries?: ReadonlyArray<string>;
  },
): string | undefined {
  const maxChars = options?.maxChars ?? DEFAULT_CONVERSATION_REHYDRATION_MAX_CHARS;
  const toolLines = (options?.toolSummaries ?? [])
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0)
    .slice(-20)
    .map((summary) => `- ${summary}`);
  if ((log.length === 0 && toolLines.length === 0) || maxChars <= 0) {
    return undefined;
  }
  const lines: string[] = [];
  let used = 0;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const turn = log[index];
    if (!turn) continue;
    const label = turn.role === "user" ? "User" : "Assistant";
    const block = `${label}:\n${turn.text}`;
    const cost = block.length + (lines.length > 0 ? 2 : 0);
    if (used + cost > maxChars && lines.length > 0) {
      break;
    }
    if (used + cost > maxChars) {
      const remaining = Math.max(0, maxChars - used - `${label}:\n`.length - 20);
      lines.unshift(`${label}:\n${turn.text.slice(-remaining)}\n…`);
      break;
    }
    lines.unshift(block);
    used += cost;
  }
  if (lines.length === 0 && toolLines.length === 0) {
    return undefined;
  }
  const reason = options?.reason?.trim() || DEFAULT_REHYDRATION_REASON;
  const toolsBlock =
    toolLines.length > 0
      ? ["", "Recent tool work from Studio (may not appear as assistant text):", ...toolLines]
      : [];
  return [
    reason,
    "Here is the conversation so far from Toolport Studio. Treat it as your memory of this thread and continue without asking the user to restate it.",
    "",
    ...(lines.length > 0 ? [lines.join("\n\n"), ...toolsBlock] : toolsBlock),
    "",
    "---",
    "Latest user message:",
    "",
  ].join("\n");
}

/** Keep recent tool activity summaries for rehydration (newest last). */
export function selectToolSummariesForRehydration(
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly summary: string;
    readonly tone?: string;
  }>,
  limit = 20,
): Array<string> {
  const selected: string[] = [];
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity) continue;
    const kind = activity.kind.toLowerCase();
    const isTool =
      activity.tone === "tool" ||
      kind.startsWith("tool.") ||
      kind.includes("command") ||
      kind.includes("mcp");
    if (!isTool) continue;
    const summary = activity.summary.trim();
    if (summary.length === 0) continue;
    selected.push(summary);
    if (selected.length >= limit) break;
  }
  return selected.reverse();
}

/** Merge consecutive same-role turns (streamed assistant deltas / multi-part user). */
export function appendConversationHistoryText(
  log: ReadonlyArray<ConversationHistoryTurn>,
  role: ConversationHistoryTurn["role"],
  text: string,
): Array<ConversationHistoryTurn> {
  const nextText = role === "assistant" ? text : text.trim();
  if (nextText.length === 0) {
    return [...log];
  }
  const last = log[log.length - 1];
  if (last && last.role === role) {
    const separator = role === "assistant" ? "" : "\n";
    return [...log.slice(0, -1), { role, text: `${last.text}${separator}${nextText}` }];
  }
  return [...log, { role, text: nextText }];
}
