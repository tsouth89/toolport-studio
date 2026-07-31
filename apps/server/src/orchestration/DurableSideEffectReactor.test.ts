import { CommandId, EventId, type OrchestrationEvent, ThreadId } from "@toolport-studio/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ORCHESTRATION_SIDE_EFFECT_CONSUMERS,
  OrchestrationEventStore,
} from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { makeDurableSideEffectReactor } from "./DurableSideEffectReactor.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("DurableSideEffectReactor", (it) => {
  it.effect("stops intake and waits for already-claimed work during shutdown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const processing = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const now = "2026-01-01T00:00:00.000Z";

        const engine = {
          readEvents: eventStore.readFromSequence,
          dispatch: () => Effect.die("dispatch is not used by this test"),
          get streamDomainEvents() {
            return Stream.fromPubSub(events);
          },
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngineService["Service"];

        const reactor = yield* makeDurableSideEffectReactor({
          consumer: ORCHESTRATION_SIDE_EFFECT_CONSUMERS.providerCommand,
          decode: (event) => (event.type === "thread.session-stop-requested" ? event : null),
          key: (event) => event.payload.threadId,
          process: () =>
            Deferred.succeed(processing, undefined).pipe(Effect.andThen(Deferred.await(release))),
        }).pipe(Effect.provideService(OrchestrationEngineService, engine));

        yield* reactor.start();
        const event = yield* eventStore.append({
          type: "thread.session-stop-requested",
          eventId: EventId.make("evt-shutdown-queued"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-shutdown-queued"),
          occurredAt: now,
          commandId: CommandId.make("cmd-shutdown-queued"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-shutdown-queued"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-shutdown-queued"),
            createdAt: now,
          },
        });
        yield* PubSub.publish(events, event);

        const drainFiber = yield* Effect.forkChild(reactor.drain);
        yield* Deferred.await(processing);
        const shutdownCompleted = yield* Deferred.make<void>();
        const shutdownFiber = yield* Effect.forkChild(
          reactor.shutdown.pipe(Effect.andThen(Deferred.succeed(shutdownCompleted, undefined))),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(shutdownCompleted));

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(drainFiber);
        yield* Fiber.join(shutdownFiber);
        assert.equal(
          yield* eventStore.countUnfinishedSideEffectDeliveries(
            ORCHESTRATION_SIDE_EFFECT_CONSUMERS.providerCommand,
          ),
          0,
        );
      }),
    ),
  );
});
