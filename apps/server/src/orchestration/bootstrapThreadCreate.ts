/**
 * Tolerance for a bootstrap `thread.create` whose thread already exists.
 *
 * @module bootstrapThreadCreate
 */
import type { ThreadId } from "@toolport-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Schema from "effect/Schema";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

/**
 * Schema-aware check rather than `instanceof`: these errors cross the dispatch
 * boundary, so identity is not guaranteed, and a bare `_tag` comparison would
 * match any object carrying the same tag.
 */
const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

/**
 * Run a bootstrap `thread.create`, treating an already-created thread as
 * satisfied rather than as a failure.
 *
 * A draft only leaves the composer once its thread has started, so a send into
 * a thread that was already created — a resend while the provider is still
 * silent, or a retry after a dropped response — arrives carrying the same
 * bootstrap. Failing that create aborted the whole bootstrap program, so the
 * turn never started and the user was returned to the composer with the thread
 * stranded server-side.
 *
 * The invariant error alone is not enough to conclude the thread exists: it is
 * also raised for unrelated violations on the same command. So the existing
 * thread is confirmed by lookup, and anything else is rethrown untouched.
 *
 * `onCreated` runs only when this call actually created the thread, which is
 * what lets the caller's compensating delete distinguish a thread it owns from
 * one that was already there.
 */
export const createThreadTolerantOfExisting = <ECreate, EFind, R>(input: {
  readonly threadId: ThreadId;
  readonly create: Effect.Effect<unknown, ECreate, R>;
  readonly findExistingThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<unknown>, EFind, R>;
  readonly onCreated: Effect.Effect<void, never, R>;
}): Effect.Effect<void, ECreate, R> =>
  input.create.pipe(
    Effect.flatMap(() => input.onCreated),
    Effect.catchIf(
      (error): error is ECreate & OrchestrationCommandInvariantError => isInvariantError(error),
      (invariantError) =>
        input.findExistingThread(input.threadId).pipe(
          Effect.matchEffect({
            // A failed lookup proves nothing, so surface the original error
            // rather than pretending the thread is there.
            onFailure: () => Effect.fail(invariantError as ECreate),
            onSuccess: (existingThread) =>
              Option.isSome(existingThread) ? Effect.void : Effect.fail(invariantError as ECreate),
          }),
        ),
    ),
  );
