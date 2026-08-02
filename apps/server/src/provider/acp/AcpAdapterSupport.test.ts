import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@toolport-studio/contracts";

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

    // Cursor: the session id sits between the two words and the code is the
    // generic -32602, so neither the code check nor an adjacency match fired
    // and a recycle died on the raw "Invalid params" defect.
    expect(
      isAcpSessionLoadNotFound(
        new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: "Invalid params",
          data: { message: 'Session "b50007b7-f065-44a0-b606-75c51359aa78" not found' },
        }),
      ),
    ).toBe(true);

    // The shape the client actually produces, captured from a real cursor
    // session/load rejection. The wrapper says only "Extension request failed"
    // with code -32603; the agent's message lives in a Die reason inside the
    // `cause` ARRAY. Walking that array as a record stopped the search dead,
    // which is why the fallback to session/new never ran.
    expect(
      isAcpSessionLoadNotFound({
        _tag: "AcpRequestError",
        code: -32603,
        errorMessage: "Extension request failed",
        method: "session/load",
        requestId: "1",
        operation: "receive-response",
        cause: [
          {
            _tag: "Die",
            defect: {
              code: -32602,
              message: "Invalid params",
              data: { message: 'Session "b50007b7-f065-44a0-b606-75c51359aa78" not found' },
            },
          },
        ],
      }),
    ).toBe(true);
    // Schema-defect style surface: bare Error message + stack frames.
    const schemaStyle = new Error("Path not found");
    schemaStyle.stack =
      "Error: Path not found\n    at decodeJsonError (file:///x/SchemaTransformation.js:1:1)";
    expect(isAcpSessionLoadNotFound(schemaStyle)).toBe(true);
    expect(
      isAcpSessionLoadNotFound({
        _tag: "ProviderAdapterRequestError",
        detail: "Error: Path not found",
        message: "Error: Path not found",
      }),
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
