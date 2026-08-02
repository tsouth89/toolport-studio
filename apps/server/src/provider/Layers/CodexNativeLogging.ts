import type { ProviderDriverKind, ThreadId } from "@toolport-studio/contracts";
import { causeErrorTag } from "@toolport-studio/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as CodexProtocol from "effect-codex-app-server/protocol";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { CodexSessionRuntimeOptions } from "./CodexSessionRuntime.ts";

/**
 * Frame shape only, never contents: these logs are read while debugging a
 * user's session and must not carry prompt text, file contents, or secrets.
 */
function summarizePayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (payload === null) return { valueType: "null" };
  if (typeof payload === "string") {
    return { valueType: "string", byteLength: new TextEncoder().encode(payload).byteLength };
  }
  if (payload instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: payload.byteLength };
  }
  if (Array.isArray(payload)) {
    return { valueType: "array", itemCount: payload.length };
  }
  if (typeof payload !== "object") {
    return { valueType: typeof payload };
  }
  try {
    const record = payload as Record<string, unknown>;
    return {
      valueType: "object",
      fieldCount: Object.keys(record).length,
      // The method name is what makes a dropped notification identifiable.
      ...(typeof record.method === "string" ? { method: structuralMethod(record.method) } : {}),
    };
  } catch {
    return { valueType: "object" };
  }
}

function structuralMethod(value: string): string {
  return value.length <= 128 && /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value) ? value : "unknown";
}

export function formatCodexProtocolLogPayload(event: CodexProtocol.CodexAppServerProtocolLogEvent) {
  return {
    direction: event.direction,
    stage: event.stage,
    payload: summarizePayload(event.payload),
  };
}

/**
 * Wire raw codex JSON-RPC frames into the per-thread native event log, the
 * same way {@link makeAcpNativeLoggerFactory} does for the ACP runtimes.
 *
 * A codex session that accepts `turn/start` and then goes quiet is otherwise
 * undiagnosable: the per-thread log only records events that were already
 * dispatched, so "the frame never arrived" and "the frame arrived and was
 * dropped" look identical. `stage: "decode_failed"` distinguishes them.
 */
export const makeCodexNativeProtocolLoggerFactory = Effect.fn(
  "makeCodexNativeProtocolLoggerFactory",
)(function* () {
  const crypto = yield* Crypto.Crypto;
  return (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
  }): Pick<CodexSessionRuntimeOptions, "protocolLogging"> => {
    if (!input.nativeEventLogger) {
      return {};
    }
    const nativeEventLogger = input.nativeEventLogger;
    return {
      protocolLogging: {
        logIncoming: true,
        logOutgoing: true,
        logger: (event) =>
          Effect.gen(function* () {
            const observedAt = DateTime.formatIso(yield* DateTime.now);
            yield* nativeEventLogger.write(
              {
                observedAt,
                event: {
                  id: yield* crypto.randomUUIDv4,
                  kind: "protocol",
                  provider: input.provider,
                  createdAt: observedAt,
                  threadId: input.threadId,
                  payload: formatCodexProtocolLogPayload(event),
                },
              },
              input.threadId,
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Failed to write native Codex protocol log.", {
                    errorTag: causeErrorTag(cause),
                    provider: input.provider,
                    threadId: input.threadId,
                  }),
            ),
          ),
      },
    };
  };
});
