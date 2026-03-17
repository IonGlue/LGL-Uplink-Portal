# ATEM Dumps

Binary init dumps and proxy captures from real ATEM hardware.

## Reference Data (pre-captured, real hardware)

The `reference/` subdirectory contains captures from **nrkno/sofie-atem-connection** — real ATEM
hardware captures covering 27 device models, firmware v7.2 through v10.1.1. These are the
authoritative ground truth for protocol correctness.

```bash
# Download all (or filter by model name)
python3 ../tools/fetch_reference_data.py
python3 ../tools/fetch_reference_data.py --filter tvshd constellation mini

# See what's available
python3 ../tools/fetch_reference_data.py --list
```

Format: `.data` files — newline-separated hex strings, one BMDP packet payload per line.
Captured by connecting to live hardware; no framing headers, just raw command streams.

Relevant models already captured (in the upstream repo):

| File | Device | Firmware |
|------|--------|----------|
| `tvshd-v8.0.0.data` | ATEM Television Studio HD | v8.0.0 |
| `tvshd-v8.1.0.data` | ATEM Television Studio HD | v8.1.0 |
| `tvshd-v8.2.0.data` | ATEM Television Studio HD | v8.2.0 |
| `constellation-v8.0.2.data` | ATEM 2 M/E Constellation | v8.0.2 |
| `constellation-v8.2.3.data` | ATEM 2 M/E Constellation | v8.2.3 |
| `constellation-4me-4k-v9.1.data` | ATEM Constellation 4K | v9.1 |
| `mini-extreme-iso-g2-v10.1.1.data` | ATEM Mini Extreme ISO G2 | v10.1.1 |

## Capturing Your Own Real ATEM

If your device/firmware isn't in the reference set, capture it directly:

```bash
# Install sofie-atem-connection (only needed once)
npm install atem-connection

# Capture — replace 192.168.1.100 with your ATEM's IP
node ../tools/dump.js 192.168.1.100 my-atem-v9.x
# Creates my-atem-v9.x.data in the current directory
```

Or use our Python capture proxy (no npm needed):
```bash
python3 ../tools/capture_emulator.py --listen-port 9911 --target 192.168.1.100:9910 --out my-capture.bin
```

## Our Own Dumps

| File | Size | Description |
|------|------|-------------|
| `ATEM_2_M_E_Constellation_4K.bin` | 85830 bytes | Full init dump from Constellation 4K |
| `ATEM_Television_Studio_HD.bin` | — | Init dump from TV Studio HD |
| `active_dump_85830.bin` | 85830 bytes | Known-working replay dump |
| `debug_proxy_log.txt` | — | Full transparent proxy capture — real ATEM responses verbatim |

## Binary Dump Format (.bin)

Each `.bin` file is a sequence of raw BMDP packets:

```
Packet header (12 bytes):
  [0:2]  flags(3b) + length(13b), big-endian
  [2:4]  session ID
  [4:6]  remote sequence number
  [6:8]  local sequence number
  [8:10] unknown
  [10:12] ack sequence number

Command (within packet payload):
  [0:2]  total command length including this header
  [2:4]  flags
  [4:8]  4-char ASCII command name
  [8..]  command payload
```

## Key Commands for PVW Debugging

| Command | Purpose | Note |
|---------|---------|------|
| `PrvI` | Preview input source per M/E | Likely wrong bytes causing PVW LED failure |
| `PrgI` | Program input source per M/E | Works (PGM LED lights) |
| `TlIn` | Tally by input index (bit0=PGM, bit1=PVW) | May have wrong bit layout |
| `TlSr` | Tally by source (sparse) | |
| `MePg` | M/E state page | |

## Analysis Workflow

```bash
# 1. Get reference data
python3 ../tools/fetch_reference_data.py --filter tvshd

# 2. See what the real ATEM sends for PrvI and TlIn
python3 ../tools/debug_pvw_diff.py real reference/tvshd-v8.1.0.data

# 3. Capture emulator output (connect panel to port 9911, Ctrl-C when done)
python3 ../tools/capture_emulator.py --listen-port 9911 --target localhost:9910 --out emulator_capture.bin

# 4. Find the exact differing bytes
python3 ../tools/debug_pvw_diff.py diff reference/tvshd-v8.1.0.data emulator_capture.bin

# 5. General command inspection
python3 ../tools/parse_atem_commands.py dump reference/tvshd-v8.1.0.data --cmd PrvI TlIn TlSr
python3 ../tools/parse_atem_commands.py diff reference/tvshd-v8.1.0.data emulator_capture.bin
```
