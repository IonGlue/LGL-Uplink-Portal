#!/usr/bin/env python3
"""
fetch_reference_data.py — Download captured ATEM init data from nrkno/sofie-atem-connection.

These are real ATEM hardware captures covering 27 device models, firmware v7.2–v10.1.1.
Source: https://github.com/nrkno/sofie-atem-connection/tree/master/src/__tests__/connection

Usage:
  # Download all captures to atem_dumps/reference/
  python3 fetch_reference_data.py

  # Download only specific models
  python3 fetch_reference_data.py --filter tvshd constellation mini

  # List what's available without downloading
  python3 fetch_reference_data.py --list
"""

import urllib.request
import urllib.error
import argparse
import sys
import time
from pathlib import Path

BASE_URL = "https://raw.githubusercontent.com/nrkno/sofie-atem-connection/master/src/__tests__/connection"

# All known captures — device slug -> filename
CAPTURES = {
    "1me-v8.1":                     "1me-v8.1.data",
    "1me4k-v8.2":                   "1me4k-v8.2.data",
    "2me-v8.1":                     "2me-v8.1.data",
    "2me-v8.1.2":                   "2me-v8.1.2.data",
    "2me4k-v8.4":                   "2me4k-v8.4.data",
    "4me4k-v7.5.2":                 "4me4k-v7.5.2.data",
    "4me4k-v8.2":                   "4me4k-v8.2.data",
    "constellation-v8.0.2":         "constellation-v8.0.2.data",
    "constellation-v8.2.3":         "constellation-v8.2.3.data",
    "constellation-2me-hd-v8.7.0":  "constellation-2me-hd-v8.7.0.data",
    "constellation-2me-hd-v9.6.2":  "constellation-2me-hd-v9.6.2.data",
    "constellation-4me-4k-v9.1":    "constellation-4me-4k-v9.1.data",
    "mini-v8.1":                    "mini-v8.1.data",
    "mini-v8.1.1":                  "mini-v8.1.1.data",
    "mini-v8.6":                    "mini-v8.6.data",
    "mini-pro-v8.2":                "mini-pro-v8.2.data",
    "mini-pro-iso-v8.4":            "mini-pro-iso-v8.4.data",
    "mini-extreme-v8.6":            "mini-extreme-v8.6.data",
    "mini-extreme-iso-v9.5":        "mini-extreme-iso-v9.5.data",
    "mini-extreme-iso-g2-v10.1.1":  "mini-extreme-iso-g2-v10.1.1.data",
    "ps4k-v7.2":                    "ps4k-v7.2.data",
    "sdi-extreme-iso-v8.8":         "sdi-extreme-iso-v8.8.data",
    "tvs-4k8-v9.3":                 "tvs-4k8-v9.3.data",
    "tvs-hd8-v9.0":                 "tvs-hd8-v9.0.data",
    "tvshd-v8.0.0":                 "tvshd-v8.0.0.data",
    "tvshd-v8.1.0":                 "tvshd-v8.1.0.data",
    "tvshd-v8.2.0":                 "tvshd-v8.2.0.data",
}


def fetch_file(url: str, dest: Path, retries: int = 3) -> bool:
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=15) as r:
                dest.write_bytes(r.read())
            return True
        except urllib.error.HTTPError as e:
            print(f"  HTTP {e.code}: {url}", file=sys.stderr)
            return False
        except Exception as e:
            if attempt < retries - 1:
                wait = 2 ** attempt
                print(f"  Error ({e}), retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
            else:
                print(f"  Failed after {retries} attempts: {e}", file=sys.stderr)
                return False
    return False


def main():
    ap = argparse.ArgumentParser(description='Download ATEM reference capture data')
    ap.add_argument('--filter', nargs='+', metavar='TERM',
                    help='Only download captures whose name contains any of these terms')
    ap.add_argument('--list', action='store_true', help='List available captures, do not download')
    ap.add_argument('--out', default=str(Path(__file__).parent.parent / 'atem_dumps' / 'reference'),
                    help='Output directory (default: atem_dumps/reference/)')
    args = ap.parse_args()

    targets = dict(CAPTURES)
    if args.filter:
        targets = {k: v for k, v in CAPTURES.items()
                   if any(f.lower() in k.lower() for f in args.filter)}
        if not targets:
            print(f"No captures match filter {args.filter}")
            print("Available:", ', '.join(CAPTURES.keys()))
            sys.exit(1)

    if args.list:
        print(f"{'Slug':<40}  {'Filename'}")
        print(f"{'-'*40}  {'-'*35}")
        for slug, filename in sorted(targets.items()):
            print(f"{slug:<40}  {filename}")
        print(f"\n{len(targets)} capture(s) available")
        return

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    ok = 0
    skip = 0
    fail = 0
    for slug, filename in sorted(targets.items()):
        dest = out_dir / filename
        if dest.exists():
            print(f"  skip  {filename}  (already exists)")
            skip += 1
            continue
        url = f"{BASE_URL}/{filename}"
        print(f"  fetch {filename} ...", end=' ', flush=True)
        if fetch_file(url, dest):
            size = dest.stat().st_size
            print(f"ok ({size:,} bytes)")
            ok += 1
        else:
            fail += 1

    print(f"\nDone: {ok} downloaded, {skip} skipped, {fail} failed")
    if ok > 0:
        print(f"Saved to: {out_dir}/")
        print("\nNext steps:")
        print(f"  python3 parse_atem_commands.py dump {out_dir}/tvshd-v8.1.0.data --cmd PrvI TlIn")
        print(f"  python3 debug_pvw_diff.py real {out_dir}/tvshd-v8.1.0.data")


if __name__ == '__main__':
    main()
