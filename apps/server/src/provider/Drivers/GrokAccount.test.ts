import { describe, expect, it } from "@effect/vitest";

import { grokPlanLabelForTier, parseGrokAuthFile } from "./GrokAccount.ts";

/** Build a JWT-shaped token whose payload carries the given claims. */
const tokenWithClaims = (claims: Record<string, unknown>): string => {
  const payload = Buffer.from(JSON.stringify(claims), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
};

const authFile = (entry: Record<string, unknown>): string =>
  JSON.stringify({ "https://auth.x.ai::client-id": entry });

describe("grokPlanLabelForTier", () => {
  it("names the tier we have confirmed", () => {
    expect(grokPlanLabelForTier(5)).toBe("SuperGrok Heavy");
  });

  it("stays silent about tiers we have not confirmed", () => {
    // Inventing a plan name from an unmapped integer would put a confident
    // wrong label on the provider card.
    for (const tier of [1, 2, 3, 4, 6, "5", null, undefined]) {
      expect(grokPlanLabelForTier(tier)).toBeUndefined();
    }
  });
});

describe("parseGrokAuthFile", () => {
  it("reads the signed-in email and plan", () => {
    const contents = authFile({
      email: "user@example.com",
      first_name: "Test",
      key: tokenWithClaims({ tier: 5, scope: "openid profile" }),
    });

    expect(parseGrokAuthFile(contents)).toEqual({
      email: "user@example.com",
      planLabel: "SuperGrok Heavy",
    });
  });

  it("reports the email even when the token says nothing useful", () => {
    const contents = authFile({ email: "user@example.com", key: "not-a-jwt" });
    expect(parseGrokAuthFile(contents)).toEqual({
      email: "user@example.com",
      planLabel: undefined,
    });
  });

  it("prefers an entry that actually identifies someone", () => {
    // Several issuer/client pairs can be cached. An entry with no email tells
    // the user nothing, so it should not win just by being first.
    const contents = JSON.stringify({
      "https://auth.x.ai::stale": { key: tokenWithClaims({ tier: 5 }) },
      "https://auth.x.ai::current": { email: "user@example.com", key: "x" },
    });
    expect(parseGrokAuthFile(contents)?.email).toBe("user@example.com");
  });

  it("degrades instead of throwing on files we do not own", () => {
    // This file belongs to the Grok CLI. A status probe must survive any
    // shape it decides to write.
    expect(parseGrokAuthFile("not json")).toBeUndefined();
    expect(parseGrokAuthFile("[]")).toBeUndefined();
    expect(parseGrokAuthFile("{}")).toBeUndefined();
    expect(parseGrokAuthFile(JSON.stringify({ entry: "string" }))).toBeUndefined();
    expect(parseGrokAuthFile(authFile({ key: "x" }))).toBeUndefined();
  });
});
