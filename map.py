#!/usr/bin/env python3
"""Attribute captured USB frames to the setting change that produced them.

    ./map.py [capture-dir]

Reads a capture made with driver/sweep-settings.js. Frames emitted between one
`sweep.set` marker and the next belong to that marker's field/value, which is
what turns a stream of bytes into a command table.
"""

import collections
import json
import os
import sys

CAPTURE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "capture")


def frames_by_step(events):
    """Yield (marker, [frames]) for each sweep.set marker, in order."""
    current = None
    frames = []
    for e in events:
        if e["event"] == "sweep.set":
            if current is not None:
                yield current, frames
            current = e
            frames = []
        elif e["event"] == "web.transferOut" and current is not None:
            # Settings live on endpoint 1 (interface A). Endpoint 2 (interface
            # B) carries the 1 Hz sensor push, the RTC set and the status
            # query, which run continuously in the background regardless of
            # what the sweep is doing -- without this filter, whichever
            # setting happened to be active when the next 0x01 tick landed
            # got a stray sensor frame folded into its table entry.
            if e.get("ep") == 1:
                frames.append(bytes.fromhex(e["data"]["hex"]))
    if current is not None:
        yield current, frames


def decode(frame):
    """Split a frame into its fields and check the checksum."""
    n = len(frame)
    body = frame[3:n - 6]
    stated = frame[n - 2] | (frame[n - 1] << 8)
    actual = sum(frame[:n - 2]) & 0xFFFF
    return {
        "cmd": frame[2],
        "len": frame[1],
        "sig": frame[n - 6:n - 2].decode("ascii", "replace"),
        "payload": body,
        "payload_trimmed": body.rstrip(b"\x00"),
        "sum_ok": stated == actual,
    }


def main():
    log = os.path.join(CAPTURE, "usb.jsonl")
    if not os.path.exists(log):
        print(f"no capture at {log}")
        return 1
    events = [json.loads(line) for line in open(log)]

    baseline = next((e["baseline"] for e in events if e["event"] == "sweep.baseline"), None)
    if baseline:
        print("baseline DeviceInfo:")
        print("  " + json.dumps(baseline, separators=(",", ":")))
        print()

    steps = list(frames_by_step(events))
    if not steps:
        print("no sweep markers in this capture -- was driver/sweep-settings.js used?")
        return 1

    # A frame that appears under every field carries no information about any of
    # them; those are the periodic/init frames.
    per_field = collections.defaultdict(set)
    for marker, frames in steps:
        for f in frames:
            per_field[marker["path"]].add(f.hex())
    fields = set(per_field)
    ubiquitous = set.intersection(*per_field.values()) if len(per_field) > 1 else set()

    print(f"{len(steps)} steps, {sum(len(f) for _, f in steps)} frames, "
          f"{len(fields)} fields, {len(ubiquitous)} frame(s) common to every field\n")

    print("=" * 78)
    print("FIELD -> COMMAND")
    print("=" * 78)
    by_field = collections.defaultdict(list)
    for marker, frames in steps:
        by_field[marker["path"]].append((marker, frames))

    mapping = {}
    for path, entries in by_field.items():
        rows = []
        for marker, frames in entries:
            distinct = [decode(f) for f in frames if f.hex() not in ubiquitous]
            rows.append((marker.get("value"), marker.get("restore", False), distinct))
        cmds = sorted({d["cmd"] for _, _, ds in rows for d in ds})
        if not cmds:
            print(f"\n{path}: no distinctive frame (change produced nothing new)")
            continue
        mapping[path] = cmds
        print(f"\n{path}  ->  " + ", ".join(f"0x{c:02x}" for c in cmds))
        for value, restore, ds in rows:
            tag = " (restore)" if restore else ""
            for d in ds:
                pay = d["payload"][:8].hex()   # fixed width: trailing zeros are meaningful
                warn = "" if d["sum_ok"] else "  !! checksum mismatch"
                print(f"    {str(value):<12}{tag:<11} cmd 0x{d['cmd']:02x}  payload={pay}{warn}")

    print("\n" + "=" * 78)
    print("COMMAND -> FIELDS")
    print("=" * 78)
    rev = collections.defaultdict(set)
    for path, cmds in mapping.items():
        for c in cmds:
            rev[c].add(path)
    for cmd in sorted(rev):
        print(f"  0x{cmd:02x}  {', '.join(sorted(rev[cmd]))}")

    if ubiquitous:
        print(f"\n{len(ubiquitous)} frame(s) emitted for every field (init/keepalive, not setting-specific):")
        for h in sorted(ubiquitous):
            d = decode(bytes.fromhex(h))
            print(f"  cmd 0x{d['cmd']:02x}  payload={d['payload'][:8].hex()}")

    failed = [e for e in events if e["event"] == "driver.invoke" and not e.get("ok")]
    if failed:
        print(f"\n{len(failed)} failed IPC call(s):")
        seen = collections.Counter((e["channel"], e.get("error")) for e in failed)
        for (ch, err), n in seen.most_common(10):
            print(f"  {n:>3}x {ch}: {err}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
