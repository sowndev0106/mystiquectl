#!/usr/bin/env python3
"""
Owns the real MYSTIQUE and lends it to the shim over a Unix socket.

The recording shim replaces the `usb` module wholesale, so the app has always
been talking to a synthetic device. This is the other half: a small daemon that
holds the actual 3633:0009 and forwards the app's bulk transfers to it, so what
the UI does reaches the panel.

  ./impl/usb-bridge.py [socket-path]

Protocol, both directions: 4-byte little-endian length, then JSON.
  {"op":"out","ep":1,"hex":"aa2e.."}   -> {"ok":true,"n":48}
  {"op":"in","ep":1,"len":64}          -> {"ok":true,"hex":"552e.."}
  {"op":"ping"}                        -> {"ok":true,"device":"3633:0009"}

Destructive commands are refused by default and answered with a synthetic
success so the app's flow continues:

  0x14  erase every stored image and animation -- the app sends this as the
        first frame of every session, so without the guard simply starting the
        app would wipe the cooler's media store.
  0x13  the same erase followed by an interrupt-masking reset.
  0x11  overwrite the PC serial the device has stored, which is what a Windows
        install binds to.

DC_USB_ALLOW=0x14,0x11 lets specific ones through. Nothing else is filtered.
"""
import json, os, socket, struct, sys, threading
import usb.core, usb.util

VID, PID = 0x3633, 0x0009
DEFAULT_SOCK = os.environ.get('DC_USB_SOCK', '/tmp/dc-usb-bridge.sock')
GUARDED = {0x11: 'write PC serial', 0x13: 'erase media + reset', 0x14: 'erase all media'}
ALLOWED = {int(x, 16) for x in os.environ.get('DC_USB_ALLOW', '').replace(' ', '').split(',') if x}

lock = threading.Lock()
repaired = {}          # command byte -> how many frames needed their sum fixed
dev = None
synthetic = []          # replies queued for commands we refused to forward


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def open_device():
    d = usb.core.find(idVendor=VID, idProduct=PID)
    if d is None:
        raise SystemExit('no DeepCool %04x:%04x on the bus' % (VID, PID))
    try:
        if d.is_kernel_driver_active(0):
            d.detach_kernel_driver(0)
    except (NotImplementedError, usb.core.USBError):
        pass
    usb.util.claim_interface(d, 0)
    return d


def synth_reply(cmd, size=64):
    """A well-formed device answer, so refusing a frame does not stall the app."""
    b = bytearray(size)
    b[0], b[1], b[2], b[3] = 0x55, size - 2, cmd, 0
    b[size - 6:size - 2] = b'HIDC'
    s = sum(b[:size - 2]) & 0xFFFF
    b[size - 2] = s & 0xFF
    b[size - 1] = s >> 8
    return bytes(b)


def repair_checksum(raw):
    """Fix the app's broken sensor-push checksum on the way out.

    The app sums the values it meant to write rather than the bytes it wrote,
    and the memory percentage's fraction is wider than the byte it is stored
    in, so the surplus lands in the checksum's high byte. The cooler verifies
    that sum and answers status 2, throwing the reading away -- measured here
    as 84 rejections out of 84 pushes before this. Recomputing it over the
    bytes actually being sent is all it takes. DC_FIX_CHECKSUM=0 to watch the
    unrepaired behaviour instead.
    """
    want = sum(raw[:len(raw) - 2]) & 0xFFFF
    have = int.from_bytes(raw[len(raw) - 2:], 'little')
    if want == have:
        return raw, False
    fixed = bytearray(raw)
    fixed[len(raw) - 2] = want & 0xFF
    fixed[len(raw) - 1] = want >> 8
    return bytes(fixed), True


def is_command_frame(raw):
    return (len(raw) >= 8 and raw[0] == 0xAA and raw[1] == len(raw) - 2
            and raw[len(raw) - 6:len(raw) - 2] == b'HIDC')


def handle(req):
    op = req.get('op')
    if op == 'ping':
        return {'ok': True, 'device': '%04x:%04x' % (VID, PID)}

    if op == 'out':
        raw = bytes.fromhex(req['hex'])
        if is_command_frame(raw):
            cmd = raw[2]
            if cmd in GUARDED and cmd not in ALLOWED:
                log('REFUSED 0x%02x (%s) -- set DC_USB_ALLOW=0x%02x to permit'
                    % (cmd, GUARDED[cmd], cmd))
                synthetic.append(synth_reply(cmd))
                return {'ok': True, 'n': len(raw), 'refused': '0x%02x' % cmd}
            if os.environ.get('DC_FIX_CHECKSUM', '1') != '0':
                raw, changed = repair_checksum(raw)
                if changed:
                    repaired[cmd] = repaired.get(cmd, 0) + 1
                    if repaired[cmd] == 1:
                        log('repairing the checksum on 0x%02x -- the cooler was '
                            'answering status 2 and dropping it' % cmd)
        with lock:
            n = dev.write(req.get('ep', 1), raw, timeout=req.get('timeout', 2000))
        return {'ok': True, 'n': int(n)}

    if op == 'in':
        if synthetic:
            return {'ok': True, 'hex': synthetic.pop(0).hex(), 'synthetic': True}
        try:
            with lock:
                data = dev.read(0x80 | req.get('ep', 1), req.get('len', 64),
                                timeout=req.get('timeout', 1200))
            return {'ok': True, 'hex': bytes(data).hex()}
        except usb.core.USBError as e:
            return {'ok': False, 'error': e.strerror or str(e)}

    return {'ok': False, 'error': 'unknown op %r' % op}


def serve(conn):
    buf = b''
    while True:
        while len(buf) < 4:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
        (n,) = struct.unpack('<I', buf[:4])
        while len(buf) < 4 + n:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
        req, buf = json.loads(buf[4:4 + n]), buf[4 + n:]
        try:
            res = handle(req)
        except Exception as e:                      # keep the app moving
            res = {'ok': False, 'error': str(e)}
        out = json.dumps(res).encode()
        conn.sendall(struct.pack('<I', len(out)) + out)


def main():
    global dev
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOCK
    dev = open_device()
    log('holding %04x:%04x, serving %s' % (VID, PID, path))
    if ALLOWED:
        log('allowed through guard: ' + ', '.join('0x%02x' % c for c in sorted(ALLOWED)))
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(path)
    # A client here can write arbitrary raw USB frames to the real cooler --
    # everything except the specific 0x11/0x13/0x14 guard -- so 0o666 handed
    # that to every local account on the machine, at a fixed, guessable path
    # in world-writable /tmp. Every legitimate caller (run-real.sh,
    # ui-tour-real.sh, e2e.py, this same user's own scripts) runs as the same
    # uid that started the bridge, so owner-only is enough and changes
    # nothing for them.
    os.chmod(path, 0o600)
    srv.listen(4)
    try:
        while True:
            conn, _ = srv.accept()
            threading.Thread(target=serve, args=(conn,), daemon=True).start()
    finally:
        usb.util.release_interface(dev, 0)
        try: os.unlink(path)
        except OSError: pass


if __name__ == '__main__':
    main()
