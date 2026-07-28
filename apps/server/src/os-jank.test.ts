import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { migrateLegacyBaseDir } from "./os-jank.ts";

const withTempHome = <A, E>(
  use: (home: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "toolport-studio-home-" });
    return yield* use(home);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("moves the legacy home directory and keeps its contents", () =>
  withTempHome((home) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const legacy = path.join(home, ".t3");
      yield* fs.makeDirectory(path.join(legacy, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(legacy, "userdata", "state.sqlite"), "session-history");

      assert.isTrue(yield* migrateLegacyBaseDir(home));

      const migrated = path.join(home, ".toolport-studio");
      assert.isTrue(yield* fs.exists(migrated));
      assert.isFalse(yield* fs.exists(legacy));
      assert.strictEqual(
        yield* fs.readFileString(path.join(migrated, "userdata", "state.sqlite")),
        "session-history",
      );
    }),
  ),
);

it.effect("does nothing on a fresh install", () =>
  withTempHome((home) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      assert.isFalse(yield* migrateLegacyBaseDir(home));
      assert.isFalse(yield* fs.exists(path.join(home, ".toolport-studio")));
    }),
  ),
);

it.effect("leaves an already-migrated home alone, and never clobbers it", () =>
  withTempHome((home) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const legacy = path.join(home, ".t3");
      const current = path.join(home, ".toolport-studio");
      // Both present: a stale legacy directory must not overwrite live data.
      yield* fs.makeDirectory(legacy, { recursive: true });
      yield* fs.writeFileString(path.join(legacy, "marker"), "stale");
      yield* fs.makeDirectory(current, { recursive: true });
      yield* fs.writeFileString(path.join(current, "marker"), "live");

      assert.isFalse(yield* migrateLegacyBaseDir(home));

      assert.strictEqual(yield* fs.readFileString(path.join(current, "marker")), "live");
      assert.isTrue(yield* fs.exists(legacy));
    }),
  ),
);
