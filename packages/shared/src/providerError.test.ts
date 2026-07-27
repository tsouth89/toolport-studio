import { describe, expect, it } from "vite-plus/test";

import {
  classifyProviderEmittedFailure,
  extractProviderErrorMessage,
  formatProviderEmittedFailureMessage,
} from "./providerError.ts";

describe("extractProviderErrorMessage", () => {
  it("returns plain messages unchanged", () => {
    expect(extractProviderErrorMessage("Something went wrong")).toBe("Something went wrong");
  });

  it("extracts the nested message from a codex/upstream error body", () => {
    const raw =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';
    expect(extractProviderErrorMessage(raw)).toBe(
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
    );
  });

  it("extracts a top-level message field", () => {
    expect(extractProviderErrorMessage('{"message":"rate limited","code":429}')).toBe(
      "rate limited",
    );
  });

  it("unwraps double-encoded payloads", () => {
    const inner = '{"error":{"message":"quota exceeded"}}';
    const outer = JSON.stringify({ message: inner });
    expect(extractProviderErrorMessage(outer)).toBe("quota exceeded");
  });

  it("returns invalid JSON unchanged", () => {
    expect(extractProviderErrorMessage('{"type":"error", broken')).toBe('{"type":"error", broken');
  });

  it("returns JSON without a usable message unchanged", () => {
    expect(extractProviderErrorMessage('{"status":500}')).toBe('{"status":500}');
  });

  it("ignores empty or whitespace-only message fields", () => {
    expect(extractProviderErrorMessage('{"message":"  ","error":{"message":"real cause"}}')).toBe(
      "real cause",
    );
  });

  it("does not touch non-object JSON", () => {
    expect(extractProviderErrorMessage('"just a string"')).toBe('"just a string"');
    expect(extractProviderErrorMessage("[1,2,3]")).toBe("[1,2,3]");
  });
});

describe("classifyProviderEmittedFailure", () => {
  it("classifies Cursor resource_exhausted assistant dumps as failed turns", () => {
    const failure = classifyProviderEmittedFailure(
      "\n\nError: RetriableError: [resource_exhausted] Error",
    );
    expect(failure).toMatchObject({
      kind: "resource_exhausted",
      retriable: true,
      code: "resource_exhausted",
      class: "provider_error",
    });
    expect(failure?.message).toMatch(/resource_exhausted/i);
  });

  it("classifies short rate-limit dumps", () => {
    expect(classifyProviderEmittedFailure("Error: rate limit exceeded")).toMatchObject({
      kind: "rate_limited",
      retriable: true,
    });
    expect(classifyProviderEmittedFailure("quota exceeded")).toMatchObject({
      kind: "rate_limited",
    });
  });

  it("classifies auth failures", () => {
    expect(classifyProviderEmittedFailure("Error: unauthorized")).toMatchObject({
      kind: "auth_failed",
      retriable: false,
    });
  });

  it("does not treat normal assistant prose as a provider failure", () => {
    expect(
      classifyProviderEmittedFailure(
        "I hit a resource_exhausted error earlier while testing. Here is the fix for the adapter.",
      ),
    ).toBeUndefined();
    expect(
      classifyProviderEmittedFailure(
        "Looking at the logs, Cursor returned resource_exhausted for grok-4.5. We should use the Grok provider instead because that path uses xAI capacity directly and stays reliable under load.",
      ),
    ).toBeUndefined();
    expect(classifyProviderEmittedFailure("hello from mock")).toBeUndefined();
  });

  it("formats provider/model guidance without claiming plan quota is depleted", () => {
    const failure = classifyProviderEmittedFailure(
      "Error: RetriableError: [resource_exhausted] Error",
    );
    assertDefined(failure);
    const formatted = formatProviderEmittedFailureMessage(failure, {
      providerLabel: "Cursor",
      model: "grok-4.5",
    });
    expect(formatted).toMatch(/resource_exhausted/i);
    expect(formatted).toMatch(/Cursor/);
    expect(formatted).toMatch(/grok-4\.5/);
    expect(formatted).not.toMatch(/plan is exhausted|out of quota|billing/i);
    expect(formatted).toMatch(/not necessarily your plan quota|not a Studio limit/i);
  });
});

function assertDefined<T>(value: T | undefined): asserts value is T {
  expect(value).toBeDefined();
}
