#!/usr/bin/env python3
"""
capture_emulator.py — Sit between the panel and our emulator, log all ATEM→panel packets
to a binary file for comparison with debug_pvw_diff.py.

Usage:
  # Panel connects to localhost:9911, we forward to emulator on localhost:9910
  python3 capture_emulator.py --listen-port 9911 --target localhost:9910 --out emulator_capture.bin

  # Then point the panel at localhost:9911 instead of 9910.
  # Ctrl-C when done. File will contain raw ATEM→panel packet bytes.
"""

import socket
import threading
import argparse
import sys
import struct
from datetime import datetime
from pathlib import Path


def parse_addr(s: str):
    host, port = s.rsplit(':', 1)
    return host, int(port)


class Capturer:
    def __init__(self, listen_port: int, target_host: str, target_port: int, out_path: str):
        self.listen_port = listen_port
        self.target = (target_host, target_port)
        self.out_path = Path(out_path)
        self.out_file = None
        self.lock = threading.Lock()
        self.sessions = {}  # panel_addr -> emulator_addr mapping

    def write_pkt(self, data: bytes, direction: str):
        """direction: 'atem' (emulator→panel) or 'panel' (panel→emulator)"""
        with self.lock:
            # Log file: simple format — each packet prefixed with
            # 4-byte length + 1-byte direction (0=atem, 1=panel)
            marker = b'\x00' if direction == 'atem' else b'\x01'
            length = struct.pack('>I', len(data))
            self.out_file.write(length + marker + data)
            self.out_file.flush()

        # Also print a summary
        ts = datetime.now().strftime('%H:%M:%S.%f')[:-3]
        flags_byte = data[0] if len(data) > 0 else 0
        length_val = struct.unpack_from('>H', data, 0)[0] & 0x1FFF if len(data) >= 2 else 0
        arrow = '←ATEM' if direction == 'atem' else '→ATEM'
        print(f"[{ts}] {arrow} {len(data):4d}b  len_field={length_val}  first8={data[:8].hex(' ')}")

    def run(self):
        self.out_file = open(self.out_path, 'wb')
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(('0.0.0.0', self.listen_port))
        print(f"Listening on :{self.listen_port}, forwarding to {self.target[0]}:{self.target[1]}")
        print(f"Capturing to: {self.out_path}")
        print("Connect your panel to this host. Ctrl-C to stop.\n")

        # We need a second socket to receive replies from emulator
        reply_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        reply_sock.bind(('0.0.0.0', 0))  # ephemeral port
        our_port = reply_sock.getsockname()[1]

        panel_addr = None

        def recv_from_emulator():
            while True:
                try:
                    data, addr = reply_sock.recvfrom(65535)
                    self.write_pkt(data, 'atem')
                    if panel_addr:
                        sock.sendto(data, panel_addr)
                except OSError:
                    break

        t = threading.Thread(target=recv_from_emulator, daemon=True)
        t.start()

        try:
            while True:
                data, addr = sock.recvfrom(65535)
                panel_addr = addr
                self.write_pkt(data, 'panel')
                reply_sock.sendto(data, self.target)
        except KeyboardInterrupt:
            print(f"\nCapture complete. Saved to {self.out_path}")
        finally:
            sock.close()
            reply_sock.close()
            self.out_file.close()


def main():
    ap = argparse.ArgumentParser(description='Capture emulator UDP traffic for analysis')
    ap.add_argument('--listen-port', type=int, default=9911, help='Port for panel to connect to (default 9911)')
    ap.add_argument('--target', default='localhost:9910', help='Emulator address (default localhost:9910)')
    ap.add_argument('--out', default='emulator_capture.bin', help='Output capture file')
    args = ap.parse_args()

    host, port = parse_addr(args.target)
    Capturer(args.listen_port, host, port, args.out).run()


if __name__ == '__main__':
    main()
