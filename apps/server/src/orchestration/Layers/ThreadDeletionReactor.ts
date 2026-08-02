import type { OrchestrationEvent } from "@toolport-studio/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ORCHESTRATION_SIDE_EFFECT_CONSUMERS } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { makeDurableSideEffectReactor } from "../DurableSideEffectReactor.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    providerService.stopSession({ threadId });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    terminalManager.close({ threadId, deleteHistory: true });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* Effect.all([stopProviderSession(threadId), closeThreadTerminals(threadId)], {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const isThreadDeletedEvent = (event: OrchestrationEvent): event is ThreadDeletedEvent =>
    event.type === "thread.deleted";

  const durableReactor = yield* makeDurableSideEffectReactor({
    consumer: ORCHESTRATION_SIDE_EFFECT_CONSUMERS.threadDeletion,
    decode: (event) => (isThreadDeletedEvent(event) ? event : null),
    key: (event) => event.payload.threadId,
    keyLabel: String,
    process: processThreadDeleted,
    onFailure: (event, cause) =>
      Effect.logWarning("thread deletion reactor failed to process durable event", {
        eventType: event.type,
        threadId: event.payload.threadId,
        cause: Cause.pretty(cause),
      }),
  });

  return {
    start: durableReactor.start,
    drain: durableReactor.drain,
    shutdown: durableReactor.shutdown,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
