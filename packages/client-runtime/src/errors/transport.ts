const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  /\bis not connected\.$/i,
  /\bdisconnected\.$/i,
  /\bcould not establish a WebSocket connection\.$/i,
  /\bClientProtocolError\b/i,
  /\bRpcClientError\b/i,
  /\bping timeout\b/i,
] as const;

/**
 * Check whether an error message originates from a transport-level connection
 * failure (socket close, socket open, ping timeout, etc.) rather than a
 * business-logic error.
 */
export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

/**
 * Environment session-unavailable copy the user must see after a failed Send.
 * These used to be stripped as "transport noise", which made dead sends look
 * like the UI ignored the message entirely (no banner, no Working).
 */
const ACTIONABLE_ENVIRONMENT_DISCONNECT_PATTERNS = [
  /\bis not connected\.$/i,
  /\bcould not establish a WebSocket connection\.$/i,
] as const;

export function isActionableEnvironmentDisconnectMessage(
  message: string | null | undefined,
): boolean {
  if (typeof message !== "string") {
    return false;
  }
  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }
  return ACTIONABLE_ENVIRONMENT_DISCONNECT_PATTERNS.some((pattern) =>
    pattern.test(normalizedMessage),
  );
}

/**
 * Strip transient transport noise from user-facing thread errors.
 * Returns `null` for low-signal socket churn so the UI can stay quiet.
 *
 * Explicit environment-unavailable messages (`is not connected`, failed
 * WebSocket establish) are preserved so Send failures are never silent.
 */
export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  if (typeof message !== "string") {
    return null;
  }
  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return null;
  }
  if (isActionableEnvironmentDisconnectMessage(normalizedMessage)) {
    return normalizedMessage;
  }
  return isTransportConnectionErrorMessage(normalizedMessage) ? null : normalizedMessage;
}
