/**
 * On-demand fetch of an API-key provider's browsable model catalog.
 *
 * Most server state in this app is pushed: the client subscribes and the
 * server publishes. A catalog is the wrong shape for that — it is hundreds of
 * rows per instance, it changes rarely, and almost no session ever opens it.
 * Pushing it would put a few hundred kilobytes into every snapshot to serve a
 * settings screen nobody has opened. So this is a request, made when the user
 * actually asks to browse.
 *
 * @module byokCatalog
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  ByokCatalogListResult,
  EnvironmentId,
  ProviderInstanceId,
} from "@toolport-studio/contracts";
import { WS_METHODS } from "@toolport-studio/contracts";
import { EnvironmentRegistry } from "@toolport-studio/client-runtime/connection";
import { request } from "@toolport-studio/client-runtime/rpc";

export class ByokCatalogError extends Data.TaggedError("ByokCatalogError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface FetchByokCatalogInput {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

export function fetchByokCatalog(
  input: FetchByokCatalogInput,
): Effect.Effect<ByokCatalogListResult, ByokCatalogError, EnvironmentRegistry> {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    return yield* registry
      .run(
        input.environmentId,
        request(WS_METHODS.serverListByokCatalog, { instanceId: input.instanceId }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ByokCatalogError({
              message: "Could not load the model catalog for this provider.",
              cause,
            }),
        ),
      );
  });
}
