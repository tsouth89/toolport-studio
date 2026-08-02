import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { makeKeyedSerialWorker } from "./KeyedSerialWorker.ts";

describe("makeKeyedSerialWorker", () => {
  it.effect("runs different keys concurrently while preserving same-key order", () =>
    Effect.gen(function* () {
      const releaseA = yield* Deferred.make<void>();
      const startedA = yield* Deferred.make<void>();
      const completed: string[] = [];
      const worker = yield* makeKeyedSerialWorker<string, string, never>({
        process: (key, item) =>
          Effect.gen(function* () {
            if (item === "a1") {
              yield* Deferred.succeed(startedA, undefined);
              yield* Deferred.await(releaseA);
            }
            completed.push(`${key}:${item}`);
          }),
      });

      yield* worker.enqueue("a", "a1");
      yield* worker.enqueue("a", "a2");
      yield* worker.enqueue("b", "b1");
      yield* Deferred.await(startedA);

      yield* Effect.yieldNow;
      expect(completed).toEqual(["b:b1"]);

      yield* Deferred.succeed(releaseA, undefined);
      yield* worker.drain;
      expect(completed).toEqual(["b:b1", "a:a1", "a:a2"]);
    }),
  );

  it.effect("retires an idle lane after its bounded lifetime", () =>
    Effect.gen(function* () {
      const worker = yield* makeKeyedSerialWorker<string, string, never>({
        idleTimeToLive: Duration.seconds(5),
        process: () => Effect.void,
      });

      yield* worker.enqueue("thread-1", "work");
      yield* worker.drain;
      expect(yield* worker.activeLaneCount).toBe(1);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Effect.yieldNow;

      expect(yield* worker.activeLaneCount).toBe(0);
    }),
  );
});
