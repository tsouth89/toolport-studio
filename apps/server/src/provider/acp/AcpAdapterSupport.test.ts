import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  acpPermissionOutcome,
  isAcpSessionLoadNotFound,
  mapAcpToAdapterError,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("classifies confirmed session/load not-found failures", () => {
    expect(
      isAcpSessionLoadNotFound(EffectAcpErrors.AcpRequestError.resourceNotFound("Path not found")),
    ).toBe(true);
    expect(
      isAcpSessionLoadNotFound(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Error: Path not found",
        }),
      ),
    ).toBe(true);
    expect(
      isAcpSessionLoadNotFound(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "session not found",
        }),
      ),
    ).toBe(true);
    expect(
      isAcpSessionLoadNotFound(
        new Error("upstream: Path not found", {
          cause: EffectAcpErrors.AcpRequestError.internalError("wrapped"),
        }),
      ),
    ).toBe(true);

    // Must not treat unrelated failures as a missing session.
    expect(
      isAcpSessionLoadNotFound(
        EffectAcpErrors.AcpRequestError.internalError("Mock load session failure"),
      ),
    ).toBe(false);
    expect(
      isAcpSessionLoadNotFound(EffectAcpErrors.AcpRequestError.methodNotFound("session/load")),
    ).toBe(false);
    expect(
      isAcpSessionLoadNotFound(
        EffectAcpErrors.AcpRequestError.authRequired("Authentication required"),
      ),
    ).toBe(false);
    expect(
      isAcpSessionLoadNotFound(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "upstream provider not found",
        }),
      ),
    ).toBe(false);
  });
});
