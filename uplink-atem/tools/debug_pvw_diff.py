#!/usr/bin/env python3
"""
debug_pvw_diff.py — Focused tool for diagnosing the PVW LED bug.

The problem: PGM button LED works, PVW LED doesn't. The fix requires finding
exactly which bytes differ between our emulator's PrvI/TlIn response and
the real ATEM's response captured in the proxy log.

Usage:
  # Step 1: See what the real ATEM sends for PrvI and TlIn
  python3 debug_pvw_diff.py real debug_proxy_log.txt

  # Step 2: Capture our emulator's packets, then compare
  python3 debug_pvw_diff.py diff debug_proxy_log.txt emulator_capture.bin

  # Step 3: Decode a specific command payload manually
  python3 debug_pvw_diff.py decode PrvI 00 01 00 00
  python3 debug_pvw_diff.py decode TlIn 00 02 01 02 00 00

Capturing emulator output (run once, ctrl-c when panel connects):
  sudo tcpdump -i lo -w emulator_capture.pcap udp port 9910
  # or use the proxy: python3 atem-proxy-capture.py --target localhost:9910 --log emulator_capture.bin
"""

import sys
import struct
import argparse
from pathlib import Path

# Import the shared parsing library
sys.path.insert(0, str(Path(__file__).parent))
from parse_atem_commands import load_any, AtemCommand


# ---------------------------------------------------------------------------
# Protocol field decoders — PrvI, PrgI, TlIn, TlSr
# ---------------------------------------------------------------------------

def decode_PrvI(payload: bytes) -> dict:
    """
    Preview Input state: which source is on preview for each M/E.
    Layout (per spec / empirical): 2 bytes per M/E
      [0:2] M/E index (0-based, big-endian uint16)... actually:
    Most common layout seen in practice:
      [0:2] uint16 source_id (big-endian)
    Some firmware versions have ME index prefix.
    """
    if len(payload) < 2:
        return {'raw': payload.hex(' ')}
    source = struct.unpack_from('>H', payload, 0)[0]
    result = {'source_id': source, 'raw': payload.hex(' ')}
    if len(payload) >= 4:
        result['byte2'] = payload[2]
        result['byte3'] = payload[3]
    return result


def decode_PrgI(payload: bytes) -> dict:
    """Program Input state."""
    if len(payload) < 2:
        return {'raw': payload.hex(' ')}
    source = struct.unpack_from('>H', payload, 0)[0]
    result = {'source_id': source, 'raw': payload.hex(' ')}
    return result


def decode_TlIn(payload: bytes) -> dict:
    """
    Tally by input source.
    Layout:
      [0:2] uint16 source_count
      [2:]  1 byte per source: bit0=PGM, bit1=PVW
    """
    if len(payload) < 2:
        return {'raw': payload.hex(' ')}
    count = struct.unpack_from('>H', payload, 0)[0]
    tallies = []
    for i in range(min(count, len(payload) - 2)):
        b = payload[2 + i]
        tallies.append({'index': i, 'pgm': bool(b & 1), 'pvw': bool(b & 2), 'raw': b})
    return {'source_count': count, 'tallies': tallies, 'raw': payload.hex(' ')}


def decode_TlSr(payload: bytes) -> dict:
    """
    Tally by source (sparse — only sources with active tally).
    Layout:
      [0:2] uint16 count
      [2:]  3 bytes per entry: uint16 source_id + uint8 flags
    """
    if len(payload) < 2:
        return {'raw': payload.hex(' ')}
    count = struct.unpack_from('>H', payload, 0)[0]
    entries = []
    for i in range(min(count, (len(payload) - 2) // 3)):
        off = 2 + i * 3
        src = struct.unpack_from('>H', payload, off)[0]
        flags = payload[off + 2]
        entries.append({'source': src, 'pgm': bool(flags & 1), 'pvw': bool(flags & 2)})
    return {'count': count, 'entries': entries, 'raw': payload.hex(' ')}


def decode_MePg(payload: bytes) -> dict:
    """M/E Program state."""
    if len(payload) < 4:
        return {'raw': payload.hex(' ')}
    me = payload[0]
    src = struct.unpack_from('>H', payload, 2)[0]
    return {'me_index': me, 'source_id': src, 'raw': payload.hex(' ')}


DECODERS = {
    'PrvI': decode_PrvI,
    'PrgI': decode_PrgI,
    'TlIn': decode_TlIn,
    'TlSr': decode_TlSr,
    'MePg': decode_MePg,
}

PVW_COMMANDS = ['PrvI', 'PrgI', 'TlIn', 'TlSr', 'MePg']


def decode_command(cmd: AtemCommand) -> None:
    decoder = DECODERS.get(cmd.name)
    print(f"\n{'─'*60}")
    print(f"  {cmd.name}  ({len(cmd.payload)} bytes)")
    print(f"  Hex: {cmd.hex()}")
    if decoder:
        info = decoder(cmd.payload)
        for k, v in info.items():
            if k != 'raw':
                print(f"  {k}: {v}")
    else:
        print(f"  (no decoder for {cmd.name!r})")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_real(args):
    """Show real ATEM's PVW-related commands from proxy log or reference data."""
    commands = load_any(args.file)

    target = set(args.cmd) if args.cmd else set(PVW_COMMANDS)
    found = {name: [] for name in target}
    for cmd in commands:
        if cmd.name in target:
            found[cmd.name].append(cmd)

    print(f"Real ATEM commands from: {path.name}")
    for name in PVW_COMMANDS:
        if name not in target:
            continue
        cmds = found.get(name, [])
        if not cmds:
            print(f"\n[{name}] NOT FOUND in log")
            continue
        # Show first occurrence in detail
        decode_command(cmds[0])
        if len(cmds) > 1:
            print(f"  ... ({len(cmds)-1} more occurrences)")


def cmd_diff(args):
    """Byte-for-byte diff of PVW commands between real and emulator captures."""
    def load(p: str):
        return {c.name: c for c in load_any(p)}

    real = load(args.real)
    emu  = load(args.emulator)
    target = set(args.cmd) if args.cmd else set(PVW_COMMANDS)

    print(f"Comparing: {args.real}  vs  {args.emulator}\n")

    any_diff = False
    for name in PVW_COMMANDS:
        if name not in target:
            continue
        r = real.get(name)
        e = emu.get(name)
        if r is None and e is None:
            continue
        if r is None:
            print(f"[{name}] MISSING in real log (present in emulator)")
            continue
        if e is None:
            print(f"[{name}] MISSING in emulator (present in real log)")
            continue
        if r.payload == e.payload:
            print(f"[{name}] IDENTICAL ✓  ({len(r.payload)}b)")
        else:
            any_diff = True
            print(f"\n[{name}] DIFFER  real={len(r.payload)}b  emu={len(e.payload)}b  ← BUG HERE")
            _hex_diff(r.payload, e.payload, args.real, args.emulator)
            decoder = DECODERS.get(name)
            if decoder:
                print(f"\n  Real decoded:      {decoder(r.payload)}")
                print(f"  Emulator decoded:  {decoder(e.payload)}")

    if not any_diff:
        print("\nAll PVW commands identical. Bug may be in sequence/timing, not payload content.")


def _hex_diff(a: bytes, b: bytes, label_a: str, label_b: str, width: int = 16):
    max_len = max(len(a), len(b))
    print(f"  {'off':>4}  {'real ('+label_a+')':<48}  {'emu ('+label_b+')':<48}")
    print(f"  {'----':>4}  {'-'*47}  {'-'*47}")
    for off in range(0, max_len, width):
        ac = a[off:off+width]
        bc = b[off:off+width]
        ah = ' '.join(f'{x:02x}' for x in ac).ljust(47)
        bh = ' '.join(f'{x:02x}' for x in bc).ljust(47)
        marks = ''
        for i in range(max(len(ac), len(bc))):
            av = ac[i] if i < len(ac) else None
            bv = bc[i] if i < len(bc) else None
            marks += '^' if av != bv else '.'
        star = ' *' if '^' in marks else ''
        print(f"  {off:04x}  {ah}  {bh}  {marks}{star}")


def cmd_decode(args):
    """Decode a single command payload given as hex bytes on command line."""
    try:
        payload = bytes(int(b, 16) for b in args.bytes)
    except ValueError as e:
        sys.exit(f"ERROR: bad hex byte: {e}")
    cmd = AtemCommand(name=args.name, payload=payload)
    decode_command(cmd)


def main():
    parser = argparse.ArgumentParser(description='ATEM PVW debug tool')
    sub = parser.add_subparsers(dest='command', required=True)

    p = sub.add_parser('real', help='Show real ATEM PVW commands from proxy log')
    p.add_argument('file', help='debug_proxy_log.txt or binary dump')
    p.add_argument('--cmd', nargs='+', help='Commands to show (default: all PVW-related)')
    p.set_defaults(func=cmd_real)

    p = sub.add_parser('diff', help='Diff real vs emulator for PVW commands')
    p.add_argument('real', help='Proxy log from real ATEM (debug_proxy_log.txt)')
    p.add_argument('emulator', help='Capture from emulator')
    p.add_argument('--cmd', nargs='+', help='Limit to specific commands')
    p.set_defaults(func=cmd_diff)

    p = sub.add_parser('decode', help='Decode a command payload from hex')
    p.add_argument('name', help='4-char command name (e.g. PrvI)')
    p.add_argument('bytes', nargs='+', metavar='HH', help='Hex bytes of payload')
    p.set_defaults(func=cmd_decode)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
