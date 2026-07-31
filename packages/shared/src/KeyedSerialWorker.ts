/**
 * KeyedSerialWorker - Independent serial work lanes keyed by an identity.
 *
 * Work for the same key is processed in enqueue order. Different keys run
 * concurrently, so one blocked lane cannot create global head-of-line
 * blocking. Idle lanes are retired after a bounded timeout.
 *
 * @module KeyedSerialWorker
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as TxRef from "effect/TxRef";

export interface KeyedSerialWorker<K, A> {
  /** Enqueue an item in the serial lane for `key`. */
  readonly enqueue: (key: K, item: A) => Effect.Effect<void>;

  /** Resolves when every accepted item across all lanes has finished. */
  readonly drain: Effect.Effect<void>;

  /** Number of live lanes, including lanes waiting for their idle timeout. */
  readonly activeLaneCount: Effect.Effect<number>;
}

export interface KeyedSerialWorkerOptions<K, A, R> {
  /**
   * Process one item. Failures must be handled by the caller so a lane cannot
   * die with later accepted items still queued behind it.
   */
  readonly process: (key: K, item: A) => Effect.Effect<void, never, R>;
  readonly idleTimeToLive?: Duration.Input;
  readonly backlogWarningThreshold?: number;
  readonly keyLabel?: (key: K) => string;
}

interface Lane<A> {
  readonly queue: Queue.Queue<A>;
  readonly identity: object;
  backlogWarningEmitted: boolean;
}

const DEFAULT_IDLE_TIME_TO_LIVE = Duration.seconds(30);
const DEFAULT_BACKLOG_WARNING_THRESHOLD = 64;

export const makeKeyedSerialWorker = <K, A, R>(
  options: KeyedSerialWorkerOptions<K, A, R>,
): Effect.Effect<KeyedSerialWorker<K, A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.Scope;
    const processContext = yield* Effect.context<R>();
    const lanes = new Map<K, Lane<A>>();
    const laneLock = yield* Semaphore.make(1);
    const outstanding = yield* TxRef.make(0);
    const idleTimeToLive = options.idleTimeToLive ?? DEFAULT_IDLE_TIME_TO_LIVE;
    const backlogWarningThreshold =
      options.backlogWarningThreshold ?? DEFAULT_BACKLOG_WARNING_THRESHOLD;

    const retireLaneIfIdle = (key: K, lane: Lane<A>) =>
      laneLock.withPermits(1)(
        Effect.gen(function* () {
          if (lanes.get(key)?.identity !== lane.identity) {
            return false;
          }
          if ((yield* Queue.size(lane.queue)) > 0) {
            lane.backlogWarningEmitted = false;
            return false;
          }
          lanes.delete(key);
          yield* Queue.shutdown(lane.queue);
          return true;
        }),
      );

    const runLane = (key: K, lane: Lane<A>): Effect.Effect<void, never, R> =>
      Queue.take(lane.queue).pipe(
        Effect.timeoutOption(idleTimeToLive),
        Effect.flatMap((item) => {
          if (Option.isNone(item)) {
            return retireLaneIfIdle(key, lane).pipe(
              Effect.flatMap((retired) => (retired ? Effect.void : runLane(key, lane))),
            );
          }

          return options.process(key, item.value).pipe(
            Effect.ensuring(TxRef.update(outstanding, (count) => count - 1)),
            Effect.flatMap(() => runLane(key, lane)),
          );
        }),
      );

    const enqueue: KeyedSerialWorker<K, A>["enqueue"] = (key, item) =>
      laneLock.withPermits(1)(
        Effect.gen(function* () {
          let lane = lanes.get(key);
          if (!lane) {
            lane = {
              queue: yield* Queue.unbounded<A>(),
              identity: {},
              backlogWarningEmitted: false,
            };
            lanes.set(key, lane);
            yield* runLane(key, lane).pipe(
              Effect.provideContext(processContext),
              Effect.forkIn(parentScope),
            );
          }

          yield* TxRef.update(outstanding, (count) => count + 1).pipe(Effect.tx);
          const accepted = yield* Queue.offer(lane.queue, item);
          if (!accepted) {
            yield* TxRef.update(outstanding, (count) => count - 1).pipe(Effect.tx);
            return;
          }

          const depth = yield* Queue.size(lane.queue);
          if (
            backlogWarningThreshold > 0 &&
            depth >= backlogWarningThreshold &&
            !lane.backlogWarningEmitted
          ) {
            lane.backlogWarningEmitted = true;
            yield* Effect.logWarning("keyed serial worker backlog threshold reached", {
              key: options.keyLabel?.(key) ?? String(key),
              depth,
              threshold: backlogWarningThreshold,
            });
          }
        }),
      );

    const drain: KeyedSerialWorker<K, A>["drain"] = TxRef.get(outstanding).pipe(
      Effect.tap((count) => (count > 0 ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );

    const activeLaneCount: KeyedSerialWorker<K, A>["activeLaneCount"] = laneLock.withPermits(1)(
      Effect.sync(() => lanes.size),
    );

    yield* Effect.addFinalizer(() =>
      laneLock.withPermits(1)(
        Effect.gen(function* () {
          const queues = Array.from(lanes.values(), (lane) => lane.queue);
          lanes.clear();
          yield* Effect.forEach(queues, Queue.shutdown, {
            concurrency: "unbounded",
            discard: true,
          });
        }),
      ),
    );

    return { enqueue, drain, activeLaneCount } satisfies KeyedSerialWorker<K, A>;
  });
