import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@toolport-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ORCHESTRATION_SIDE_EFFECT_CONSUMERS } from "../../persistence/Services/OrchestrationEventStore.ts";
import { makeDurableSideEffectReactor } from "../DurableSideEffectReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { QueuedTurnReactor, type QueuedTurnReactorShape } from "../Services/QueuedTurnReactor.ts";

type ThreadTurnQueuedEvent = Extract<OrchestrationEvent, { type: "thread.turn-queued" }>;

class QueuedTurnWaitingError extends Error {
  readonly _tag = "QueuedTurnWaitingError";
}

export function hasUnadoptedTurnStart(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn">,
): boolean {
  const latestUserMessage = thread.messages.findLast((message) => message.role === "user");
  if (!latestUserMessage) {
    return false;
  }
  return thread.latestTurn === null || latestUserMessage.createdAt > thread.latestTurn.requestedAt;
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;

  const processQueuedTurn = Effect.fn("processQueuedTurn")(function* (
    event: ThreadTurnQueuedEvent,
  ) {
    const threadOption = yield* snapshots.getThreadDetailById(event.payload.threadId);
    if (Option.isNone(threadOption)) {
      return;
    }
    const thread = threadOption.value;
    const queuedTurns = thread.queuedTurns ?? [];
    const queuedTurn = queuedTurns.find(
      (entry) => entry.message.messageId === event.payload.queuedTurn.message.messageId,
    );
    if (!queuedTurn) {
      return;
    }
    if (queuedTurns[0]?.message.messageId !== queuedTurn.message.messageId) {
      return yield* Effect.fail(new QueuedTurnWaitingError("An earlier queued turn is pending."));
    }
    if (thread.session?.status === "starting" || thread.session?.status === "running") {
      return yield* Effect.fail(new QueuedTurnWaitingError("The active turn is still running."));
    }
    if (hasUnadoptedTurnStart(thread)) {
      return yield* Effect.fail(
        new QueuedTurnWaitingError("The previous queued turn has not been adopted yet."),
      );
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.turn.queue.flush",
      commandId: CommandId.make(`server:queued-turn:${queuedTurn.message.messageId}`),
      threadId: event.payload.threadId,
      messageId: queuedTurn.message.messageId,
      createdAt,
    });
  });

  const durableReactor = yield* makeDurableSideEffectReactor({
    consumer: ORCHESTRATION_SIDE_EFFECT_CONSUMERS.queuedTurn,
    decode: (event): ThreadTurnQueuedEvent | null =>
      event.type === "thread.turn-queued" ? event : null,
    key: (event) => event.payload.threadId,
    keyLabel: String,
    process: processQueuedTurn,
  });

  return {
    start: durableReactor.start,
    drain: durableReactor.drain,
    shutdown: durableReactor.shutdown,
  } satisfies QueuedTurnReactorShape;
});

export const QueuedTurnReactorLive = Layer.effect(QueuedTurnReactor, make);
