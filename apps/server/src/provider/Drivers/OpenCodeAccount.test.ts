import { describe, expect, it } from "@effect/vitest";

import { openCodeAccountLabel, parseOpenCodeAuthFile } from "./OpenCodeAccount.ts";

describe("openCodeAccountLabel", () => {
  it("names the subscriptions we know", () => {
    expect(openCodeAccountLabel("opencode-go")).toBe("OpenCode Go");
    expect(openCodeAccountLabel("opencode-zen")).toBe("OpenCode Zen");
  });

  it("shows an unknown account id verbatim", () => {
    // OpenCode also stores direct vendor keys under their own id. Showing the
    // raw id is honest; mapping it to a plan name we invented would not be.
    expect(openCodeAccountLabel("anthropic")).toBe("anthropic");
  });
});

describe("parseOpenCodeAuthFile", () => {
  it("reads the signed-in account ids", () => {
    const contents = JSON.stringify({ "opencode-go": { type: "api", key: "secret" } });
    expect(parseOpenCodeAuthFile(contents)).toEqual(["opencode-go"]);
  });

  it("keeps file order so the first entry can be treated as primary", () => {
    const contents = JSON.stringify({
      "opencode-go": { type: "api", key: "a" },
      anthropic: { type: "api", key: "b" },
    });
    expect(parseOpenCodeAuthFile(contents)).toEqual(["opencode-go", "anthropic"]);
  });

  it("degrades instead of throwing on files we do not own", () => {
    expect(parseOpenCodeAuthFile("not json")).toEqual([]);
    expect(parseOpenCodeAuthFile("[]")).toEqual([]);
    expect(parseOpenCodeAuthFile("{}")).toEqual([]);
  });
});
