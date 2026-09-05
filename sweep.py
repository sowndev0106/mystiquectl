#!/usr/bin/env python3
"""Search for the reply format the app accepts for command 0x12 (getVersion).

The app writes a 48-byte frame and then reads endpoint 1. When it does not
recognise the answer it calls reset() and starts over, so it never proceeds to
any other command. This generates candidate reply frames, has the shim serve a
different one on each read, then reports which candidate (if any) made the app
send something new.

    ./sweep.py            generate candidates, run, report
    ./sweep.py --list     print the candidates without running
    ./sweep.py --seconds 60
"""

import argparse
import collections
import contextlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# run-only.sh honours an inherited DC_CAPTURE_DIR (export
# DC_CAPTURE_DIR="${DC_CAPTURE_DIR:-$HERE/capture}"), and main() below passes
# this process's *whole* environment through via `env=dict(os.environ, ...)`
# -- so a caller with DC_CAPTURE_DIR already set (e.g. running this from
# inside another capture session) had candidates written to CAPTURE here
# while the app actually read replies from wherever DC_CAPTURE_DIR pointed:
# zero candidates served, and analyse() then read a stale, unrelated
# usb.jsonl from *this* module's CAPTURE. Same default as run-only.sh, and
# used consistently below instead of leaving it to inheritance.
CAPTURE = os.environ.get("DC_CAPTURE_DIR", os.path.join(HERE, "capture"))

SIG = b"HIDC"
REQUEST_CMD = 0x12


def frame(total_len, cmd, payload=b"", sig=SIG):
    """Build a frame in the grammar observed on the wire:

        AA | LEN | CMD | payload... | HIDC | SUM16-LE

    LEN is total_len - 2, i.e. the number of bytes the checksum covers, and
    the checksum is the 16-bit sum of those bytes, little-endian (confirmed
    against shim/usb-shim.js's own buildReply and COMMANDS.md; every candidate
    this generated before had its checksum bytes backwards, which fails
    validation on any reader that actually checks it -- and would have looked
    identical to "the app rejected the content" from this tool's own output).
    """
    body = bytearray(total_len)
    body[0] = 0xAA
    body[1] = total_len - 2
    body[2] = cmd
    body[3:3 + len(payload)] = payload
    sig_at = total_len - 2 - len(sig)
    body[sig_at:sig_at + len(sig)] = sig
    checksum = sum(body[:total_len - 2]) & 0xFFFF
    body[total_len - 2] = checksum & 0xFF
    body[total_len - 1] = (checksum >> 8) & 0xFF
    return bytes(body)


def candidates():
    """Reply shapes worth trying, each with a label explaining the guess."""
    out = []
    # bcdDevice on the real cooler is 2.47 and the bundled firmware is 2.70,
    # so the version may be BCD, plain bytes, or ASCII.
    versions = [
        ("nover", b""),
        ("ver0247", bytes([0x02, 0x47])),
        ("ver022f", bytes([0x02, 0x2F])),        # 2.47 as decimal 47 = 0x2F
        ("ver0270", bytes([0x02, 0x70])),
        ("verascii", b"2.47"),
    ]
    # The reply command byte: echoed, high bit set as a response marker, or +1.
    cmds = [("echo", REQUEST_CMD), ("hi", REQUEST_CMD | 0x80), ("next", REQUEST_CMD + 1)]
    # A status byte ahead of the payload is a common convention.
    statuses = [("nostat", b""), ("ok00", bytes([0x00])), ("ok01", bytes([0x01]))]

    for size in (64, 48):
        for cmd_name, cmd in cmds:
            for st_name, st in statuses:
                for v_name, ver in versions:
                    payload = st + ver
                    if len(payload) > size - 9:
                        continue
                    label = f"{size}/{cmd_name}/{st_name}/{v_name}"
                    out.append((label, frame(size, cmd, payload)))
    # Deduplicate: several combinations collapse to identical bytes.
    seen, uniq = set(), []
    for label, data in out:
        if data in seen:
            continue
        seen.add(data)
        uniq.append((label, data))
    return uniq


def analyse(cands):
    log = os.path.join(CAPTURE, "usb.jsonl")
    if not os.path.exists(log):
        print("no capture produced")
        return 1
    events = [json.loads(line) for line in open(log)]

    served = {}          # sweep index -> label
    last_index = None
    new_frames = []
    resets = 0
    for e in events:
        if e["event"] == "reply.sweep":
            last_index = e["index"]
            served[e["index"]] = e["hex"]
        elif e["event"] == "web.reset":
            resets += 1
        elif e["event"] == "web.transferOut":
            h = e["data"]["hex"]
            cmd = int(h[4:6], 16)
            if cmd != REQUEST_CMD:
                new_frames.append((last_index, cmd, h))

    tried = len(served)
    print(f"\ncandidates served: {tried} of {len(cands)}   resets: {resets}")

    if tried == 0:
        # Zero served means this analysed a run that never reached the sweep
        # at all -- most often the previous run's log, left behind because
        # run-only.sh's preflight failed before it could clear usb.jsonl (now
        # fixed there too) or because this invocation's subprocess.run below
        # returned non-zero and got ignored. Whatever new_frames contains here
        # belongs to some earlier run, not this one, and reporting it as
        # PROGRESS is a false positive with a confident exit code.
        print("\nno candidate was ever served -- this is not this run's data. "
              "Check that ./shim.py install has been run and that the app "
              "started at all (see app.log).")
        return 1

    if not new_frames:
        print("\nno new command was sent -- every candidate was rejected.")
        if tried < len(cands):
            print(f"only {tried} of {len(cands)} candidates were reached; "
                  f"run longer or lower DC_ANNOUNCE_EVERY to cover the rest.")
        return 2

    print(f"\nPROGRESS: {len(new_frames)} frame(s) with a new command byte")
    for index, cmd, h in new_frames[:10]:
        label = cands[index][0] if index is not None and index < len(cands) else "?"
        print(f"  after candidate #{index} ({label}) -> cmd 0x{cmd:02x}")
        print(f"    {h}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=60)
    ap.add_argument("--interval", type=int, default=700,
                    help="ms between handshake attempts (one candidate each)")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    cands = candidates()
    if args.list:
        for i, (label, data) in enumerate(cands):
            print(f"{i:>3}  {label:<28} {data.hex()}")
        return 0

    os.makedirs(CAPTURE, exist_ok=True)
    replies_path = os.path.join(CAPTURE, "replies.json")
    # This overwrites whatever the caller already had at replies.json --
    # normal-mode {"auto": ...} settings included -- and left it in sweep
    # mode with no way back short of deleting the file and letting a runner
    # recreate the default. Back it up first and always put it back,
    # success or failure.
    backup_path = replies_path + ".sweep-backup"
    had_previous = os.path.exists(replies_path)
    if had_previous:
        shutil.copy2(replies_path, backup_path)
    try:
        with open(replies_path, "w") as f:
            json.dump({"sweep": [d.hex() for _, d in cands]}, f)
        print(f"{len(cands)} candidate replies, {args.interval}ms apart, "
              f"{args.seconds}s run (~{args.seconds * 1000 // args.interval} attempts)")

        env = dict(os.environ,
                   DC_CAPTURE_DIR=CAPTURE,
                   DC_PIDS="0x0009",
                   DC_ANNOUNCE_EVERY=str(args.interval),
                   DC_QUIET="skia|Canvas|getContext|fillText|loadFont|measureText|L122|L086|L136|L142|CH690|C122")
        r = subprocess.run([os.path.join(HERE, "run-only.sh"), str(args.seconds)], env=env)
        if r.returncode not in (0, 124):  # 124: timeout, the intended way this exits
            print(f"\nrun-only.sh failed (exit {r.returncode}); not analysing -- "
                  f"whatever is in usb.jsonl now is not from this run.")
            return 1
        return analyse(cands)
    finally:
        if had_previous:
            os.replace(backup_path, replies_path)
        else:
            with contextlib.suppress(FileNotFoundError):
                os.remove(replies_path)


if __name__ == "__main__":
    sys.exit(main())
