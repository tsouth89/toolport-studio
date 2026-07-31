import type { OrchestrationEvent } from "@toolport-studio/contracts";
import { makeKeyedSerialWorker } from "@toolport-studio/shared/KeyedSerialWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  OrchestrationEventStore,
  type OrchestrationSideEffectConsumer,
  type OrchestrationSideEffectDelivery,
} from "../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const CLAIM_BATCH_SIZE = 32;
const RETRY_POLL_INTERVAL = Duration.seconds(1);
const MAX_RETRY_DELAY_MS = 30_000;

export interface DurableSideEffectReactor {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

export interface DurableSideEffectReactorOptions<K, E, Err, R> {
  readonly consumer: OrchestrationSideEffectConsumer;
  readonly key: (event: E) => K;
  readonly decode: (event: OrchestrationEvent) => E | null;
  readonly process: (event: E) => Effect.Effect<void, Err, R>;
  readonly keyLabel?: (key: K) => string;
  readonly laneIdleTimeToLive?: Duration.Input;
  readonly onFailure?: (event: E, cause: Cause.Cause<Err>) => Effect.Effect<void, never, R>;
}

interface TypedDelivery<E> {
  readonly delivery: OrchestrationSideEffectDelivery;
  readonly event: E;
}

const retryDelayMs = (attemptCount: number): number =>
  Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** Math.min(7, Math.max(0, attemptCount - 1)));

export const makeDurableSideEffectReactor = <K, E extends OrchestrationEvent, Err, R>(
  options: DurableSideEffectReactorOptions<K, E, Err, R>,
): Effect.Effect<
  DurableSideEffectReactor,
  never,
  Scope.Scope | OrchestrationEngineService | OrchestrationEventStore | R
> =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const eventStore = yield* OrchestrationEventStore;
    const accepting = yield* Ref.make(true);
    const wake = yield* Queue.sliding<void>(1);
    const claimLock = yield* Semaphore.make(1);

    const settleDelivery = (item: TypedDelivery<E>): Effect.Effect<void, never, R> =>
      Effect.gen(function* () {
        const { delivery, event } = item;
        const exit = yield* Effect.exit(options.process(event));
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        if (Exit.isSuccess(exit)) {
          yield* eventStore
            .completeSideEffectDelivery({
              consumer: options.consumer,
              eventSequence: delivery.event.sequence,
              updatedAt,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logError("failed to complete durable side-effect delivery", {
                  consumer: options.consumer,
                  sequence: delivery.event.sequence,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          return;
        }

        const nowMs = yield* Clock.currentTimeMillis;
        const detail = Cause.pretty(exit.cause);
        yield* eventStore
          .failSideEffectDelivery({
            consumer: options.consumer,
            eventSequence: delivery.event.sequence,
            availableAtMs: nowMs + retryDelayMs(delivery.attemptCount),
            detail,
            updatedAt,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("failed to record durable side-effect failure", {
                consumer: options.consumer,
                sequence: delivery.event.sequence,
                originalCause: detail,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        yield* options.onFailure?.(event, exit.cause) ?? Effect.void;
      });

    const workerOptions = {
      process: (_key, item) => settleDelivery(item),
      ...(options.keyLabel === undefined ? {} : { keyLabel: options.keyLabel }),
      ...(options.laneIdleTimeToLive === undefined
        ? {}
        : { idleTimeToLive: options.laneIdleTimeToLive }),
    } satisfies Parameters<typeof makeKeyedSerialWorker<K, TypedDelivery<E>, R>>[0];
    const worker = yield* makeKeyedSerialWorker(workerOptions);

    const claimOnce = Effect.fn("claimDurableSideEffects")(() =>
      claimLock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* Ref.get(accepting))) {
            return 0;
          }
          const deliveries = yield* eventStore.claimSideEffectDeliveries({
            consumer: options.consumer,
            limit: CLAIM_BATCH_SIZE,
            nowMs: yield* Clock.currentTimeMillis,
          });
          yield* Effect.forEach(
            deliveries,
            (delivery) => {
              const event = options.decode(delivery.event);
              if (event === null) {
                return Effect.logError(
                  "durable side-effect delivery routed to the wrong consumer",
                  {
                    consumer: options.consumer,
                    sequence: delivery.event.sequence,
                    eventType: delivery.event.type,
                  },
                ).pipe(
                  Effect.andThen(
                    eventStore.completeSideEffectDelivery({
                      consumer: options.consumer,
                      eventSequence: delivery.event.sequence,
                      updatedAt: delivery.event.occurredAt,
                    }),
                  ),
                );
              }
              return worker.enqueue(options.key(event), { delivery, event });
            },
            { concurrency: 1, discard: true },
          );
          return deliveries.length;
        }),
      ),
    );

    const claimAvailable = Effect.gen(function* () {
      while ((yield* claimOnce()) === CLAIM_BATCH_SIZE) {
        yield* worker.drain;
      }
      yield* worker.drain;
    });

    const claimAvailableSafely = claimAvailable.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable side-effect claim failed", {
          consumer: options.consumer,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const claimOnceSafely = claimOnce().pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable side-effect claim failed", {
          consumer: options.consumer,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const start: DurableSideEffectReactor["start"] = Effect.fn("start")(function* () {
      yield* eventStore.recoverSideEffectDeliveries(options.consumer).pipe(Effect.orDie);

      yield* Effect.forkScoped(
        Stream.runForEach(engine.streamDomainEvents, () => Queue.offer(wake, undefined)),
      );
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(RETRY_POLL_INTERVAL).pipe(Effect.andThen(Queue.offer(wake, undefined))),
        ),
      );

      // Catch up accepted work before startup can announce command readiness.
      yield* claimAvailable.pipe(Effect.orDie);

      yield* Effect.forkScoped(
        Effect.forever(Queue.take(wake).pipe(Effect.andThen(claimOnceSafely))),
      );
    });

    const drain: DurableSideEffectReactor["drain"] = Effect.gen(function* () {
      yield* claimAvailableSafely;
      yield* worker.drain;
    });

    const shutdown: DurableSideEffectReactor["shutdown"] = Effect.gen(function* () {
      yield* Ref.set(accepting, false);
      // Synchronize with a claim already in progress so every claimed item is
      // enqueued before the worker drain is observed as complete.
      yield* claimLock.withPermits(1)(Effect.void);
      yield* worker.drain;
    });

    yield* Effect.addFinalizer(() => Queue.shutdown(wake));

    return { start, drain, shutdown } satisfies DurableSideEffectReactor;
  });
