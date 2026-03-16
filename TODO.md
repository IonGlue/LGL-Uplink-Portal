# Ingest Module – Audit & Implementation TODO

## Summary

The Rust binaries (`ingest-source`, `ingest-dest`, `ingest-sync`) are
fully implemented. The supervisor API, routing logic, and TypeScript server
are all wired up. **However**, several concrete bugs prevent the system from
actually running end-to-end.

---

## CRITICAL – Compile Errors (code won't build)

### 1. Non-exhaustive match in `handle_crash()` — compile error
**File:** `ingest-supervisor/src/supervisor.rs` lines 253–266

The `match kind` block handles `WorkerKind::Source` and `WorkerKind::Dest`
but not `WorkerKind::Sync`. Rust requires exhaustive matches — this is a
compile error that prevents the supervisor binary from building at all.

**Fix:** Add a `WorkerKind::Sync => {}` arm (sync groups have no separate
status field to update here; the group status is already handled in the
restart branch below).

---

## HIGH – Runtime Bugs (code compiles but misbehaves)

### 2. Double-spawn orphan in `start_source()`
**File:** `ingest-supervisor/src/supervisor.rs` lines 69–85

`start_source()` calls `Command::new(...).spawn()` **twice**:
- Line 69–73: spawns with piped stdin, result stored in `child` — **immediately shadowed**
- Line 81–85: spawns again with config file arg, result stored in second `child`

The first spawned process is an orphan — it runs forever, consuming the
`ingest-source` binary path with no config. Every `start_source()` call
leaks one extra process.

**Fix:** Delete the dead first spawn (lines 69–73). Only the second spawn
(lines 81–85) is correct.

### 3. `process_pid` is never populated
**Files:** `ingest-supervisor/src/supervisor.rs` (both `start_source` and
`start_dest`)

`SourceSlot.process_pid` and `DestSlot.process_pid` are always `None`.
After spawning, `child.id()` should be written into the slot so the UI
can surface the OS PID. Currently the field is permanently `null` in every
API response.

**Fix:** After `spawn()` succeeds, call `child.id()` and write it into
`routing.sources[id].process_pid` (or `.dests[id].process_pid`).

### 4. No supervisor state hydration on startup
**File:** `server/src/index.ts` / `server/src/jobs/index.ts`

When the TypeScript server starts (or after a supervisor restart), the
supervisor has an empty routing table. The server never re-registers
existing sources, destinations, or routes from the DB into the supervisor.
Any attempt to start a source or dest that the supervisor doesn't know
about will fail silently (the server swallows the error on line 54–56 of
`sources.ts`).

**Fix:** Add a startup routine that reads all non-placeholder
sources/dests/routes from Postgres and calls `ingestClient.createSource()`,
`ingestClient.createDest()`, `ingestClient.createRoute()` for each, after
the DB migrations complete.

### 5. Source/dest status never synced back to DB
**Files:** `server/src/api/sources.ts`, `server/src/api/destinations.ts`,
`server/src/jobs/index.ts`

The supervisor updates source/dest status in its in-memory routing table
(`Active`, `Error`, etc.) but the TypeScript server always reads status
from Postgres — which never gets updated. The UI will always show stale
status (the value set at DB insert time, typically `idle`).

**Fix:** Add a periodic job (e.g. every 5–10 s) that calls
`ingestClient.listSources()` + `ingestClient.listDests()` and upserts the
`status` and `process_pid` columns back into Postgres. Alternatively, add
a webhook/callback from the supervisor to the server on status change.

---

## MEDIUM – Feature Gaps (declared but not implemented)

### 6. `rtmp_pull` source type — server allows it, binary ignores it
**Files:**
- `server/src/api/sources.ts` line 7: `'rtmp_pull'` in `VALID_SOURCE_TYPES`
- `ingest-source/src/main.rs` line 118: `other => bail!("unknown source_type: {other}")`

Creating an `rtmp_pull` source registers it in the DB and supervisor, but
starting it makes the worker exit immediately with "unknown source_type:
rtmp_pull". No GStreamer pipeline exists for this type.

**Fix (option A):** Implement `ingest-source/src/sources/rtmp_pull.rs`
using a GStreamer `rtspsrc`/`rtmpsrc → mpegtsmux → srtsink` pipeline.

**Fix (option B):** Remove `rtmp_pull` from `VALID_SOURCE_TYPES` until
it is implemented.

### 7. `lgl_ingest` destination type — server allows it, binary ignores it
**Files:**
- `server/src/api/destinations.ts` line 7: `'lgl_ingest'` in `VALID_DEST_TYPES`
- `ingest-dest/src/main.rs`: no handler for `lgl_ingest`

Same pattern as above — the dest worker exits immediately.

**Fix (option A):** Implement `ingest-dest/src/destinations/lgl_ingest.rs`
as an SRT→SRT passthrough that re-ingests into another LGL Ingest instance.

**Fix (option B):** Remove `lgl_ingest` from `VALID_DEST_TYPES` until
it is implemented.

---

## LOW – Polish / Correctness

### 8. Route `enabled` flag is ignored by supervisor
**File:** `ingest-supervisor/src/routing.rs` lines 160–166

`dests_for_source()` correctly filters by `r.enabled`. However, the
auto-start logic in `create_route` (api/mod.rs line 330) does not check
the `enabled` field before auto-starting the destination — it starts the
dest unconditionally if a port is available. A route that was manually
disabled before deletion could inadvertently start a destination.

**Fix:** Check `route.enabled` in `create_route` before calling `start_dest`.

### 9. Supervisor crash status for `WorkerKind::Sync` not reflected in DB
**File:** `ingest-supervisor/src/supervisor.rs` `handle_crash()` (after fix #1)

When a sync worker exceeds max restarts, `handle_crash()` marks
`handle.error = true` but there is no code path that propagates
`SyncGroupStatus::Error` back to the DB via the TS server.

**Fix:** Once the status sync job from #5 is in place, extend it to also
sync sync-group status.

### 10. Audit log missing for source/dest start & stop
**File:** `server/src/api/sources.ts` lines 103–131, `destinations.ts`
lines 99–127

`routing.ts` writes audit log entries for route create/delete. But
`sources.ts` and `destinations.ts` do not log start/stop actions. This
leaves gaps in the `audit_log` table for the most operationally important
events.

**Fix:** Insert an `audit_log` row in each `/:id/start` and `/:id/stop`
handler for sources and destinations.

---

## Checklist

- [ ] Fix #1 — add `WorkerKind::Sync` arm to `handle_crash` match
- [ ] Fix #2 — remove orphan first spawn in `start_source`
- [ ] Fix #3 — populate `process_pid` after spawn
- [ ] Fix #4 — add supervisor hydration on server startup
- [ ] Fix #5 — add periodic status sync job (supervisor → Postgres)
- [ ] Fix #6 — implement or remove `rtmp_pull` source type
- [ ] Fix #7 — implement or remove `lgl_ingest` dest type
- [ ] Fix #8 — check `enabled` flag before auto-starting dest in `create_route`
- [ ] Fix #9 — extend status sync to cover sync-group error state
- [ ] Fix #10 — add audit log entries for source/dest start & stop
