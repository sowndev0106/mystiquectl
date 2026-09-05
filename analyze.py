#!/usr/bin/env python3
"""Summarise a capture produced by the recording shim.

    ./analyze.py [capture-dir]

Prints the USB conversation, a hex dump of each distinct outbound frame, and
the result of hunting for a checksum over every plausible span of the frame.
"""

import collections
import json
import os
import sys

CAPTURE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "capture")
LOG = os.path.join(CAPTURE, "usb.jsonl")

USB_EVENTS = (
    "web.open", "web.close", "web.reset", "web.claimInterface",
    "web.releaseInterface", "web.selectConfiguration", "web.transferOut",
    "web.transferIn", "web.controlTransferOut", "web.controlTransferIn",
    "endpoint.transfer.out", "endpoint.transfer.in",
    "device.open", "device.close", "interface.claim",
)


def crc16(data, poly, init, reflect, xorout=0x0000):
    crc = init
    for byte in data:
        if reflect:
            crc ^= byte
            for _ in range(8):
                crc = (crc >> 1) ^ poly if crc & 1 else crc >> 1
        else:
            crc ^= byte << 8
            for _ in range(8):
                crc = ((crc << 1) ^ poly) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return (crc ^ xorout) & 0xFFFF


# CRC-16/USB is CRC-16/MODBUS with a final xor of 0xFFFF -- without that xorout
# the two entries computed the identical value (crc16() had no xorout
# parameter at all), so a frame protected by MODBUS was reported as matching
# both algorithm names, and a frame actually using USB's checksum could never
# be identified since the value this produced for it was simply wrong.
# Verified against the standard "123456789" check vectors: MODBUS -> 0x4B37,
# ARC -> 0xBB3D, CCITT-FALSE -> 0x29B1, XMODEM -> 0x31C3, USB -> 0xB4C8.
ALGOS = {
    "CRC-16/MODBUS": (0xA001, 0xFFFF, True, 0x0000),
    "CRC-16/ARC": (0xA001, 0x0000, True, 0x0000),
    "CRC-16/CCITT-FALSE": (0x1021, 0xFFFF, False, 0x0000),
    "CRC-16/XMODEM": (0x1021, 0x0000, False, 0x0000),
    "CRC-16/USB": (0xA001, 0xFFFF, True, 0xFFFF),
}


def hexdump(b, indent="    "):
    out = []
    for i in range(0, len(b), 16):
        row = b[i:i + 16]
        text = "".join(chr(x) if 32 <= x < 127 else "." for x in row)
        out.append(f"{indent}{i:04x}  {' '.join(f'{x:02x}' for x in row):<47}  {text}")
    return "\n".join(out)


def find_checksum(b):
    """Report any (algorithm, span, position) whose value appears in the frame."""
    hits = []
    for name, (poly, init, refl, xorout) in ALGOS.items():
        for start in range(0, 4):
            for end in range(start + 1, len(b) + 1):
                if end - start < 2:
                    continue
                span = b[start:end]
                if not any(span):
                    continue  # a run of zeros matches the padding, not a checksum
                value = crc16(span, poly, init, refl, xorout)
                if value == 0:
                    continue
                for pos in range(0, len(b) - 1):
                    if start <= pos < end:
                        continue
                    if b[pos:pos + 2] == value.to_bytes(2, "little"):
                        hits.append((name, start, end, pos, "LE"))
                    elif b[pos:pos + 2] == value.to_bytes(2, "big"):
                        hits.append((name, start, end, pos, "BE"))
    # 16-bit additive checksum, the shape DeepCool actually uses.
    for start in range(0, 4):
        for end in range(start + 1, len(b) - 1):
            span = b[start:end]
            if not any(span):
                continue
            total = sum(span) & 0xFFFF
            if total == 0:
                continue
            for pos in range(end, len(b) - 1):
                if b[pos:pos + 2] == total.to_bytes(2, "big"):
                    hits.append(("sum16", start, end, pos, "BE"))
                elif b[pos:pos + 2] == total.to_bytes(2, "little"):
                    hits.append(("sum16", start, end, pos, "LE"))

    # A byte-sum check is common in simple device protocols; test it too.
    for start in range(0, 4):
        for end in range(start + 1, len(b)):
            span = b[start:end]
            if not any(span):
                continue
            total = sum(span) & 0xFF
            if total == 0:
                continue
            for pos in range(end, len(b)):
                if b[pos] == total:
                    hits.append(("sum8", start, end, pos, "1B"))
                elif b[pos] == ((~total) & 0xFF):
                    hits.append(("~sum8", start, end, pos, "1B"))
    return hits


def main():
    if not os.path.exists(LOG):
        print(f"no capture at {LOG}")
        return 1
    events = [json.loads(line) for line in open(LOG)]
    # Every record the shim itself writes carries 't', but ui-tour.sh appends
    # its own tour.click markers to the same file with a bare printf that has
    # neither 'n' nor 't' -- if one of those is the last line (the app was
    # killed mid-settle after the final click), events[-1]['t'] threw and lost
    # the whole analysis instead of printing what it did capture.
    last_t = max((e.get('t', 0) for e in events), default=0)
    print(f"{len(events)} events over {last_t / 1000:.1f}s   ({LOG})\n")

    counts = collections.Counter(e["event"] for e in events)
    print("event counts")
    for name, n in counts.most_common(15):
        print(f"  {n:>7}  {name}")

    problems = [e for e in events if e["event"] in ("uncaughtException", "unhandledRejection")]
    if problems:
        print("\nfailures")
        seen = collections.Counter(
            (e.get("message") or e.get("reason", "")).split("\n")[0] for e in problems)
        for msg, n in seen.most_common(8):
            print(f"  {n:>3}  {msg[:130]}")

    usb = [e for e in events if e["event"] in USB_EVENTS]
    if usb:
        print(f"\nUSB conversation ({len(usb)} operations)")
        for e in usb[:60]:
            detail = ""
            if "data" in e and isinstance(e["data"], dict):
                detail = f"len={e['data'].get('len')} " + (e["data"].get("hex") or e["data"].get("head", ""))[:56]
            elif "requested" in e:
                detail = f"want {e['requested']}B"
            print(f"  t={e['t']:>7}ms  {e['event']:<24} ep={e.get('ep', '-'):<3} {detail}")
        if len(usb) > 60:
            print(f"  ... {len(usb) - 60} more")

    frames = collections.Counter()
    for e in events:
        if e["event"] in ("web.transferOut", "endpoint.transfer.out"):
            h = (e.get("data") or {}).get("hex")
            if h:
                frames[h] += 1
    if frames:
        print(f"\n{len(frames)} distinct outbound frame(s)")
        for h, n in frames.most_common():
            b = bytes.fromhex(h)
            print(f"\n  seen {n}x, {len(b)} bytes"
                  + (f", byte[0]=0x{b[0]:02x} byte[1]=0x{b[1]:02x}(={b[1]}) byte[2]=0x{b[2]:02x}" if len(b) > 2 else ""))
            print(hexdump(b, "    "))
            hits = find_checksum(b)
            if hits:
                print("    checksum candidates:")
                for name, start, end, pos, endian in hits[:10]:
                    print(f"      {name} over [{start}:{end}] appears at offset {pos} ({endian})")
            else:
                print("    no checksum found over any prefix span")

    stubs = collections.Counter(
        e["path"] for e in events if e["event"] == "stub.call")
    if stubs:
        print("\nstubbed native calls")
        for pathname, n in stubs.most_common(20):
            print(f"  {n:>7}  {pathname}")

    blobs = os.path.join(CAPTURE, "blobs")
    if os.path.isdir(blobs):
        files = sorted(os.listdir(blobs))
        if files:
            print(f"\n{len(files)} captured payload blob(s) in {blobs}")
            for name in files[:15]:
                p = os.path.join(blobs, name)
                with open(p, "rb") as f:
                    head = f.read(4)
                kind = "JPEG" if head[:2] == b"\xff\xd8" else \
                       "PNG" if head[:4] == b"\x89PNG" else \
                       "GIF" if head[:3] == b"GIF" else "?"
                print(f"  {os.path.getsize(p):>9}  {kind:<5} {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
