/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import { OrchestrationEvent } from "@toolport-studio/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

export const ORCHESTRATION_SIDE_EFFECT_CONSUMERS = {
  providerCommand: "side-effect.provider-command",
  checkpoint: "side-effect.checkpoint",
  threadDeletion: "side-effect.thread-deletion",
  queuedTurn: "side-effect.queued-turn",
} as const;

export type OrchestrationSideEffectConsumer =
  (typeof ORCHESTRATION_SIDE_EFFECT_CONSUMERS)[keyof typeof ORCHESTRATION_SIDE_EFFECT_CONSUMERS];

export interface OrchestrationSideEffectDelivery {
  readonly consumer: OrchestrationSideEffectConsumer;
  readonly event: OrchestrationEvent;
  readonly attemptCount: number;
}

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Hard-delete orchestration events with sequence at or below the inclusive
   * cursor. Only safe after every projector has applied that sequence
   * (SOU-400 event retention).
   */
  readonly deleteUpToSequenceInclusive: (
    sequenceInclusive: number,
  ) => Effect.Effect<void, OrchestrationEventStoreError>;

  /**
   * Reclaim deliveries left in `processing` by a previous process.
   */
  readonly recoverSideEffectDeliveries: (
    consumer: OrchestrationSideEffectConsumer,
  ) => Effect.Effect<void, OrchestrationEventStoreError>;

  /**
   * Atomically claim ready durable side effects for one consumer.
   */
  readonly claimSideEffectDeliveries: (input: {
    readonly consumer: OrchestrationSideEffectConsumer;
    readonly limit: number;
    readonly nowMs: number;
  }) => Effect.Effect<ReadonlyArray<OrchestrationSideEffectDelivery>, OrchestrationEventStoreError>;

  readonly completeSideEffectDelivery: (input: {
    readonly consumer: OrchestrationSideEffectConsumer;
    readonly eventSequence: number;
    readonly updatedAt: string;
  }) => Effect.Effect<void, OrchestrationEventStoreError>;

  readonly failSideEffectDelivery: (input: {
    readonly consumer: OrchestrationSideEffectConsumer;
    readonly eventSequence: number;
    readonly availableAtMs: number;
    readonly detail: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, OrchestrationEventStoreError>;

  /**
   * Whether this stream carries a Stop after `afterSequence`.
   *
   * Authoritative answer to "did the user stop this thread after that turn was
   * requested?". The turn and control lanes run concurrently, so the in-memory
   * view of a Stop is not reliable at the moment a queued turn dispatches: the
   * Stop event is durable as soon as it is appended, but the control lane may
   * not have processed it yet. Reading the log closes that race and does not
   * depend on cache TTL or capacity (SOU-569).
   */
  readonly hasLaterStreamStop: (input: {
    readonly streamId: string;
    readonly afterSequence: number;
  }) => Effect.Effect<boolean, OrchestrationEventStoreError>;

  readonly countUnfinishedSideEffectDeliveries: (
    consumer: OrchestrationSideEffectConsumer,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}
