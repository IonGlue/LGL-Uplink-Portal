# Virtual Rack

The Virtual Rack is a structured, list-based view of all sources and destinations — analogous to a physical broadcast patchbay panel or a rack-mounted router.

It complements the free-form [Patchbay](../README.md) canvas, and is accessible from the top navigation bar: **Patchbay** | **Virtual Rack**.

---

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  LGL Ingest  [Patchbay]  [Virtual Rack]                          │
├────────────────────────────┬────────────────────────────────────┤
│  SOURCES          [+ Add]  │  DESTINATIONS             [+ Add]  │
│  ─────────────────────     │  ─────────────────────────────     │
│  01  ● 📡  Camera-A        │  01  ● 📺  YouTube RTMP           │
│            encoder · idle  │            rtmp · idle             │
│            unrouted        │            ← Camera-A              │
│                            │                                    │
│  02  ● 🎨  SMPTE Test     │  02  ● 💾  Recorder-01            │
│            test pattern    │            recorder · active       │
│            → Recorder-01   │            ← SMPTE Test            │
│                            │                                    │
│  03  👻  Placeholder       │  03  👻  Placeholder               │
│   (dashed border)          │   (dashed border)                  │
└────────────────────────────┴────────────────────────────────────┘
```

### Slot numbering

Slots are numbered sequentially from 01 in creation order. The number on the left matches what you'd see on a physical rack label.

### Status dot

| Color | Meaning |
|-------|---------|
| Green | Active — stream is flowing |
| Yellow | Waiting — process started, no signal yet |
| Red | Error — process crashed (check logs) |
| Grey | Idle — process not started |
| Dark | Placeholder — no process, pre-routed slot |

### Route badges

Each slot shows its current routes as small colored pills:
- **Source slots** show outbound routes: `→ YouTube RTMP`
- **Destination slots** show inbound routes: `← Camera-A`

A slot with no routes shows `unrouted` in muted text (placeholders are silent).

---

## Placeholder slots

Placeholders are named slots with no running process. Use them to pre-configure a complete routing plan before hardware arrives.

**Typical workflow:**
1. Create a placeholder source: `Camera-A` (source_type: placeholder)
2. Create a placeholder destination: `YouTube-Live` (dest_type: placeholder)
3. Wire them together in the Patchbay canvas (the route is saved)
4. When the encoder hardware arrives, assign its device_id to `Camera-A` and change its type to `encoder`
5. Change `YouTube-Live` to `rtmp` and fill in the stream key
6. The route is already in place — just start both workers

---

## Encoder sources and device assignment

When creating an **encoder** source, you can optionally bind it to a specific enrolled device:

- **Unlinked** (default): Any encoder whose SRTLA registration arrives at this source's port will be accepted. Useful for hot-swap scenarios.
- **Linked to a device**: Only the named device is accepted. Other encoders are rejected at the SRTLA relay layer.

The device picker shows all currently enrolled devices with their live status (`●` online, `○` offline). Devices appear here after they:
1. Connect to the WebSocket endpoint (`/ws/device`)
2. Get **enrolled** by an operator or admin (`POST /api/devices/:id/enroll` → `action: approve`)

If no enrolled devices appear, the encoder hasn't connected yet or hasn't been enrolled.

---

## Encoder adoption flow (orchestrate-core → LGL-Ingest)

When an encoder is managed via **orchestrate-core** (the multi-tenant control plane), the adoption flow is:

```
1. Encoder powers on → self-registers at orchestrate-core
   POST /api/encoders/webhook/register  { adoption_code: "A1B2C3D4E5" }

2. Admin adopts encoder in orchestrate-core
   POST /api/encoders/adopt  { code: "A1B2C3D4E5", name: "Studio Cam 1" }

3. Admin assigns encoder to tenant
   POST /api/encoders/:id/assign  { tenant_id: "...", product: "ingest" }

4. Encoder connects to the tenant's LGL-Ingest WebSocket
   ws://ingest.<tenant>.lgl-os.com/ws/device

5. Device appears in LGL-Ingest's device list
   GET /api/devices  →  [{ device_id: "...", enrollment_state: "pending" }]

6. Operator enrolls device
   POST /api/devices/:id/enroll  { action: "approve" }

7. Device is now available in the encoder source picker
   "Add Source" → type: Encoder → Device dropdown shows the enrolled device
```

The `encoder_assignments` table in orchestrate-core and the `devices` table in LGL-Ingest are the two ends of this pipeline. The assignment in orchestrate-core grants access; the device registration in LGL-Ingest is the live connection.

---

## API reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/devices` | GET | List all known devices |
| `/api/devices/:id/enroll` | POST | Approve or reject enrollment |
| `/api/devices/:id/verify` | POST | Mark device as verified |
| `/api/devices/:id/command` | POST | Send a command to a connected device |
| `/api/devices/:id/telemetry` | GET | Latest telemetry from Redis |
| `/api/sources` | GET | List all source slots |
| `/api/sources` | POST | Create a source slot |
| `/api/sources/:id` | PATCH | Update name / device_id / config / position |
| `/api/sources/:id/start` | POST | Start the source worker |
| `/api/sources/:id/stop` | POST | Stop the source worker |
| `/api/destinations` | GET | List all destination slots |
| `/api/destinations` | POST | Create a destination slot |
| `/api/destinations/:id/start` | POST | Start the destination worker |
| `/api/destinations/:id/stop` | POST | Stop the destination worker |
| `/api/routing` | GET | List all routes |
| `/api/routing` | POST | Create a route (`source_id`, `dest_id`) |
| `/api/routing/:id` | DELETE | Remove a route |
