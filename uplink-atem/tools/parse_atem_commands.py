#!/usr/bin/env python3
"""
parse_atem_commands.py — Extract and display ATEM commands from multiple sources.

Supported input formats:
  .bin   — raw BMDP binary dump (our captures, Constellation 4K, etc.)
  .data  — sofie-atem-connection format: newline-separated hex strings, one per packet payload
             (reference captures from nrkno/sofie-atem-connection, real hardware, fw v7.2-v10.1.1)
  .txt   — proxy log text (debug_proxy_log.txt)

Usage:
  # Dump all commands from a reference data file
  python3 parse_atem_commands.py dump atem_dumps/reference/tvshd-v8.1.0.data

  # Dump specific commands only
  python3 parse_atem_commands.py dump active_dump_85830.bin --cmd PrvI TlIn PrgI TlSr

  # Compare two captures byte-for-byte
  python3 parse_atem_commands.py diff tvshd-v8.1.0.data active_dump_85830.bin --cmd PrvI TlIn
"""

import sys
import struct
import argparse
import re
from pathlib import Path
from dataclasses import dataclass
from typing import Iterator


@dataclass
class AtemCommand:
    name: str       # 4-char ASCII
    payload: bytes  # raw payload bytes (excludes the 8-byte cmd header)
    packet_seq: int = 0

    def hex(self) -> str:
        return self.payload.hex(' ')

    def __repr__(self):
        return f"[{self.name}] {len(self.payload)}b: {self.payload.hex(' ')}"


# ---------------------------------------------------------------------------
# Binary init dump parser
# ---------------------------------------------------------------------------

BMDP_HEADER_LEN = 12
CMD_HEADER_LEN = 8


def parse_bmdp_packets(data: bytes) -> Iterator[tuple[int, bytes]]:
    """Yield (seq_no, payload_bytes) for each BMDP packet in data."""
    offset = 0
    while offset < len(data):
        if offset + BMDP_HEADER_LEN > len(data):
            break
        word0 = struct.unpack_from('>H', data, offset)[0]
        pkt_len = word0 & 0x1FFF
        if pkt_len < BMDP_HEADER_LEN or offset + pkt_len > len(data):
            # Try to re-sync: scan forward for a plausible length
            offset += 2
            continue
        seq_no = struct.unpack_from('>H', data, offset + 10)[0]
        payload = data[offset + BMDP_HEADER_LEN: offset + pkt_len]
        yield seq_no, payload
        offset += pkt_len


def parse_commands_from_payload(payload: bytes, packet_seq: int = 0) -> Iterator[AtemCommand]:
    """Parse ATEM commands from the payload portion of a BMDP packet."""
    offset = 0
    while offset < len(payload):
        if offset + CMD_HEADER_LEN > len(payload):
            break
        cmd_len = struct.unpack_from('>H', payload, offset)[0]
        if cmd_len < CMD_HEADER_LEN or offset + cmd_len > len(payload):
            break
        name_bytes = payload[offset + 4: offset + 8]
        try:
            name = name_bytes.decode('ascii')
        except UnicodeDecodeError:
            offset += 2
            continue
        if not all(c.isprintable() for c in name):
            offset += 2
            continue
        cmd_payload = payload[offset + CMD_HEADER_LEN: offset + cmd_len]
        yield AtemCommand(name=name, payload=cmd_payload, packet_seq=packet_seq)
        offset += cmd_len


def parse_binary_dump(data: bytes) -> list[AtemCommand]:
    """Parse all commands from a binary init dump file."""
    commands = []
    # First try: the file is a sequence of BMDP packets
    for seq, payload in parse_bmdp_packets(data):
        for cmd in parse_commands_from_payload(payload, seq):
            commands.append(cmd)
    if commands:
        return commands
    # Fallback: the file might be raw command stream (no BMDP framing)
    for cmd in parse_commands_from_payload(data):
        commands.append(cmd)
    return commands


def parse_sofie_data(text: str) -> list[AtemCommand]:
    """
    Parse a .data file from nrkno/sofie-atem-connection.
    Format: each line is a hex string (no spaces) representing one packet's command payload.
    The hex is the raw command stream AFTER the 12-byte BMDP packet header is stripped.
    """
    commands = []
    for i, line in enumerate(text.splitlines()):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        try:
            payload = bytes.fromhex(line)
        except ValueError:
            continue
        for cmd in parse_commands_from_payload(payload, packet_seq=i):
            commands.append(cmd)
    return commands


# ---------------------------------------------------------------------------
# Proxy log parser
# Lines expected to look like either:
#   [ATEM→panel] 0000: 00 0a 10 00 ...
#   [panel→ATEM] 0000: 00 0a 10 00 ...
#   or bare hex lines, or "RECV: 00 0a ..."
# ---------------------------------------------------------------------------

HEX_LINE_RE = re.compile(
    r'(?:'
    r'(?P<dir>[<>→←RECV|SEND:\s]*?)'       # optional direction marker
    r'[0-9a-fA-F]{4}:\s'                   # optional offset
    r')?'
    r'(?P<hex>(?:[0-9a-fA-F]{2}\s?){2,})'  # hex bytes
)

DIRECTION_ATEM_PATTERNS = ['→panel', 'ATEM→', 'RECV', '<', 'atem']


def line_is_from_atem(line: str) -> bool:
    low = line.lower()
    return any(p.lower() in low for p in DIRECTION_ATEM_PATTERNS)


def parse_proxy_log(text: str, atem_only: bool = True) -> list[AtemCommand]:
    """Parse ATEM commands from a proxy log text file."""
    commands = []
    # Collect runs of hex bytes that form complete BMDP packets
    current_bytes = bytearray()
    current_is_atem = False

    for line in text.splitlines():
        line = line.strip()
        if not line:
            # Flush current buffer
            if current_bytes:
                data = bytes(current_bytes)
                cmds = parse_binary_dump(data)
                for c in cmds:
                    commands.append(c)
                current_bytes = bytearray()
            continue

        is_atem = line_is_from_atem(line)

        # Look for raw hex content in this line
        hex_chars = re.findall(r'\b[0-9a-fA-F]{2}\b', line)
        if len(hex_chars) >= 4:
            if atem_only and not is_atem and current_is_atem:
                # Direction changed, flush
                if current_bytes:
                    data = bytes(current_bytes)
                    for c in parse_binary_dump(data):
                        commands.append(c)
                    current_bytes = bytearray()
            if not atem_only or is_atem:
                current_is_atem = is_atem
                current_bytes.extend(bytes(int(h, 16) for h in hex_chars))

    if current_bytes:
        for c in parse_binary_dump(bytes(current_bytes)):
            commands.append(c)

    return commands


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

def load_any(path_str: str) -> list[AtemCommand]:
    """Load commands from any supported file type."""
    path = Path(path_str)
    if not path.exists():
        sys.exit(f"ERROR: {path} not found")
    if path.suffix == '.data':
        return parse_sofie_data(path.read_text(errors='replace'))
    if path.suffix == '.txt':
        return parse_proxy_log(path.read_text(errors='replace'))
    return parse_binary_dump(path.read_bytes())


def cmd_dump(args):
    path = Path(args.file)
    if not path.exists():
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(1)

    commands = load_any(args.file)

    filter_names = set(args.cmd) if args.cmd else None

    seen = {}
    for cmd in commands:
        if filter_names and cmd.name not in filter_names:
            continue
        key = cmd.name
        if key not in seen or args.all:
            print(f"\n{'='*60}")
            print(f"Command: {cmd.name!r}  payload={len(cmd.payload)} bytes  pkt_seq={cmd.packet_seq}")
            print(f"Hex: {cmd.hex()}")
            print(f"Raw: {cmd.payload!r}")
            seen[key] = cmd


def cmd_diff(args):
    def load(path_str):
        return {c.name: c for c in load_any(path_str)}

    a_cmds = load(args.file_a)
    b_cmds = load(args.file_b)

    filter_names = set(args.cmd) if args.cmd else (set(a_cmds) | set(b_cmds))

    any_diff = False
    for name in sorted(filter_names):
        a = a_cmds.get(name)
        b = b_cmds.get(name)
        if a is None and b is None:
            continue
        if a is None:
            print(f"\n[{name}] MISSING in {args.file_a}, present in {args.file_b}")
            print(f"  B: {b.hex()}")
            any_diff = True
            continue
        if b is None:
            print(f"\n[{name}] Present in {args.file_a}, MISSING in {args.file_b}")
            print(f"  A: {a.hex()}")
            any_diff = True
            continue
        if a.payload == b.payload:
            print(f"[{name}] identical ({len(a.payload)}b)")
        else:
            any_diff = True
            print(f"\n[{name}] DIFFER  A={len(a.payload)}b  B={len(b.payload)}b")
            _print_hex_diff(name, a.payload, b.payload, args.file_a, args.file_b)

    if not any_diff:
        print("\nAll compared commands are identical.")


def _print_hex_diff(name: str, a: bytes, b: bytes, label_a: str, label_b: str):
    width = 16
    max_len = max(len(a), len(b))
    print(f"  {'Offset':<8}  {'A ('+label_a+')':<49}  {'B ('+label_b+')':<49}  diff")
    print(f"  {'-'*8}  {'-'*47}  {'-'*47}  ----")
    for off in range(0, max_len, width):
        a_chunk = a[off:off+width]
        b_chunk = b[off:off+width]
        a_hex = ' '.join(f'{x:02x}' for x in a_chunk).ljust(47)
        b_hex = ' '.join(f'{x:02x}' for x in b_chunk).ljust(47)
        # Mark bytes that differ
        diff_marks = []
        for i in range(max(len(a_chunk), len(b_chunk))):
            av = a_chunk[i] if i < len(a_chunk) else None
            bv = b_chunk[i] if i < len(b_chunk) else None
            diff_marks.append('^' if av != bv else ' ')
        print(f"  {off:08x}  {a_hex}  {b_hex}  {''.join(diff_marks[:width])}")


def main():
    parser = argparse.ArgumentParser(description='ATEM command parser and diff tool')
    sub = parser.add_subparsers(dest='command', required=True)

    p_dump = sub.add_parser('dump', help='Print commands from a binary dump or proxy log')
    p_dump.add_argument('file')
    p_dump.add_argument('--cmd', nargs='+', metavar='NAME', help='Filter to specific 4-char command names')
    p_dump.add_argument('--all', action='store_true', help='Show all occurrences, not just first')
    p_dump.set_defaults(func=cmd_dump)

    p_diff = sub.add_parser('diff', help='Compare commands between two files')
    p_diff.add_argument('file_a')
    p_diff.add_argument('file_b')
    p_diff.add_argument('--cmd', nargs='+', metavar='NAME', help='Filter to specific command names')
    p_diff.set_defaults(func=cmd_diff)

    p_log = sub.add_parser('log', help='Parse proxy log and show ATEM-sent commands')
    p_log.add_argument('file')
    p_log.add_argument('--cmd', nargs='+', metavar='NAME')
    p_log.add_argument('--all', action='store_true')
    p_log.set_defaults(func=lambda a: cmd_dump(type('A', (), {'file': a.file, 'cmd': a.cmd, 'all': a.all})()))

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
