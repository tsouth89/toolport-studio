import { ProviderInstanceId, ThreadId } from "@toolport-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  /** Kept only in process memory so duplicate session attachment can reuse the bearer. */
  readonly rawToken: string;
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastUsedAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly idleTimeoutMs?: number;
  readonly maximumLifetimeMs?: number;
  readonly now?: () => number;
}

// Provider sessions can remain alive for days, and the preview bearer is held by
// their already-running Toolport gateway child. Expiring that bearer on a timer
// strands the child with no refresh channel. Production credentials therefore
// live until explicit provider-session revocation or server shutdown. Tests can
// still supply finite limits to exercise expiry behavior.
const DEFAULT_IDLE_TIMEOUT_MS = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAXIMUM_LIFETIME_MS = Number.MAX_SAFE_INTEGER;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const getHttpMcpEndpointHost = (hostname: string): string => {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
};

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS;
  const endpoint =
    httpServer.address._tag === "TcpAddress"
      ? `http://${getHttpMcpEndpointHost(httpServer.address.hostname)}:${httpServer.address.port}/mcp`
      : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneExpired = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      Array.from(records).filter(
        ([, record]) =>
          timestamp <= record.scope.expiresAt && timestamp - record.lastUsedAt <= idleTimeoutMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issuedCredentialFromRecord = (record: CredentialRecord): McpIssuedCredential => ({
    config: {
      environmentId,
      threadId: record.scope.threadId,
      providerSessionId: record.scope.providerSessionId,
      providerInstanceId: record.scope.providerInstanceId,
      endpoint,
      authorizationHeader: `Bearer ${record.rawToken}`,
    },
    expiresAt: record.scope.expiresAt,
  });

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      return yield* SynchronizedRef.modifyEffect(state, ({ records }) =>
        Effect.gen(function* () {
          const current = pruneExpired(records, issuedAt);
          const existing = Array.from(current.values()).find(
            (record) =>
              record.scope.threadId === request.threadId &&
              record.scope.providerInstanceId === request.providerInstanceId,
          );
          if (existing) {
            const next = new Map(current);
            const refreshed = { ...existing, lastUsedAt: issuedAt };
            next.set(existing.tokenHash, refreshed);
            return [issuedCredentialFromRecord(refreshed), { records: next }] as const;
          }

          const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const rawToken = yield* crypto
            .randomBytes(32)
            .pipe(Effect.map(tokenFromBytes), Effect.orDie);
          const tokenHash = yield* hashToken(rawToken);
          const expiresAt = Math.min(Number.MAX_SAFE_INTEGER, issuedAt + maximumLifetimeMs);
          const scope: McpInvocationContext.McpInvocationScope = {
            environmentId,
            threadId: ThreadId.make(request.threadId),
            providerSessionId,
            providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
            capabilities: new Set(["preview"]),
            issuedAt,
            expiresAt,
          };
          const record: CredentialRecord = {
            rawToken,
            tokenHash,
            scope,
            lastUsedAt: issuedAt,
          };
          const next = new Map(
            Array.from(current).filter(
              ([, candidate]) => candidate.scope.threadId !== request.threadId,
            ),
          );
          next.set(tokenHash, record);
          return [issuedCredentialFromRecord(record), { records: next }] as const;
        }),
      );
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      return yield* SynchronizedRef.modify(state, ({ records }) => {
        const current = pruneExpired(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) return [undefined, { records: current }] as const;
        const next = new Map(current);
        next.set(tokenHash, { ...record, lastUsedAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry.issue(request)
    : Effect.sync((): McpIssuedCredential | undefined => undefined);

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
