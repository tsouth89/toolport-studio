/**
 * ProjectionThreadActivityRepository - Projection repository interface for thread activity.
 *
 * Owns persistence operations for activity timeline entries projected from
 * orchestration events.
 *
 * @module ProjectionThreadActivityRepository
 */
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadActivityTone,
  ThreadId,
  TurnId,
} from "@toolport-studio/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadActivity = Schema.Struct({
  activityId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  tone: OrchestrationThreadActivityTone,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;

export const ListProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadActivitiesInput = typeof ListProjectionThreadActivitiesInput.Type;

export const DeleteProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadActivitiesInput =
  typeof DeleteProjectionThreadActivitiesInput.Type;

export const PruneProjectionThreadActivitiesKeepLastInput = Schema.Struct({
  threadId: ThreadId,
  keepLast: NonNegativeInt,
});
export type PruneProjectionThreadActivitiesKeepLastInput =
  typeof PruneProjectionThreadActivitiesKeepLastInput.Type;

export const PruneAllProjectionThreadActivitiesKeepLastInput = Schema.Struct({
  keepLast: NonNegativeInt,
});
export type PruneAllProjectionThreadActivitiesKeepLastInput =
  typeof PruneAllProjectionThreadActivitiesKeepLastInput.Type;

/**
 * ProjectionThreadActivityRepositoryShape - Service API for projected thread activity.
 */
export interface ProjectionThreadActivityRepositoryShape {
  /**
   * Insert or replace a projected thread activity row.
   *
   * Upserts by `activityId` and JSON-encodes payload.
   */
  readonly upsert: (
    row: ProjectionThreadActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread activity rows for a thread.
   *
   * Returned in ascending runtime sequence order (or creation order when
   * sequence is unavailable).
   */
  readonly listByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * Delete projected thread activity rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Keep only the newest `keepLast` activity rows for a single thread.
   *
   * Ordering matches the live projector (sequence, then createdAt, then id).
   * Older rows are hard-deleted to bound SQLite growth (SOU-400).
   */
  readonly pruneKeepLastByThreadId: (
    input: PruneProjectionThreadActivitiesKeepLastInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Apply {@link pruneKeepLastByThreadId} across every thread that has
   * activities. Used on projection bootstrap / startup maintenance.
   */
  readonly pruneAllThreadsKeepLast: (
    input: PruneAllProjectionThreadActivitiesKeepLastInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadActivityRepository - Service tag for thread activity persistence.
 */
export class ProjectionThreadActivityRepository extends Context.Service<
  ProjectionThreadActivityRepository,
  ProjectionThreadActivityRepositoryShape
>()("t3/persistence/Services/ProjectionThreadActivities/ProjectionThreadActivityRepository") {}
