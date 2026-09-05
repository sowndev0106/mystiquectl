#!/usr/bin/env python3
"""Show which command frames each UI click produced.

The tour writes a marker into the capture stream before every click, so this
reads the stream in order and prints, per click, the command frames that
followed it. That is the direct evidence for what a control is wired to.
"""
import json, sys, os

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'capture', 'usb.jsonl')

def cmd_frame(hexs):
    b = bytes.fromhex(hexs)
    if len(b) < 8 or b[0] != 0xAA:
        return None
    if b[-6:-2] != b'HIDC':
        return None
    return b

label = '(before any click)'
pending = []

def flush():
    if not pending:
        return
    print(f'\n{label}')
    for b in pending:
        payload = b[3:-6]
        # trailing zeros carry meaning here, so show a fixed window
        print(f'    0x{b[2]:02x}  {payload[:8].hex(" ")}  ...  sum={b[-2] | b[-1] << 8:#06x}')
    pending.clear()

for line in open(path, errors='replace'):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    ev = e.get('event')
    if ev == 'tour.click':
        flush()
        label = f"click {e['label']} @ {e['x']},{e['y']}"
    elif ev == 'web.transferOut':
        # Settings and image transfer go over endpoint 1; the 1 Hz telemetry
        # push runs continuously on endpoint 2 regardless of what is clicked.
        # Without this filter, whichever click's window a sensor tick landed
        # in got credited with producing it (COMMANDS.md: "Settings and image
        # transfer go over endpoint 1; the telemetry push ... goes over
        # endpoint 2").
        if e.get('ep') != 1:
            continue
        d = (e.get('data') or {}).get('hex')
        if isinstance(d, str):
            b = cmd_frame(d)
            if b:
                pending.append(b)
flush()
