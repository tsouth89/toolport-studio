import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  ProjectId,
  SidebarFolderId,
  ThreadId,
} from "@toolport-studio/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  ORCHESTRATION_SIDE_EFFECT_CONSUMERS,
  OrchestrationEventStore,
  type OrchestrationSideEffectConsumer,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata);

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, SidebarFolderId, ThreadId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
});

const OrchestrationEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
});
const DeleteUpToSequenceRequestSchema = Schema.Struct({
  sequenceInclusive: NonNegativeInt,
});
const SideEffectConsumerSchema = Schema.Literals([
  ORCHESTRATION_SIDE_EFFECT_CONSUMERS.providerCommand,
  ORCHESTRATION_SIDE_EFFECT_CONSUMERS.checkpoint,
  ORCHESTRATION_SIDE_EFFECT_CONSUMERS.threadDeletion,
  ORCHESTRATION_SIDE_EFFECT_CONSUMERS.queuedTurn,
]);
const SideEffectConsumerRequestSchema = Schema.Struct({
  consumer: SideEffectConsumerSchema,
});
const ClaimSideEffectDeliveriesRequestSchema = Schema.Struct({
  consumer: SideEffectConsumerSchema,
  limit: Schema.Number,
  nowMs: Schema.Number,
});
const SideEffectDeliveryRowSchema = Schema.Struct({
  consumer: SideEffectConsumerSchema,
  attemptCount: NonNegativeInt,
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});
const SettleSideEffectDeliveryRequestSchema = Schema.Struct({
  consumer: SideEffectConsumerSchema,
  eventSequence: NonNegativeInt,
  updatedAt: IsoDateTime,
});
const FailSideEffectDeliveryRequestSchema = Schema.Struct({
  consumer: SideEffectConsumerSchema,
  eventSequence: NonNegativeInt,
  availableAtMs: Schema.Number,
  detail: Schema.String,
  updatedAt: IsoDateTime,
});
const CountRowSchema = Schema.Struct({
  count: NonNegativeInt,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;

function sideEffectConsumersForEvent(
  event: Omit<OrchestrationEvent, "sequence">,
): ReadonlyArray<OrchestrationSideEffectConsumer> {
  switch (event.type) {
    case "thread.turn-start-requested":
      return [
        ORCHESTRATION_SIDE_EFFECT_CONSUMERS.providerCommand,
        ORCHESTRATION_SIDE_EFFECT_CONSUMERS.checkpoint,
      ];
    case "thread.runtime-mode-set":
    case "thread.turn-interrupt-requested":
    case "thread.approval-response-requested":
    case "thread.user-input-response-requested":
    case "thread.session-stop-requested":
      return [ORCHESTRATION_SIDE_EFFECT_CONSUMERS.providerCommand];
    case "thread.turn-diff-completed":
      return [ORCHESTRATION_SIDE_EFFECT_CONSUMERS.checkpoint];
    case "thread.message-sent":
    case "thread.checkpoint-revert-requested":
      return [ORCHESTRATION_SIDE_EFFECT_CONSUMERS.checkpoint];
    case "thread.deleted":
      return [ORCHESTRATION_SIDE_EFFECT_CONSUMERS.threadDeletion];
    case "thread.turn-queued":
      return [ORCHESTRATION_SIDE_EFFECT_CONSUMERS.queuedTurn];
    default:
      return [];
  }
}

function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = ${request.aggregateKind}
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  const deleteEventRowsUpToSequence = SqlSchema.void({
    Request: DeleteUpToSequenceRequestSchema,
    execute: ({ sequenceInclusive }) =>
      sql`
        DELETE FROM orchestration_events
        WHERE sequence <= ${sequenceInclusive}
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_side_effect_deliveries
            WHERE event_sequence = orchestration_events.sequence
              AND status != 'succeeded'
          )
      `,
  });

  const recoverSideEffectDeliveryRows = SqlSchema.void({
    Request: SideEffectConsumerRequestSchema,
    execute: ({ consumer }) =>
      sql`
        UPDATE orchestration_side_effect_deliveries
        SET status = 'pending'
        WHERE consumer = ${consumer}
          AND status = 'processing'
      `,
  });

  const claimSideEffectDeliveryRows = SqlSchema.findAll({
    Request: ClaimSideEffectDeliveriesRequestSchema,
    Result: SideEffectDeliveryRowSchema,
    execute: ({ consumer, limit, nowMs }) =>
      sql`
        UPDATE orchestration_side_effect_deliveries
        SET
          status = 'processing',
          attempt_count = attempt_count + 1
        WHERE (consumer, event_sequence) IN (
          SELECT consumer, event_sequence
          FROM orchestration_side_effect_deliveries
          WHERE consumer = ${consumer}
            AND status IN ('pending', 'failed')
            AND available_at_ms <= ${nowMs}
          ORDER BY event_sequence ASC
          LIMIT ${limit}
        )
        RETURNING
          consumer,
          attempt_count AS "attemptCount",
          event_sequence AS sequence,
          (
            SELECT event_id
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS "eventId",
          (
            SELECT event_type
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS type,
          (
            SELECT aggregate_kind
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS "aggregateKind",
          (
            SELECT stream_id
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS "aggregateId",
          (
            SELECT occurred_at
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS "occurredAt",
          (
            SELECT command_id
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS "commandId",
          (
            SELECT causation_event_id
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS "causationEventId",
          (
            SELECT correlation_id
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS "correlationId",
          (
            SELECT payload_json
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS payload,
          (
            SELECT metadata_json
            FROM orchestration_events
            WHERE sequence = event_sequence
          ) AS metadata
      `,
  });

  const completeSideEffectDeliveryRow = SqlSchema.void({
    Request: SettleSideEffectDeliveryRequestSchema,
    execute: ({ consumer, eventSequence, updatedAt }) =>
      sql`
        UPDATE orchestration_side_effect_deliveries
        SET
          status = 'succeeded',
          last_error = NULL,
          updated_at = ${updatedAt}
        WHERE consumer = ${consumer}
          AND event_sequence = ${eventSequence}
      `,
  });

  const failSideEffectDeliveryRow = SqlSchema.void({
    Request: FailSideEffectDeliveryRequestSchema,
    execute: ({ consumer, eventSequence, availableAtMs, detail, updatedAt }) =>
      sql`
        UPDATE orchestration_side_effect_deliveries
        SET
          status = 'failed',
          available_at_ms = ${availableAtMs},
          last_error = ${detail},
          updated_at = ${updatedAt}
        WHERE consumer = ${consumer}
          AND event_sequence = ${eventSequence}
      `,
  });

  const countUnfinishedSideEffectDeliveryRows = SqlSchema.findOne({
    Request: SideEffectConsumerRequestSchema,
    Result: CountRowSchema,
    execute: ({ consumer }) =>
      sql`
        SELECT COUNT(*) AS count
        FROM orchestration_side_effect_deliveries
        WHERE consumer = ${consumer}
          AND status != 'succeeded'
      `,
  });

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    sql
      .withTransaction(
        appendEventRow({
          eventId: event.eventId,
          aggregateKind: event.aggregateKind,
          streamId: event.aggregateId,
          type: event.type,
          causationEventId: event.causationEventId,
          correlationId: event.correlationId,
          actorKind: inferActorKind(event),
          occurredAt: event.occurredAt,
          commandId: event.commandId,
          payloadJson: event.payload,
          metadataJson: event.metadata,
        }).pipe(
          Effect.flatMap((row) =>
            Effect.forEach(
              sideEffectConsumersForEvent(event),
              (consumer) =>
                sql`
                  INSERT OR IGNORE INTO orchestration_side_effect_deliveries (
                    consumer,
                    event_sequence,
                    status,
                    attempt_count,
                    available_at_ms,
                    last_error,
                    updated_at
                  )
                  VALUES (
                    ${consumer},
                    ${row.sequence},
                    'pending',
                    0,
                    0,
                    NULL,
                    ${event.occurredAt}
                  )
                `,
              { concurrency: 1, discard: true },
            ).pipe(Effect.as(row)),
          ),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.append:insert",
            "OrchestrationEventStore.append:decodeRow",
          ),
        ),
        Effect.flatMap((row) =>
          decodeEvent(row).pipe(
            Effect.mapError(toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent")),
          ),
        ),
      );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEvent(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextRemaining = remaining - events.length;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          );
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  const deleteUpToSequenceInclusive: OrchestrationEventStoreShape["deleteUpToSequenceInclusive"] = (
    sequenceInclusive,
  ) => {
    const normalizedSequence = Math.max(0, Math.floor(sequenceInclusive));
    if (normalizedSequence <= 0) {
      return Effect.void;
    }
    return sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM orchestration_side_effect_deliveries
            WHERE event_sequence <= ${normalizedSequence}
              AND status = 'succeeded'
          `;
          yield* deleteEventRowsUpToSequence({ sequenceInclusive: normalizedSequence });
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.deleteUpToSequenceInclusive:query",
            "OrchestrationEventStore.deleteUpToSequenceInclusive:encodeRequest",
          ),
        ),
      );
  };

  const recoverSideEffectDeliveries: OrchestrationEventStoreShape["recoverSideEffectDeliveries"] = (
    consumer,
  ) =>
    recoverSideEffectDeliveryRows({ consumer }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.recoverSideEffectDeliveries:query",
          "OrchestrationEventStore.recoverSideEffectDeliveries:encodeRequest",
        ),
      ),
    );

  const claimSideEffectDeliveries: OrchestrationEventStoreShape["claimSideEffectDeliveries"] = (
    input,
  ) =>
    sql
      .withTransaction(
        claimSideEffectDeliveryRows({
          ...input,
          limit: Math.max(1, Math.floor(input.limit)),
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.claimSideEffectDeliveries:query",
            "OrchestrationEventStore.claimSideEffectDeliveries:decodeRows",
          ),
        ),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeEvent(row).pipe(
              Effect.map((event) => ({
                consumer: row.consumer,
                event,
                attemptCount: row.attemptCount,
              })),
              Effect.mapError(
                toPersistenceDecodeError(
                  "OrchestrationEventStore.claimSideEffectDeliveries:rowToEvent",
                ),
              ),
            ),
          ).pipe(
            Effect.map((deliveries) =>
              deliveries.toSorted((left, right) => left.event.sequence - right.event.sequence),
            ),
          ),
        ),
      );

  const completeSideEffectDelivery: OrchestrationEventStoreShape["completeSideEffectDelivery"] = (
    input,
  ) =>
    completeSideEffectDeliveryRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.completeSideEffectDelivery:query",
          "OrchestrationEventStore.completeSideEffectDelivery:encodeRequest",
        ),
      ),
    );

  const failSideEffectDelivery: OrchestrationEventStoreShape["failSideEffectDelivery"] = (input) =>
    failSideEffectDeliveryRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.failSideEffectDelivery:query",
          "OrchestrationEventStore.failSideEffectDelivery:encodeRequest",
        ),
      ),
    );

  const countUnfinishedSideEffectDeliveries: OrchestrationEventStoreShape["countUnfinishedSideEffectDeliveries"] =
    (consumer) =>
      countUnfinishedSideEffectDeliveryRows({ consumer }).pipe(
        Effect.map((row) => row.count),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.countUnfinishedSideEffectDeliveries:query",
            "OrchestrationEventStore.countUnfinishedSideEffectDeliveries:decodeRow",
          ),
        ),
      );

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
    deleteUpToSequenceInclusive,
    recoverSideEffectDeliveries,
    claimSideEffectDeliveries,
    completeSideEffectDelivery,
    failSideEffectDelivery,
    countUnfinishedSideEffectDeliveries,
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
