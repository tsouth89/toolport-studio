/**
 * Tool activity rows used to persist full ACP `rawOutput` / `content` blobs
 * (often 20–400KB per update). That ballooned `state.sqlite` (orchestration
 * events + activities) and made multi-session streaming feel token-throttled
 * under SQLite/WS write pressure. Keep presentation fields; truncate heavies.
 *
 * Extracted from ProviderRuntimeIngestion so the historical backfill migration
 * applies the exact same rules as the ingestion path. If these limits ever
 * change, both the forward path and any future backfill move together.
 */

export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

const TOOL_ACTIVITY_HEAVY_DATA_KEYS = new Set([
  "rawOutput",
  "rawInput",
  "content",
  "output",
  "result",
  "stdout",
  "stderr",
  "diff",
  "patch",
  "fileContent",
  "body",
]);
/** Soft cap for free-form strings kept on the activity row. */
const TOOL_ACTIVITY_MAX_STRING_CHARS = 400;
/** Soft cap for JSON-encoded heavy objects kept for dogfood previews. */
const TOOL_ACTIVITY_MAX_JSON_CHARS = 800;

export function sanitizeToolActivityDataValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    const limit = TOOL_ACTIVITY_HEAVY_DATA_KEYS.has(key)
      ? TOOL_ACTIVITY_MAX_STRING_CHARS
      : TOOL_ACTIVITY_MAX_STRING_CHARS * 2;
    return truncateDetail(value, limit);
  }
  if (!TOOL_ACTIVITY_HEAVY_DATA_KEYS.has(key)) {
    return value;
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      return { _truncated: true };
    }
    if (encoded.length <= TOOL_ACTIVITY_MAX_JSON_CHARS) {
      return value;
    }
    return {
      _truncated: true,
      approxChars: encoded.length,
      preview: `${encoded.slice(0, TOOL_ACTIVITY_MAX_STRING_CHARS - 3)}...`,
    };
  } catch {
    return { _truncated: true };
  }
}

/**
 * Apply the ingestion-time rules to a stored `payload_json` value.
 *
 * Returns `null` when the row must be left exactly as it is: unparseable JSON,
 * a non-object payload, a payload with no `data` bag, or a result that did not
 * actually get smaller. Callers use that to skip the write, so a backfill can
 * only ever shrink rows and never rewrites one it does not understand.
 */
export function sanitizeStoredActivityPayload(payloadJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const payload = parsed as Record<string, unknown>;
  const data = payload.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    sanitized[key] = sanitizeToolActivityDataValue(key, value);
  }

  const next = JSON.stringify({ ...payload, data: sanitized });
  if (next === undefined || next.length >= payloadJson.length) {
    return null;
  }
  return next;
}
