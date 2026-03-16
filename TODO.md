# Ingest Module – Audit & Implementation TODO

## Summary

The Rust binaries (`ingest-source`, `ingest-dest`, `ingest-sync`) are
fully implemented. The supervisor API, routing logic, and TypeScript server
are all wired up. The following issues were found, roughly ordered by
severity.

**Fixed so far:** #1, #2, #3 (compile error + two runtime bugs — see commit history).

---

## CRITICAL – Deadlock (system appears to start but nothing works)

### 11. `supervision_loop` holds `RwLock<Supervisor>` write-lock forever
**File:** `ingest-supervisor/src/main.rs` lines 46–51

```rust
tokio::spawn(async move {
    if let Err(e) = sup_clone.write().await.supervision_loop().await {
```

`write().await` acquires a `RwLockWriteGuard<Supervisor>`. Because Rust
async futures hold locals across `.await` points, this write guard is
kept alive for the entire lifetime of `supervision_loop()` — which is an
infinite loop that never returns.

Every API handler that needs to manage a worker calls:
```rust
state.supervisor.write().await.start_source(...)
state.supervisor.write().await.stop_worker(...)
```

These all block waiting for the write lock that the supervision loop
permanently holds. **Every start/stop/route-create API call deadlocks
immediately after the supervisor starts.**

**Fix:** Move the worker map (`HashMap<String, WorkerHandle>`) into its
own `Arc<Mutex<HashMap<...>>>` separate from the rest of `Supervisor`.
The supervision loop only needs the worker map; the API handlers only
need the worker map for start/stop. The `RwLock<Supervisor>` can then
be released after the brief config read at startup.

Alternatively: restructure `supervision_loop` to take the lock only
during its 2-second poll tick, not for the entire duration.

---

## CRITICAL – Compile Errors (fixed in previous commit)

### 1. ~~Non-exhaustive match in `handle_crash()`~~ ✅ FIXED

---

## HIGH – Runtime Bugs

### 2. ~~Double-spawn orphan in `start_source()`~~ ✅ FIXED

### 3. ~~`process_pid` never populated~~ ✅ FIXED

### 12. RTMP destination pipeline uses dynamic-pad element statically
**File:** `ingest-dest/src/destinations/rtmp.rs` lines 17–26

The pipeline string:
```
srtsrc ! tsdemux ! queue ! h264parse ! ...
```

`tsdemux` emits pads **dynamically** — its source pads don't exist until
the stream starts. `gst_parse::launch()` requires all pads to be linkable
at parse time. This will fail at runtime with a "pad link failed" or
"no element" error as soon as a stream is connected.

The code comment even says "we use decodebin for automatic codec handling"
but the pipeline uses `tsdemux` — a leftover inconsistency.

**Fix:** Either use `decodebin` (which handles dynamic pad negotiation
internally) or connect `tsdemux`'s `pad-added` signal manually using the
GStreamer Rust bindings rather than a `parse::launch()` string.

### 13. `internal_port` never written back to the DB
**File:** `server/src/api/sources.ts`, migration `003_sources.sql`

The `sources` table has an `internal_port` column ("assigned by supervisor
when active"). When a source is created, the supervisor allocates an
`internal_port` and returns it in the JSON response, but the server never
reads it back and `UPDATE`s the DB row. The column stays `NULL` forever.
Destinations and the UI have no way to know which SRT port a source is
listening on.

**Fix:** After `client(c).createSource(...)`, extract `internal_port`
from the response and update the DB row.

### 4. No supervisor state hydration on startup
**File:** `server/src/index.ts`

When the TypeScript server starts (or after a supervisor restart), the
supervisor has an empty routing table. The server never re-registers
existing sources, destinations, or routes from the DB. Any start/stop
call for a resource the supervisor doesn't know about fails silently
(errors are swallowed in `sources.ts:54–56`, `destinations.ts:50–52`).

**Fix:** After migrations complete, read all non-placeholder sources,
destinations, and routes from Postgres and call
`ingestClient.createSource()` / `createDest()` / `createRoute()` for each.

### 5. Source/dest status never synced back to DB
**Files:** `server/src/jobs/index.ts`

The supervisor tracks `active` / `error` status in memory; the TS server
reads status from Postgres, which is never updated after insert. The UI
always shows stale `idle`.

**Fix:** Add a periodic job (~5–10 s) that calls
`ingestClient.listSources()` + `listDests()` and upserts `status` and
`process_pid` back to the DB.

### 14. `sync_group_ports` table exists but is never used
**File:** `migrations/008_sync_groups.sql`, `server/src/api/sync.ts`

The migration creates a `sync_group_ports` table to persist the
supervisor-assigned aligned ports per sync group member. But `sync.ts`
never reads from or writes to it — it only updates `sync_groups.status`.

After a supervisor restart, the DB shows `status = 'active'` for a sync
group but the supervisor has no record of the aligned ports; the group
cannot be stopped cleanly and destinations are left pointing at ports that
no longer exist.

**Fix:** In the `/:id/start` handler, after a successful supervisor call,
write the aligned port assignments into `sync_group_ports`. In `/:id/stop`,
delete them. On supervisor hydration (fix #4), re-issue `startSyncGroup`
for any group with `status = 'active'` using the ports from this table.

---

## MEDIUM – Feature Gaps

### 6. `rtmp_pull` source type — server allows it, binary rejects it
**Files:** `server/src/api/sources.ts:7`, `ingest-source/src/main.rs:118`

Worker exits immediately: "unknown source_type: rtmp_pull".

**Fix A:** Implement `ingest-source/src/sources/rtmp_pull.rs` with a
`rtmpsrc → mpegtsmux → srtsink` GStreamer pipeline.
**Fix B:** Remove `rtmp_pull` from `VALID_SOURCE_TYPES` until implemented.

### 7. `lgl_ingest` destination type — server allows it, binary rejects it
**Files:** `server/src/api/destinations.ts:7`, `ingest-dest/src/main.rs:93`

Same pattern — worker exits: "unknown dest_type: lgl_ingest".

**Fix A:** Implement `ingest-dest/src/destinations/lgl_ingest.rs`.
**Fix B:** Remove `lgl_ingest` from `VALID_DEST_TYPES` until implemented.

---

## LOW – Polish / Correctness

### 8. Route `enabled` flag ignored during auto-start
**File:** `ingest-supervisor/src/api/mod.rs` line 330

`create_route` auto-starts the dest unconditionally; it should check
`route.enabled` first.

### 9. Sync group crash not reflected in DB
Covered by fix #5 + #14 above.

### 10. Audit log missing for source/dest start & stop
**Files:** `server/src/api/sources.ts:103–131`, `destinations.ts:99–127`

`routing.ts` logs route create/delete; sources and destinations do not
log start/stop. Add `audit_log` inserts to each start/stop handler.

---

## Checklist

- [x] Fix #1 — `WorkerKind::Sync` arm in `handle_crash` match
- [x] Fix #2 — remove orphan first spawn in `start_source`
- [x] Fix #3 — populate `process_pid` after spawn
- [ ] Fix #11 — **DEADLOCK**: restructure supervisor lock so `supervision_loop` doesn't hold write-lock forever
- [ ] Fix #12 — RTMP pipeline: `tsdemux` dynamic pads can't be used in `parse::launch` string
- [ ] Fix #13 — write `internal_port` back to DB after supervisor assigns it
- [ ] Fix #4 — supervisor hydration on server startup
- [ ] Fix #5 — periodic status sync job (supervisor → Postgres)
- [ ] Fix #14 — use `sync_group_ports` table (persist + restore aligned ports)
- [ ] Fix #6 — implement or remove `rtmp_pull` source type
- [ ] Fix #7 — implement or remove `lgl_ingest` dest type
- [ ] Fix #8 — check `enabled` flag before auto-starting dest in `create_route`
- [ ] Fix #10 — audit log entries for source/dest start & stop
