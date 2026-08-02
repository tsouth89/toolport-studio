/**
 * Does the provider actually accept this key?
 *
 * Checking that an environment variable is non-empty only proves a key is
 * *present*. A revoked, mistyped, or wrong-provider key still looks healthy
 * that way, and the user finds out on their first turn. Every API-key
 * provider we target exposes the OpenAI-compatible `GET /models`, which
 * authenticates without spending tokens, so that is the cheapest honest
 * answer available.
 *
 * The three-way result matters. Network failures, timeouts, and proxies must
 * report `unknown` rather than `invalid`: claiming a key is bad because we
 * could not reach the internet would be its own lie, and would make an
 * offline instance look permanently broken.
 *
 * @module provider/Drivers/Byok/byokApiKeyProbe
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ByokPreset } from "./byokPresets.ts";

const PROBE_TIMEOUT_MS = 8_000;

export type ByokApiKeyStatus = "valid" | "invalid" | "unknown";

/** Join a preset base URL with a path without doubling or dropping slashes. */
export function joinProviderUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Map an HTTP status to a verdict.
 *
 * Only the codes that unambiguously mean "the provider rejected this
 * credential" count as invalid. A 429 means the key worked well enough to be
 * rate limited, and 5xx is the provider's problem, not the key's.
 */
export function classifyApiKeyResponseStatus(status: number): ByokApiKeyStatus {
  if (status === 401 || status === 403) return "invalid";
  if (status >= 200 && status < 300) return "valid";
  return "unknown";
}

export const probeByokApiKey = Effect.fn("probeByokApiKey")(function* (input: {
  readonly preset: ByokPreset;
  readonly apiKey: string;
}): Effect.fn.Return<ByokApiKeyStatus, never, HttpClient.HttpClient> {
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) return "invalid";

  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(joinProviderUrl(input.preset.baseUrl, "models")).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
  );

  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );

  // Unreachable provider: say so, rather than blaming the key.
  if (Option.isNone(response)) return "unknown";
  return classifyApiKeyResponseStatus(response.value.status);
});
