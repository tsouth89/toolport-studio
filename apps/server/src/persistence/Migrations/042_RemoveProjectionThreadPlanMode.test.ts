import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("042 resets persisted plan mode before projection rows are decoded", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 41 });

    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, sidebar_group_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        created_at, updated_at, archived_at, settled_override, settled_at,
        snoozed_until, snoozed_at, latest_user_message_at, pending_approval_count,
        pending_user_input_count, has_actionable_proposed_plan, deleted_at
      )
      VALUES (
        'thread-plan', NULL, NULL, 'Legacy plan thread',
        '{"provider":"codex","model":"gpt-5-codex"}',
        'full-access', 'plan', NULL, NULL, NULL,
        '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL, NULL, NULL,
        NULL, NULL, NULL, 0, 0, 0, NULL
      )
    `;

    yield* runMigrations({ toMigrationInclusive: 42 });

    const [row] = yield* sql<{ readonly interactionMode: string }>`
      SELECT interaction_mode AS "interactionMode"
      FROM projection_threads
      WHERE thread_id = 'thread-plan'
    `;
    assert.strictEqual(row?.interactionMode, "default");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
