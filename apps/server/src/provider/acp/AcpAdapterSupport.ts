import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import { extractProviderErrorMessage } from "@t3tools/shared/providerError";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/** ACP JSON-RPC code for resource / session not found. */
const ACP_RESOURCE_NOT_FOUND_CODE = -32002;

/**
 * Whether a failed `session/load` should fall back to `session/new`.
 *
 * Grok (and similar ACP agents) persist sessions on disk; after a Studio rebuild
 * or agent data wipe the durable resume cursor still points at a missing path
 * and load returns "Path not found". Only confirmed missing-session failures
 * recover silently — auth, transport, and other request errors must propagate
 * so we do not reset a live thread's provider context on a transient blip.
 *
 * Matches structured signals first (`-32002`), then bounded message patterns
 * used by real agents (Grok: "Path not found"). Exported for unit testing.
 */
export function isAcpSessionLoadNotFound(error: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [error];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || node === undefined || seen.has(node)) {
      continue;
    }
    if (typeof node === "string") {
      if (messageLooksLikeSessionNotFound(node)) {
        return true;
      }
      continue;
    }
    if (typeof node !== "object") {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    if (record.code === ACP_RESOURCE_NOT_FOUND_CODE || record.code === 404) {
      return true;
    }

    // Grok often surfaces missing sessions as a bare Error defect that Schema
    // rehydrates (decodeJsonError stack). Check message, toString, and stack.
    for (const key of ["errorMessage", "message", "detail", "stack"] as const) {
      const value = record[key];
      if (typeof value === "string" && messageLooksLikeSessionNotFound(value)) {
        return true;
      }
    }
    try {
      const asString = String(node);
      if (asString !== "[object Object]" && messageLooksLikeSessionNotFound(asString)) {
        return true;
      }
    } catch {
      // ignore
    }

    for (const key of ["cause", "data", "error", "body", "issue", "defect"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

function messageLooksLikeSessionNotFound(message: string): boolean {
  const normalized = message.toLowerCase();
  // Prefer specific phrases over bare "not found" so method-not-found and
  // unrelated upstream errors do not force a silent session reset.
  return (
    normalized.includes("path not found") ||
    normalized.includes("session not found") ||
    normalized.includes("resource not found") ||
    normalized.includes("no such file") ||
    normalized.includes("enoent") ||
    /\bmissing session\b/.test(normalized)
  );
}

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: extractProviderErrorMessage(error.message),
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: extractProviderErrorMessage(error.message),
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
