import { EventId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function makeActivityRow(input: {
  readonly activityId: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly createdAt: string;
}) {
  return {
    activityId: EventId.make(input.activityId),
    threadId: ThreadId.make(input.threadId),
    turnId: TurnId.make("turn-1"),
    tone: "info" as const,
    kind: "tool.completed",
    summary: `activity ${input.sequence}`,
    payload: { sequence: input.sequence },
    sequence: input.sequence,
    createdAt: input.createdAt,
  };
}

layer("ProjectionThreadActivityRepository retention", (it) => {
  it.effect("prunes oldest activities for a single thread while keeping newest", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-activity-prune");

      for (let sequence = 1; sequence <= 5; sequence += 1) {
        yield* repository.upsert(
          makeActivityRow({
            activityId: `activity-${sequence}`,
            threadId: threadId,
            sequence,
            createdAt: `2026-03-01T00:00:0${sequence}.000Z`,
          }),
        );
      }

      yield* repository.pruneKeepLastByThreadId({
        threadId,
        keepLast: 2,
      });

      const remaining = yield* repository.listByThreadId({ threadId });
      assert.deepStrictEqual(
        remaining.map((row) => row.activityId),
        [EventId.make("activity-4"), EventId.make("activity-5")],
      );
    }),
  );

  it.effect("prunes activities independently per thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadA = ThreadId.make("thread-a-prune");
      const threadB = ThreadId.make("thread-b-prune");

      for (const threadId of [threadA, threadB]) {
        for (let sequence = 1; sequence <= 4; sequence += 1) {
          yield* repository.upsert(
            makeActivityRow({
              activityId: `${threadId}-activity-${sequence}`,
              threadId,
              sequence,
              createdAt: `2026-03-01T00:00:0${sequence}.000Z`,
            }),
          );
        }
      }

      yield* repository.pruneAllThreadsKeepLast({ keepLast: 2 });

      const remainingA = yield* repository.listByThreadId({ threadId: threadA });
      const remainingB = yield* repository.listByThreadId({ threadId: threadB });
      assert.equal(remainingA.length, 2);
      assert.equal(remainingB.length, 2);
      assert.deepStrictEqual(
        remainingA.map((row) => row.activityId),
        [EventId.make("thread-a-prune-activity-3"), EventId.make("thread-a-prune-activity-4")],
      );
      assert.deepStrictEqual(
        remainingB.map((row) => row.activityId),
        [EventId.make("thread-b-prune-activity-3"), EventId.make("thread-b-prune-activity-4")],
      );
    }),
  );

  it.effect("is a no-op when the thread is already within the keep window", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const threadId = ThreadId.make("thread-activity-noop");

      yield* repository.upsert(
        makeActivityRow({
          activityId: "activity-keep-1",
          threadId,
          sequence: 1,
          createdAt: "2026-03-01T00:00:01.000Z",
        }),
      );
      yield* repository.upsert(
        makeActivityRow({
          activityId: "activity-keep-2",
          threadId,
          sequence: 2,
          createdAt: "2026-03-01T00:00:02.000Z",
        }),
      );

      yield* repository.pruneKeepLastByThreadId({
        threadId,
        keepLast: 10,
      });

      const remaining = yield* repository.listByThreadId({ threadId });
      assert.equal(remaining.length, 2);
    }),
  );
});
