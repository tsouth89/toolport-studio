function readMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message.trim();
  }
  // upstream errors often nest the useful part, e.g. {"type":"error","status":400,"error":{"message":...}}
  return readMessage(record.error);
}

/**
 * Providers sometimes surface the raw upstream error body as the error
 * message string (e.g. `{"type":"error","status":400,"error":{"type":
 * "invalid_request_error","message":"..."}}`). Pull out the human readable
 * message when that happens; otherwise return the input unchanged.
 */
export function extractProviderErrorMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return message;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return message;
  }
  const extracted = readMessage(parsed);
  if (extracted === undefined || extracted === trimmed) {
    return message;
  }
  // handles double-encoded payloads; the inequality check above guarantees progress
  return extractProviderErrorMessage(extracted);
}

/**
 * Failures some providers emit as ordinary assistant text (or short RPC messages)
 * instead of a failed prompt / turn RPC. Adapters use this to settle the turn as
 * failed rather than "completed" with an error string as the reply.
 */
export type ProviderEmittedFailureKind =
  | "resource_exhausted"
  | "rate_limited"
  | "auth_failed"
  | "provider_unavailable";

export type ProviderEmittedFailure = {
  readonly kind: ProviderEmittedFailureKind;
  /** Whether the provider labeled the failure as retriable. */
  readonly retriable: boolean;
  /** Stable short code for logs and metrics. */
  readonly code: string;
  /**
   * Human-facing explanation suitable for `runtime.error` /
   * `turn.completed.errorMessage`. Provider-agnostic; adapters may append
   * model-specific guidance.
   */
  readonly message: string;
  readonly class: "provider_error";
};

/** Max length of a pure-failure assistant payload. Longer text is treated as prose. */
const PROVIDER_EMITTED_FAILURE_MAX_CHARS = 400;

function normalizeFailureProbeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when the text is essentially a failure payload, not a normal answer that
 * merely mentions an error code (e.g. in code review).
 */
function isPureFailureShaped(text: string): boolean {
  const normalized = normalizeFailureProbeText(text);
  if (normalized.length === 0 || normalized.length > PROVIDER_EMITTED_FAILURE_MAX_CHARS) {
    return false;
  }
  // Multi-paragraph / explanatory replies are not pure failures.
  if ((text.match(/\n/g) ?? []).length > 4) {
    return false;
  }
  // Heuristic: pure failures are short, often Error:/code framed, not full sentences.
  const sentenceLike =
    /[.!?]["']?\s+[A-Z]/.test(normalized) &&
    !/^(?:Error|RetriableError|Exception)\b/i.test(normalized);
  if (sentenceLike && normalized.length > 120) {
    return false;
  }
  return true;
}

/**
 * Classify provider-emitted failure text that arrived as assistant content or a
 * short error string. Returns `undefined` for normal assistant prose.
 *
 * Known shapes:
 * - Cursor ACP: `Error: RetriableError: [resource_exhausted] Error` with end_turn
 * - Short rate-limit / quota dumps from upstreams
 */
export function classifyProviderEmittedFailure(text: string): ProviderEmittedFailure | undefined {
  const extracted = extractProviderErrorMessage(text);
  if (!isPureFailureShaped(extracted)) {
    return undefined;
  }
  const normalized = normalizeFailureProbeText(extracted);
  const lower = normalized.toLowerCase();

  // Require error-framed / code-only shapes so prose that *mentions* a code
  // (code review, docs) is not treated as a turn failure.
  const errorFramed =
    /^(?:Error|RetriableError|Exception)\b/i.test(normalized) ||
    /\bRetriableError\b/i.test(normalized);
  const codeOnly = (code: string) =>
    new RegExp(
      `^(?:Error:\\s*)?(?:RetriableError:\\s*)?\\[?\\s*${code}\\s*\\]?(?:\\s*Error)?\\.?$`,
      "i",
    ).test(normalized);

  if (
    codeOnly("resource_exhausted") ||
    (errorFramed &&
      normalized.length <= 160 &&
      (/\[?\s*resource_exhausted\s*\]?/.test(lower) ||
        /\bresource\s+exhausted\b/.test(lower) ||
        /\bcapacity\s+exhausted\b/.test(lower)))
  ) {
    return {
      kind: "resource_exhausted",
      retriable: true,
      code: "resource_exhausted",
      class: "provider_error",
      // Do not assume the user's plan/billing is depleted. Providers often emit
      // this for temporary model capacity, routing, or upstream limits.
      message:
        "Provider returned resource_exhausted for this request (provider-side capacity or routing, not a Studio limit). Retry, switch models, or use the native provider for that model.",
    };
  }

  if (
    codeOnly("rate_limited") ||
    (errorFramed &&
      normalized.length <= 160 &&
      (/\brate[_\s-]?limit/.test(lower) ||
        /\bquota\s+exceeded\b/.test(lower) ||
        /\btoo many requests\b/.test(lower) ||
        /\b429\b/.test(normalized))) ||
    // Bare short dumps without Error: prefix (common in JSON-extracted messages).
    (normalized.length <= 80 &&
      (/^quota exceeded\.?$/i.test(normalized) ||
        /^rate limit(?:ed| exceeded)?\.?$/i.test(normalized) ||
        /^too many requests\.?$/i.test(normalized)))
  ) {
    return {
      kind: "rate_limited",
      retriable: true,
      code: "rate_limited",
      class: "provider_error",
      message:
        "Provider rate limit or quota exceeded. Wait for the limit to reset, or switch models/providers.",
    };
  }

  if (
    (errorFramed || normalized.length <= 80) &&
    (/\bunauthoriz(?:ed|ation)\b/.test(lower) ||
      /\bauthentication\s+failed\b/.test(lower) ||
      /\bnot\s+authenticated\b/.test(lower) ||
      /\binvalid\s+api\s+key\b/.test(lower) ||
      (errorFramed && /\b401\b/.test(normalized)))
  ) {
    return {
      kind: "auth_failed",
      retriable: false,
      code: "auth_failed",
      class: "provider_error",
      message: "Provider authentication failed. Re-authenticate this provider and try again.",
    };
  }

  if (
    (errorFramed || normalized.length <= 80) &&
    (/\bservice\s+unavailable\b/.test(lower) ||
      /\bprovider\s+unavailable\b/.test(lower) ||
      /\boverloaded\b/.test(lower) ||
      (errorFramed && /\b503\b/.test(normalized)))
  ) {
    return {
      kind: "provider_unavailable",
      retriable: true,
      code: "provider_unavailable",
      class: "provider_error",
      message: "Provider is temporarily unavailable or overloaded. Retry in a moment.",
    };
  }

  // Generic RetriableError wrapper without a more specific code.
  if (
    /^Error:\s*RetriableError:\s*.+/i.test(normalized) ||
    /^RetriableError:\s*.+/i.test(normalized)
  ) {
    return {
      kind: "provider_unavailable",
      retriable: true,
      code: "retriable_error",
      class: "provider_error",
      message: extractProviderErrorMessage(normalized),
    };
  }

  return undefined;
}

/**
 * Append model/provider guidance for known failure kinds. Keeps classifier
 * messages stable while letting adapters be specific.
 */
export function formatProviderEmittedFailureMessage(
  failure: ProviderEmittedFailure,
  context?: {
    readonly providerLabel?: string | undefined;
    readonly model?: string | undefined;
  },
): string {
  const bits = [failure.message];
  if (context?.providerLabel && context?.model) {
    if (failure.kind === "resource_exhausted") {
      bits.push(
        `${context.providerLabel} rejected model "${context.model}" with that code (often temporary capacity on their path to the model, not necessarily your plan quota).`,
      );
    } else if (failure.kind === "rate_limited") {
      bits.push(
        `${context.providerLabel} rate-limited model "${context.model}". This may be a short window limit rather than overall plan usage.`,
      );
    }
  } else if (context?.model && failure.kind === "resource_exhausted") {
    bits.push(
      `Model "${context.model}" was rejected with resource_exhausted by the provider path.`,
    );
  } else if (context?.model && failure.kind === "rate_limited") {
    bits.push(`Model "${context.model}" was rate-limited by the provider path.`);
  }
  if (failure.retriable) {
    bits.push("Often temporary; retry or use another model/provider.");
  }
  return bits.join(" ");
}
