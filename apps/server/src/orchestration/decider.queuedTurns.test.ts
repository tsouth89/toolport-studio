import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@toolport-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-07-31T12:00:00.000Z";
const projectId = ProjectId.make("project-queued-turn");
const threadId = ThreadId.make("thread-queued-turn");
const messageId = MessageId.make("message-queued-turn");

const baseEvent = {
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: now,
  commandId: CommandId.make("seed"),
  causationEventId: null,
  correlationId: CommandId.make("seed"),
  metadata: {},
};

const makeReadModel = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    ...baseEvent,
    sequence: 1,
    eventId: EventId.make("project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    payload: {
      projectId,
      title: "Queued turns",
      workspaceRoot: "C:\\queued-turns",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    ...baseEvent,
    sequence: 2,
    eventId: EventId.make("thread-created"),
    type: "thread.created",
    payload: {
      threadId,
      projectId,
      title: "Queued turns",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("queued turn decider", (it) => {
  it.effect("persists a queued turn and flushes it as one atomic event sequence", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel;
      const queued = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.queue",
          commandId: CommandId.make("queue-command"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "Run after the active turn",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      });
      const queuedEvent = (Array.isArray(queued) ? queued[0] : queued) as Omit<
        OrchestrationEvent,
        "sequence"
      >;
      expect(queuedEvent.type).toBe("thread.turn-queued");

      const withQueue = yield* projectEvent(readModel, {
        ...queuedEvent,
        sequence: 3,
      } as OrchestrationEvent);
      expect(withQueue.threads[0]?.queuedTurns?.map((turn) => turn.message.messageId)).toEqual([
        messageId,
      ]);

      const flushed = yield* decideOrchestrationCommand({
        readModel: withQueue,
        command: {
          type: "thread.turn.queue.flush",
          commandId: CommandId.make("server:queued-turn:message-queued-turn"),
          threadId,
          messageId,
          createdAt: "2026-07-31T12:01:00.000Z",
        },
      });
      expect(Array.isArray(flushed)).toBe(true);
      expect((flushed as ReadonlyArray<{ type: string }>).map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
        "thread.turn-queue-discarded",
      ]);

      let projected = withQueue;
      for (const [index, event] of (
        flushed as ReadonlyArray<Omit<OrchestrationEvent, "sequence">>
      ).entries()) {
        projected = yield* projectEvent(projected, {
          ...event,
          sequence: 4 + index,
        } as OrchestrationEvent);
      }
      expect(projected.threads[0]?.queuedTurns).toEqual([]);
      expect(projected.threads[0]?.messages.map((message) => message.id)).toEqual([messageId]);
    }),
  );

  it.effect("stamps the flushed message at flush time, not at queue time", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel;
      const queued = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.turn.queue",
          commandId: CommandId.make("queue-command"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "Run after the active turn",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
      });
      const queuedEvent = (Array.isArray(queued) ? queued[0] : queued) as Omit<
        OrchestrationEvent,
        "sequence"
      >;
      const withQueue = yield* projectEvent(readModel, {
        ...queuedEvent,
        sequence: 3,
      } as OrchestrationEvent);

      // The user typed this at `now`, while the previous turn was still
      // running. Anything the previous turn said afterwards carries a later
      // timestamp, and messages render `ORDER BY created_at ASC`.
      const flushedAt = "2026-07-31T12:05:00.000Z";
      const flushed = (yield* decideOrchestrationCommand({
        readModel: withQueue,
        command: {
          type: "thread.turn.queue.flush",
          commandId: CommandId.make("server:queued-turn:message-queued-turn"),
          threadId,
          messageId,
          createdAt: flushedAt,
        },
      })) as ReadonlyArray<Omit<OrchestrationEvent, "sequence">>;

      const messageEvent = flushed.find((event) => event.type === "thread.message-sent");
      expect(messageEvent?.occurredAt).toBe(flushedAt);
      const payload = messageEvent?.payload as {
        readonly createdAt: string;
        readonly updatedAt: string;
      };
      expect(payload.createdAt).toBe(flushedAt);
      expect(payload.updatedAt).toBe(flushedAt);
      // Queue time must not leak back in: at `now` this message would sort
      // above the previous turn's response.
      expect(payload.createdAt).not.toBe(now);
    }),
  );
});
