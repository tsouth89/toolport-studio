import { ThreadId } from "@toolport-studio/contracts";
import { it } from "@effect/vitest";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Data from "effect/Data";
import * as Ref from "effect/Ref";

import { createThreadTolerantOfExisting } from "./bootstrapThreadCreate.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

const threadId = ThreadId.make("30d5e355-761e-4138-b037-126f00971354");

class LookupFailure extends Data.TaggedError("LookupFailure")<{ readonly detail: string }> {}
class DispatchFailure extends Data.TaggedError("DispatchFailure")<{ readonly detail: string }> {}

const alreadyExists = () =>
  new OrchestrationCommandInvariantError({
    commandType: "thread.create",
    detail: `Thread '${threadId}' already exists and cannot be created twice.`,
  });

it.effect("marks the thread as created when the create succeeds", () =>
  Effect.gen(function* () {
    const created = yield* Ref.make(false);

    yield* createThreadTolerantOfExisting({
      threadId,
      create: Effect.succeed({ sequence: 1 }),
      findExistingThread: () => Effect.succeed(Option.none()),
      onCreated: Ref.set(created, true),
    });

    assert.strictEqual(yield* Ref.get(created), true);
  }),
);

it.effect("continues when the thread already exists, without claiming ownership", () =>
  Effect.gen(function* () {
    const created = yield* Ref.make(false);

    // The resend case: the create is rejected, but the thread is really there,
    // so the caller must go on to start the turn.
    yield* createThreadTolerantOfExisting({
      threadId,
      create: Effect.fail(alreadyExists()),
      findExistingThread: () => Effect.succeed(Option.some({ threadId })),
      onCreated: Ref.set(created, true),
    });

    // Ownership matters: the caller deletes the thread it created when the rest
    // of the bootstrap fails, and it must not delete one that was already there.
    assert.strictEqual(yield* Ref.get(created), false);
  }),
);

it.effect("rethrows when the invariant failed but no thread exists", () =>
  Effect.gen(function* () {
    const error = yield* createThreadTolerantOfExisting({
      threadId,
      create: Effect.fail(alreadyExists()),
      findExistingThread: () => Effect.succeed(Option.none()),
      onCreated: Effect.void,
    }).pipe(Effect.flip);

    assert.instanceOf(error, OrchestrationCommandInvariantError);
  }),
);

it.effect("rethrows the original error when the existence lookup fails", () =>
  Effect.gen(function* () {
    const error = yield* createThreadTolerantOfExisting({
      threadId,
      create: Effect.fail(alreadyExists()),
      findExistingThread: () =>
        Effect.fail(new LookupFailure({ detail: "projection unavailable" })),
      onCreated: Effect.void,
    }).pipe(Effect.flip);

    // A failed lookup proves nothing, so the create failure stands.
    assert.instanceOf(error, OrchestrationCommandInvariantError);
  }),
);

it.effect("leaves unrelated create failures alone", () =>
  Effect.gen(function* () {
    let lookups = 0;
    const unrelated = new DispatchFailure({ detail: "dispatch queue closed" });

    const error = yield* createThreadTolerantOfExisting({
      threadId,
      create: Effect.fail(unrelated),
      findExistingThread: () =>
        Effect.sync(() => {
          lookups += 1;
          return Option.some({ threadId });
        }),
      onCreated: Effect.void,
    }).pipe(Effect.flip);

    assert.strictEqual(error, unrelated);
    assert.strictEqual(lookups, 0);
  }),
);
