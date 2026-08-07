import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@toolport-studio/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedErrorClass<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@toolport-studio/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof ORCHESTRATION_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.previewAutomationConnect
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.terminalAttach;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const request = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStream<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    currentSession().pipe(
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

// A transport fault usually resolves either immediately (the stream faulted
// alone and the socket is fine) or not at all until the supervisor swaps the
// session, so the first retry is fast and the ceiling stays low: the cost of
// an extra attempt is one subscribe, and the cost of not retrying is a
// projection that never moves again.
const TRANSPORT_RETRY_BASE_MILLIS = 250;
const TRANSPORT_RETRY_CAP_MILLIS = 5_000;

function transportRetryBackoff(attempt: number): Duration.Input {
  return Math.min(TRANSPORT_RETRY_BASE_MILLIS * 2 ** attempt, TRANSPORT_RETRY_CAP_MILLIS);
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input | ((attempt: number) => Duration.Input);
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) => {
        const sessionChanges = SubscriptionRef.changes(supervisor.session);
        const sessions =
          options?.resubscribe === undefined
            ? sessionChanges
            : Stream.merge(
                sessionChanges,
                options.resubscribe.pipe(
                  Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
                ),
              );
        return sessions.pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: (session) => {
                const method = session.client[tag] as (
                  input: EnvironmentRpcInput<TTag>,
                ) => Stream.Stream<
                  EnvironmentRpcStreamValue<TTag>,
                  EnvironmentRpcStreamFailure<TTag>
                >;
                // Counts consecutive expected failures so retry backoff can
                // grow; any delivered element proves the subscription works
                // again and resets it.
                let consecutiveExpectedFailures = 0;
                // Tracked separately from expected failures: a transport fault
                // is not the subscription's own error, so the two must not
                // share a backoff.
                let consecutiveTransportFailures = 0;
                const subscribeToSession = (): Stream.Stream<
                  EnvironmentRpcStreamValue<TTag>,
                  EnvironmentRpcStreamFailure<TTag>
                > =>
                  Stream.suspend(() =>
                    Stream.unwrap(
                      makeInput(session).pipe(
                        Effect.map((input) =>
                          method(input).pipe(
                            Stream.tap(() =>
                              Effect.sync(() => {
                                consecutiveExpectedFailures = 0;
                                consecutiveTransportFailures = 0;
                              }),
                            ),
                            Stream.catchCause((cause) => {
                              const hasOnlyExpectedFailures =
                                cause.reasons.length > 0 &&
                                cause.reasons.every((reason) => reason._tag === "Fail");
                              const isTransportFailure =
                                hasOnlyExpectedFailures &&
                                cause.reasons.every(
                                  (reason) =>
                                    reason._tag === "Fail" && isRpcClientError(reason.error),
                                );
                              if (isTransportFailure) {
                                // A transport fault ends THIS stream, which is
                                // not the same as the socket dying: the
                                // supervisor only publishes a new session when
                                // the connection itself is replaced. Draining
                                // here left the subscription waiting for a
                                // session change that never arrived, so the
                                // projection sat on whatever it had last
                                // applied — a turn still shown as live long
                                // after the server finished it — while unary
                                // calls over the same socket kept working,
                                // which is exactly why the client looked
                                // connected and only a restart revealed the
                                // real state.
                                //
                                // Retry against the current session instead. If
                                // the socket really did die, the supervisor's
                                // next session interrupts this retry through
                                // the outer switchMap, so the dead-socket path
                                // is unchanged.
                                const delay = transportRetryBackoff(consecutiveTransportFailures);
                                consecutiveTransportFailures += 1;
                                return Stream.fromEffect(
                                  Effect.logWarning(
                                    "Durable RPC subscription lost its transport; resubscribing.",
                                    {
                                      cause: Cause.pretty(cause),
                                      method: tag,
                                      environmentId: supervisor.target.environmentId,
                                      attempt: consecutiveTransportFailures,
                                    },
                                  ),
                                ).pipe(
                                  Stream.drain,
                                  Stream.concat(
                                    Stream.fromEffect(Effect.sleep(delay)).pipe(Stream.drain),
                                  ),
                                  Stream.concat(subscribeToSession()),
                                );
                              }
                              if (
                                hasOnlyExpectedFailures &&
                                options?.onExpectedFailure !== undefined
                              ) {
                                const handled = Stream.fromEffect(
                                  options.onExpectedFailure(cause),
                                ).pipe(Stream.drain);
                                const retryAfter = options.retryExpectedFailureAfter;
                                if (retryAfter === undefined) {
                                  return handled;
                                }
                                const delay =
                                  typeof retryAfter === "function"
                                    ? retryAfter(consecutiveExpectedFailures)
                                    : retryAfter;
                                consecutiveExpectedFailures += 1;
                                return handled.pipe(
                                  Stream.concat(
                                    Stream.fromEffect(Effect.sleep(delay)).pipe(Stream.drain),
                                  ),
                                  Stream.concat(subscribeToSession()),
                                );
                              }
                              return Stream.failCause(cause);
                            }),
                          ),
                        ),
                      ),
                    ),
                  );
                return subscribeToSession();
              },
            }),
          ),
        );
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const config = Effect.gen(function* () {
  const session = yield* currentSession();
  return yield* session.initialConfig;
}).pipe(Effect.withSpan("EnvironmentRpc.config"));
