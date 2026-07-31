import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface QueuedTurnReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly shutdown: Effect.Effect<void>;
}

export class QueuedTurnReactor extends Context.Service<QueuedTurnReactor, QueuedTurnReactorShape>()(
  "t3/orchestration/Services/QueuedTurnReactor",
) {}
