# Measuring Studio host tax

Use this when dogfooding "Studio feels slower than the official CLI."

## Split the bill

| Question                                                 | If yes                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Is the same prompt slow in the official CLI?             | Model / agent loop - not Studio                                                          |
| Is CLI fast but Studio drips / lags?                     | **Host tax** (logs, SQLite, UI)                                                          |
| Is Toolport gateway running when Settings has tools off? | Injection bug (SOU-402)                                                                  |
| Is `state.sqlite` huge after light use?                  | Activity/event bloat (SOU-400); restart once so bootstrap retention can prune older rows |

## Where to look

| Path                                                       | Contents                               |
| ---------------------------------------------------------- | -------------------------------------- |
| `~/.toolport-studio/userdata/logs/provider/<threadId>.log` | Native + canonical provider events     |
| `~/.toolport-studio/userdata/state.sqlite`                 | Orchestration events + tool activities |
| `~/.toolport-studio/userdata/logs/server.trace.ndjson`     | Effect span traces (very chatty)       |

## Quick checks

1. Run the fixed prompt pack in [provider-parity-scorecard.md](../product/provider-parity-scorecard.md).
2. Note wall time Studio vs CLI for Hello + Read only.
3. If Studio is much slower on Hello, inspect provider log line rate during stream.
4. Prefer lifecycle rows (turn start/stop, tool start/complete) over per-token native lines after SOU-400 slim policies.

## Soft budgets

See the host-tax section in the parity scorecard. Adjust with real dogfood evidence; do not treat them as hard product SLAs yet.

## SQLite retention (SOU-400)

On projection bootstrap (server start) and after each projected activity append:

- `projection_thread_activities` keeps the newest **500** rows per thread (same window as the live projector).
- Fully applied `orchestration_events` at or below `min(projection_state.last_applied_sequence) - 100` are deleted when every projector has a cursor.

New tool activity payloads are also truncated on ingest (`sanitizeToolActivityDataValue`). Existing bloated rows fall off as they leave the 500-row window. Full `VACUUM` is not run automatically; freelist space is reused by SQLite.
