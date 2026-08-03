import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration040 from "./040_ProjectionThreadsNullableProjectId.ts";

// Each case needs its own database: the rebuild is only observable against the
// pre-migration schema, so a shared connection would let the first case migrate
// the table out from under the rest.
const withFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const seedThroughMigration39 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 39 });

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at, deleted_at
    )
    VALUES (
      'project-1', 'Project 1', '/tmp/project-1', NULL, '[]',
      '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, sidebar_group_id, title, model_selection_json,
      runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
      created_at, updated_at, archived_at, settled_override, settled_at,
      snoozed_until, snoozed_at, latest_user_message_at, pending_approval_count,
      pending_user_input_count, has_actionable_proposed_plan, deleted_at
    )
    VALUES (
      'thread-1', 'project-1', 'project-1', 'Thread 1',
      '{"provider":"codex","model":"gpt-5-codex"}',
      'full-access', 'default', 'main', '/tmp/worktree', 'turn-1',
      '2026-05-01T00:00:01.000Z', '2026-05-01T00:00:02.000Z', NULL, 'settled',
      '2026-05-01T00:00:03.000Z', NULL, NULL, '2026-05-01T00:00:04.000Z', 2, 1, 1, NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_queued_turns (thread_id, message_id, queued_turn_json, created_at)
    VALUES ('thread-1', 'message-1', '{"queued":true}', '2026-05-01T00:00:05.000Z')
  `;
});

it.effect("040 drops NOT NULL from project_id while preserving every column value", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThroughMigration39;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
      }>`PRAGMA table_info(projection_threads)`;
      assert.strictEqual(columns.find((column) => column.name === "project_id")?.notnull, 0);
      // Other columns keep their constraints.
      assert.strictEqual(columns.find((column) => column.name === "title")?.notnull, 1);

      const rows = yield* sql<Record<string, unknown>>`
        SELECT * FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected the migrated thread row to survive.");
      }
      assert.strictEqual(row.project_id, "project-1");
      assert.strictEqual(row.sidebar_group_id, "project-1");
      assert.strictEqual(row.title, "Thread 1");
      assert.strictEqual(row.branch, "main");
      assert.strictEqual(row.worktree_path, "/tmp/worktree");
      assert.strictEqual(row.latest_turn_id, "turn-1");
      assert.strictEqual(row.settled_override, "settled");
      assert.strictEqual(row.settled_at, "2026-05-01T00:00:03.000Z");
      assert.strictEqual(row.latest_user_message_at, "2026-05-01T00:00:04.000Z");
      assert.strictEqual(row.pending_approval_count, 2);
      assert.strictEqual(row.pending_user_input_count, 1);
      assert.strictEqual(row.has_actionable_proposed_plan, 1);
    }),
  ),
);

// DROP TABLE fires ON DELETE CASCADE with foreign_keys=ON, and migrations run
// inside a transaction where that pragma cannot be toggled off. Pending turns
// are real user work, so losing them here would be silent data loss.
it.effect("040 keeps queued turns that cascade off the dropped table", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThroughMigration39;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const queued = yield* sql<{
        readonly thread_id: string;
        readonly message_id: string;
        readonly queued_turn_json: string;
      }>`SELECT * FROM projection_thread_queued_turns`;
      assert.strictEqual(queued.length, 1);
      assert.strictEqual(queued[0]?.thread_id, "thread-1");
      assert.strictEqual(queued[0]?.message_id, "message-1");
      assert.strictEqual(queued[0]?.queued_turn_json, '{"queued":true}');
    }),
  ),
);

it.effect("040 accepts a projectless thread row afterwards", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThroughMigration39;
      yield* runMigrations({ toMigrationInclusive: 40 });

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, sidebar_group_id, title, model_selection_json,
          runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
          created_at, updated_at, archived_at, latest_user_message_at,
          pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, deleted_at
        )
        VALUES (
          'thread-projectless', NULL, NULL, 'Projectless',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access', 'default', NULL, NULL, NULL,
          '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z', NULL, NULL, 0, 0, 0, NULL
        )
      `;

      const rows = yield* sql<{ readonly project_id: string | null }>`
        SELECT project_id FROM projection_threads WHERE thread_id = 'thread-projectless'
      `;
      assert.strictEqual(rows[0]?.project_id, null);
    }),
  ),
);

it.effect("040 restores every index on the rebuilt table", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThroughMigration39;

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_threads' AND sql IS NOT NULL
      `;
      yield* runMigrations({ toMigrationInclusive: 40 });
      const after = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_threads' AND sql IS NOT NULL
      `;

      assert.isAbove(before.length, 0);
      assert.deepStrictEqual(
        after.map((index) => index.name).toSorted(),
        before.map((index) => index.name).toSorted(),
      );
    }),
  ),
);

it.effect("040 is a no-op when re-run against an already nullable column", () =>
  withFreshDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThroughMigration39;
      yield* runMigrations({ toMigrationInclusive: 40 });
      // Re-running the migration body must not rebuild or drop anything.
      yield* migration040;

      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_threads
      `;
      assert.strictEqual(rows[0]?.count, 1);
      const queued = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_thread_queued_turns
      `;
      assert.strictEqual(queued[0]?.count, 1);
    }),
  ),
);
