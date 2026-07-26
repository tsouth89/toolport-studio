/**
 * SQLite retention limits for projected read-model rows and the orchestration
 * event log (SOU-400 host tax).
 *
 * In-memory projection already caps thread activities at 500, but the SQLite
 * tables historically kept every row forever. These limits keep disk + snapshot
 * load aligned with the live projector window.
 */
export const MAX_PROJECTED_THREAD_ACTIVITIES = 500;

/**
 * Fully-applied orchestration events at or below
 * `min(projection_state.last_applied_sequence)` can be deleted without
 * breaking bootstrap. Keep a small cushion so concurrent projector lag cannot
 * drop the next event a slow projector still needs.
 */
export const ORCHESTRATION_EVENT_RETENTION_SEQUENCE_CUSHION = 100;
