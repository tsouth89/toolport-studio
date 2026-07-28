/** ASCII whitespace, for callers that were trimming a `\s` character class. */
export const WHITESPACE_CHARS = " \t\n\r\f\v";

/**
 * Trim a run of characters from the end of a string.
 *
 * Prefer this over `replace(/[chars]+$/, "")`. That shape is quadratic: the
 * engine restarts the run at every position in the string and only then
 * discovers `$` does not hold, so a long input of the trimmed character class
 * burns O(n²) before returning. Scanning backwards is linear and does the same
 * job.
 */
export function trimTrailingChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) {
    end--;
  }
  return end === value.length ? value : value.slice(0, end);
}

/** Leading counterpart of {@link trimTrailingChars}. */
export function trimLeadingChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start]!)) {
    start++;
  }
  return start === 0 ? value : value.slice(start);
}

/** Trims `chars` from both ends. */
export function trimChars(value: string, chars: string): string {
  return trimLeadingChars(trimTrailingChars(value, chars), chars);
}

export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}...`;
}
