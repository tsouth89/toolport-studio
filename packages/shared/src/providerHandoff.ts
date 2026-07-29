/**
 * Handoff envelope for moving a conversation to a different provider (SOU-480).
 *
 * The obvious approach is to replay the transcript into the new provider. That
 * is wrong here: it grows without bound as a thread ages, no provider accepts
 * another's session format, and most of a long thread is tool traffic that has
 * already been superseded.
 *
 * A new provider does not need to have been present for the conversation. It
 * needs to know where things stand, the way someone picking up an unfamiliar
 * branch does: read the diff, read the plan, read the last thing that was
 * asked. They do not read the previous person's terminal scrollback.
 *
 * So this hands over *state*, not history, and it does so from sources that are
 * true at switch time rather than reconstructed from the past. The diff comes
 * from git, which is authoritative; we only supply pointers to where the work
 * has been happening.
 *
 * Every section is optional and the whole thing is capped, so a 500-turn thread
 * and a 5-turn thread produce envelopes of roughly the same size.
 */

export interface ProviderHandoffInput {
  /** Provider the conversation is moving away from, for the opening line. */
  readonly previousProviderLabel: string;
  /** Opening ask of the thread. Establishes what is being attempted. */
  readonly firstUserMessage?: string | null;
  /** Most recent ask. Usually the thing still outstanding. */
  readonly lastUserMessage?: string | null;
  readonly branch?: string | null;
  readonly cwd?: string | null;
  /** Output of `git diff --stat` (or equivalent) read at switch time. */
  readonly diffStat?: string | null;
  /** Files touched during the thread, from per-turn checkpoints. */
  readonly filesInPlay?: readonly string[] | null;
  /**
   * Tail of the conversation, oldest first, text only.
   *
   * Without this the incoming provider knows what was *asked* but not what was
   * *answered*. For coding work the diff covers that gap, since the answer is
   * visible in the tree. For an informational turn there is no diff and the
   * reply itself was the entire result, so omitting it makes the handoff
   * useless exactly where state-based context has nothing to say.
   */
  readonly recentExchange?:
    | readonly { readonly role: "user" | "assistant"; readonly text: string }[]
    | null;
}

export interface ProviderHandoffLimits {
  readonly maxMessageChars: number;
  readonly maxDiffStatChars: number;
  readonly maxFilesInPlay: number;
  readonly maxTotalChars: number;
  readonly maxExchangeTurns: number;
  readonly maxExchangeCharsPerTurn: number;
}

export const DEFAULT_PROVIDER_HANDOFF_LIMITS: ProviderHandoffLimits = {
  maxMessageChars: 1_500,
  maxDiffStatChars: 2_000,
  maxFilesInPlay: 40,
  maxTotalChars: 8_000,
  maxExchangeTurns: 6,
  maxExchangeCharsPerTurn: 1_200,
};

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  // Mark the cut so the reader knows content was withheld rather than that the
  // message simply ended mid-sentence.
  return `${trimmed.slice(0, Math.max(0, limit - 3))}...`;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Dedupe while preserving first-seen order, then cap.
 *
 * Checkpoints record files per turn, so a file edited across ten turns appears
 * ten times. Order is kept because earlier entries tend to be the files the
 * work started from.
 */
export function summariseFilesInPlay(
  files: readonly string[] | null | undefined,
  maxFiles: number,
): { readonly files: readonly string[]; readonly omitted: number } {
  if (!files || files.length === 0 || maxFiles <= 0) {
    return { files: [], omitted: 0 };
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const file of files) {
    const trimmed = file.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }

  return {
    files: ordered.slice(0, maxFiles),
    omitted: Math.max(0, ordered.length - maxFiles),
  };
}

/**
 * Build the envelope. Deterministic: same input always yields the same text, so
 * it can be shown to the user before they confirm the switch and it reads the
 * same way in the timeline afterwards.
 */
export function buildProviderHandoff(
  input: ProviderHandoffInput,
  limits: ProviderHandoffLimits = DEFAULT_PROVIDER_HANDOFF_LIMITS,
): string {
  const sections: string[] = [];

  // Wording matters more than it looks. The first version said "you do not have
  // its history", and the incoming provider quoted that back as its reason for
  // redoing work it had just been handed. Say what is present, not what is
  // missing, and tell it to use what it has.
  sections.push(
    `You are continuing a conversation that ${input.previousProviderLabel} was handling. ` +
      `Below is the state of the work and how the conversation ended. ` +
      `Treat it as your own context and carry on from it rather than starting over.`,
  );

  const first = nonEmpty(input.firstUserMessage);
  const last = nonEmpty(input.lastUserMessage);
  if (first !== null) {
    sections.push(`## Original request\n\n${truncate(first, limits.maxMessageChars)}`);
  }
  // Only worth repeating when it is genuinely a different ask.
  if (last !== null && last !== first) {
    sections.push(`## Most recent request\n\n${truncate(last, limits.maxMessageChars)}`);
  }

  const workingState: string[] = [];
  const cwd = nonEmpty(input.cwd);
  const branch = nonEmpty(input.branch);
  if (cwd !== null) workingState.push(`Working directory: ${cwd}`);
  if (branch !== null) workingState.push(`Branch: ${branch}`);
  if (workingState.length > 0) {
    sections.push(`## Workspace\n\n${workingState.join("\n")}`);
  }

  const diffStat = nonEmpty(input.diffStat);
  if (diffStat !== null) {
    sections.push(
      `## Uncommitted changes\n\n\`\`\`\n${truncate(diffStat, limits.maxDiffStatChars)}\n\`\`\``,
    );
  }

  const { files, omitted } = summariseFilesInPlay(input.filesInPlay, limits.maxFilesInPlay);
  if (files.length > 0) {
    const list = files.map((file) => `- ${file}`).join("\n");
    const suffix = omitted > 0 ? `\n- ...and ${omitted} more` : "";
    sections.push(`## Files touched so far\n\n${list}${suffix}`);
  }

  const exchange = (input.recentExchange ?? [])
    .filter((entry) => entry.text.trim().length > 0)
    .slice(-limits.maxExchangeTurns);
  if (exchange.length > 0) {
    const rendered = exchange
      .map(
        (entry) =>
          `**${entry.role === "user" ? "User" : "Previous assistant"}:** ` +
          truncate(entry.text, limits.maxExchangeCharsPerTurn),
      )
      .join("\n\n");
    sections.push(`## How the conversation ended\n\n${rendered}`);
  }

  sections.push(
    `Read the code and the diff directly rather than assuming. ` +
      `If you need detail this summary does not cover, ask.`,
  );

  const envelope = sections.join("\n\n");
  return envelope.length <= limits.maxTotalChars
    ? envelope
    : `${envelope.slice(0, Math.max(0, limits.maxTotalChars - 3))}...`;
}
