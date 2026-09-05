#!/usr/bin/env python3
"""Ask the bridge what PC serial the cooler has stored, and print it.

The app compares this against the host's BIOS serial and refuses to consider
the device bound when they differ -- it then re-runs its whole init once a
second. Seeding the harness's BIOS-serial stub with what the device already
holds makes the handshake pass without writing anything to the device (0x11,
which would rewrite it, stays refused by the bridge).
"""
import json, socket, struct, sys

sock_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/dc-usb-bridge.sock'

def call(s, req):
    b = json.dumps(req).encode()
    s.sendall(struct.pack('<I', len(b)) + b)
    n = struct.unpack('<I', s.recv(4))[0]
    buf = b''
    while len(buf) < n:
        buf += s.recv(n - len(buf))
    return json.loads(buf)

def frame(cmd):
    b = bytearray(48)
    b[0], b[1], b[2] = 0xAA, 0x2E, cmd
    b[42:46] = b'HIDC'
    s = sum(b[:46]) & 0xFFFF
    b[46], b[47] = s & 0xFF, s >> 8
    return bytes(b)

s = socket.socket(socket.AF_UNIX)
s.connect(sock_path)
call(s, {'op': 'out', 'ep': 1, 'hex': frame(0x12).hex()})
r = call(s, {'op': 'in', 'ep': 1, 'len': 64})
if not r.get('ok'):
    sys.exit('read failed: %s' % r.get('error'))
raw = bytes.fromhex(r['hex'])
serial = raw[4:36].rstrip(b'\x00').decode('ascii', 'replace').strip()
if not serial:
    sys.exit('device reported an empty serial')
print(serial)
