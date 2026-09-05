#!/usr/bin/env python3
"""
End-to-end check of the DeepCool MYSTIQUE Linux port.

Runs the app for real -- headless Electron, the recording shim, the fake sensor
service -- drives its whole feature set through IPC, then asserts on what came
out. Every check is a claim about behaviour that was measured, not about code
that exists.

  ./e2e.py            full run
  ./e2e.py --quick    skip the UI tour and the encoding sweep

Exit status is 0 only if every check passes.
"""
import json, os, re, shutil, subprocess, sys, time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get('DC_E2E_DIR', '/tmp/dc-e2e')
ASAR = os.environ.get('DC_ASAR', os.path.expanduser(
    '~/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c/DeepCool/resources/app.asar'))
CONFIG = os.path.expanduser('~/.config/DeepCool')

results = []          # (phase, name, ok, detail)
def check(phase, name, ok, detail=''):
    results.append((phase, name, bool(ok), detail))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('   ' + detail) if detail else ''))
    return bool(ok)

skips = []            # (phase, reason)
def skip(phase, reason):
    # A bare print() here (as this used to be, in four places) leaves no
    # trace in `results`: the summary's per-phase and total counts shrink to
    # whatever actually ran, with nothing distinguishing "41 checks, 0 failed"
    # because the DMI cache, the SuperIO rails and the whole hardware phase
    # were skipped from the same line printed by a full, green 71-check run.
    skips.append((phase, reason))
    print('  SKIP  ' + reason)

def run(cmd, env=None, timeout=400):
    e = dict(os.environ); e.update(env or {})
    return subprocess.run(cmd, cwd=HERE, env=e, capture_output=True, text=True, timeout=timeout)

def events(path):
    out = []
    with open(path) as fh:
        for line in fh:
            try: out.append(json.loads(line))
            except Exception: pass
    return out

def frames(evs, direction='web.transferOut'):
    """Command frames only: 48 bytes, AA 2E header, HIDC magic."""
    out = []
    for e in evs:
        if e.get('event') != direction: continue
        h = (e.get('data') or {}).get('hex') or ''
        if len(h) == 96 and h.startswith('aa2e') and h[84:92] == '48494443':
            out.append((e.get('ep'), bytes.fromhex(h)))
    return out

def sum16(b):
    return sum(b) & 0xFFFF

def jpeg_size(data):
    """(width, height) from a JPEG's SOF marker, or None. Baseline/progressive
    only (SOF0/SOF2, the only encoders ImageMagick's -quality path uses), read
    directly off the bytes so this needs no imaging library -- consistent
    with how the rest of this file parses everything else by hand."""
    i = 2  # past SOI (FFD8)
    n = len(data)
    while i + 9 < n:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seg_len = int.from_bytes(data[i + 2:i + 4], 'big')
        if marker in (0xC0, 0xC1, 0xC2, 0xC3):
            height = int.from_bytes(data[i + 5:i + 7], 'big')
            width = int.from_bytes(data[i + 7:i + 9], 'big')
            return (width, height)
        if marker == 0xD9 or seg_len < 2:
            break
        i += 2 + seg_len
    return None

# ---------------------------------------------------------------- phase 1
def preflight():
    print('\n[1] preflight')
    ok = os.path.exists(ASAR)
    check('preflight', 'app.asar present', ok, ASAR if not ok else '')
    if not ok:
        # The check above already says why; opening ASAR unconditionally
        # right after it turned a clean one-line FAIL (e.g. the Bottles
        # prefix not mounted) into an unhandled FileNotFoundError and a
        # traceback instead of main() ever reaching its own summary.
        skip('preflight', 'rest of preflight -- app.asar missing')
        return
    found = False
    with open(ASAR, 'rb') as fh:          # 312 MB; stream it rather than slurp
        tail = b''
        while True:
            chunk = fh.read(8 << 20)
            if not chunk: break
            if b'DC_CAPTURE_DIR' in tail + chunk: found = True; break
            tail = chunk[-32:]
    check('preflight', 'shim installed in asar', found)
    check('preflight', 'electron binary present', os.access(os.path.join(HERE, '.electron/electron'), os.X_OK))
    for mod in ('sensors', 'sysinfo', 'sensor-service', 'readynode'):
        r = run(['node', '-e', 'require("%s/impl/%s.js")' % (HERE, mod)])
        check('preflight', 'impl/%s.js loads' % mod, r.returncode == 0, r.stderr.strip()[:120])
    r = run(['pgrep', '-af', '[d]eepcool-cli|[d]eepcool-digital-linux'])
    check('preflight', 'no third-party deepcool daemon holding the device',
          r.returncode != 0, r.stdout.strip()[:120])

# ---------------------------------------------------------------- phase 2
def clean_state():
    print('\n[2] clean state')
    os.makedirs(SCRATCH, exist_ok=True)
    if os.path.isdir(CONFIG):
        # SCRATCH defaults to /tmp/dc-e2e -- most Linux setups mount /tmp as
        # tmpfs, so a reboot between "the suite deleted my config" and "I
        # noticed" erases the only backup along with it. This is the sole
        # copy of a real user's Pictures library, uploaded media and settings
        # for however long it sits here, so it belongs somewhere that
        # survives a reboot.
        bk_root = os.environ.get('DC_E2E_BACKUP_DIR',
                                  os.path.expanduser('~/.local/share/deepcool-e2e-backups'))
        os.makedirs(bk_root, exist_ok=True)
        bk = os.path.join(bk_root, 'config-backup-%d' % int(time.time()))
        # Electron leaves Singleton* as a dangling symlink and a unix socket;
        # neither survives a copy and neither is worth keeping.
        shutil.copytree(CONFIG, bk, ignore=shutil.ignore_patterns('Singleton*'))
        shutil.rmtree(CONFIG)
        check('clean', 'previous config backed up and cleared', True,
              '%s -- restore with: rm -rf %s && cp -a %s %s' % (bk, CONFIG, bk, CONFIG))
    else:
        check('clean', 'no previous config to clear', True)

# ---------------------------------------------------------------- phase 3
def full_flow():
    print('\n[3] full flow (headless, driver/full-flow.js)')
    cap = os.path.join(SCRATCH, 'capture')
    shutil.rmtree(cap, ignore_errors=True)
    os.makedirs(cap, exist_ok=True)
    env = {'DC_CAPTURE_DIR': cap, 'DC_DRIVER': os.path.join(HERE, 'driver/full-flow.js'),
           'DC_PIDS': '0x0009', 'DISPLAY': ''}
    r = run(['./run-only.sh', '130'], env=env, timeout=400)
    check('flow', 'run completed', 'stopped at timeout' in r.stdout or r.returncode == 0,
          r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr[-120:])
    return cap

def assert_capture(cap):
    print('\n[4] protocol assertions')
    evs = events(os.path.join(cap, 'usb.jsonl'))
    app_log = open(os.path.join(cap, 'app.log')).read() if os.path.exists(os.path.join(cap, 'app.log')) else ''

    # A failed handler logs event 'driver.invoke' with ok:false -- there is no
    # 'driver.invoke.failed' event anywhere in the shim, so checking for it
    # here always finds zero and this check could never fail. A missing
    # handler is 'driver.invoke.missing', which never carries 'ok' at all.
    invokes = [e for e in evs if e.get('event') == 'driver.invoke']
    ipc = sum(1 for e in invokes if e.get('ok') is True)
    bad_calls = [e for e in invokes if e.get('ok') is False]
    missing = sum(1 for e in evs if e.get('event') == 'driver.invoke.missing')
    check('flow', 'IPC calls driven', ipc >= 100, '%d calls' % ipc)
    check('flow', 'no IPC call failed', not bad_calls and missing == 0,
          '%d failed, %d missing%s' % (
              len(bad_calls), missing,
              ': ' + bad_calls[0].get('error', '') if bad_calls else ''))
    check('flow', 'flow reached the end', any(e.get('event') == 'flow.done' for e in evs))

    fr = frames(evs)
    check('proto', 'command frames captured', len(fr) >= 100, '%d frames' % len(fr))

    # Interface A and the interface-B frames that carry no percentage are honest
    # sum16 over bytes 0..45. The 0x01 sensor push is not: the app sums the
    # *values it meant to write*, and the memory percentage's fraction is wider
    # than the byte it gets stored in, so the surplus lands in the checksum's
    # high byte. See COMMANDS.md section 3.
    plain = [b for ep, b in fr if not (ep == 2 and b[2] == 0x01)]
    bad_ck = [b.hex() for b in plain if int.from_bytes(b[46:48], 'little') != sum16(b[:46])]
    check('proto', 'checksum is sum16 over bytes 0..45 (all but the sensor push)',
          not bad_ck, '%d bad of %d' % (len(bad_ck), len(plain)))

    push = [b for ep, b in fr if ep == 2 and b[2] == 0x01]
    lo_ok = all(b[46] == (sum16(b[:46]) & 0xFF) for b in push)
    check('proto', 'sensor-push checksum low byte is still the true sum', lo_ok,
          '%d frames' % len(push))
    corrupt = [b for b in push if int.from_bytes(b[46:48], 'little') != sum16(b[:46])]
    check('proto', 'sensor push carries the known checksum corruption',
          len(corrupt) > 0,
          '%d of %d frames the device answers with status 2' % (len(corrupt), len(push)))

    by_ep = defaultdict(set)
    for ep, b in fr: by_ep[ep].add(b[2])
    a_cmds, b_cmds = by_ep.get(1, set()), by_ep.get(2, set())
    want_a = {0x02,0x03,0x04,0x05,0x06,0x07,0x08,0x0b,0x0f,0x12,0x14,0x15,0x16,0x17}
    want_b = {0x01,0x0a,0x10}
    check('proto', 'interface A commands on endpoint 1', want_a <= a_cmds,
          'missing ' + ' '.join('0x%02x' % c for c in sorted(want_a - a_cmds)) if want_a - a_cmds
          else ' '.join('0x%02x' % c for c in sorted(a_cmds)))
    check('proto', 'interface B commands on endpoint 2', want_b <= b_cmds,
          'missing ' + ' '.join('0x%02x' % c for c in sorted(want_b - b_cmds)) if want_b - b_cmds
          else ' '.join('0x%02x' % c for c in sorted(b_cmds)))
    check('proto', 'no interface-B command leaked onto endpoint 1', not (want_b & a_cmds))

    # Nothing here decoded a single interface-A payload byte -- every check
    # above stops at "the checksum is honest" and "the right command numbers
    # appeared". driver/sweep-settings.js (which full_flow runs) drives
    # options.screenBrightness through 0, 50, 100, and COMMANDS.md documents
    # exactly how the app re-encodes that before it goes on the wire: `byte =
    # min(70, 21 + round(v / 2))` at payload offset 4 of command 0x02. Walk
    # the events in order, matching each 0x02 frame to whatever brightness
    # was most recently set, and check the actual byte against that formula.
    bright, seen = None, []
    for e in evs:
        if e.get('event') == 'sweep.set' and e.get('path') == 'options.screenBrightness':
            bright = e.get('value')
        elif e.get('event') == 'web.transferOut' and e.get('ep') == 1 and bright is not None:
            h = (e.get('data') or {}).get('hex') or ''
            if len(h) == 96 and h.startswith('aa2e') and h[4:6] == '02':
                b = bytes.fromhex(h)
                want = min(70, 21 + round(bright / 2))
                seen.append((bright, b[7], want))
    ok = bool(seen) and all(got == want for _, got, want in seen)
    check('proto', 'screen brightness is re-encoded per COMMANDS.md (21 + v/2, capped at 70)',
          ok, '; '.join('v=%s -> byte %d (want %d)' % s for s in seen) if seen
              else 'no 0x02 frame followed a brightness sweep step')

    # 0x14 is the media wipe; the app sends it as the first frame after 0x12.
    order = [b[2] for ep, b in fr if ep == 1]
    check('proto', '0x12 handshake then 0x14 wipe lead the session',
          order[:2] == [0x12, 0x14], ' '.join('0x%02x' % c for c in order[:3]))

    # sensors
    check('sensor', 'sensor push started', any(e.get('event') == 'sensor.push.start' for e in evs))
    check('sensor', 'system info delivered (not null)', 'systeminfo {' in app_log)
    m = re.search(r'systeminfo (\{.*\})', app_log)
    if m:
        si = json.loads(m.group(1))
        check('sensor', 'gpuInfo arrived as a list', isinstance(si.get('gpu'), list),
              type(si.get('gpu')).__name__)
        check('sensor', 'real machine reported', 'Ultra' in (si.get('cpuName') or '') or bool(si.get('cpuName')),
              si.get('cpuName', ''))
    check('sensor', 'no sensor read failure', not any(e.get('event') == 'sensor.read-failed' for e in evs))

    # The DMI figures are root-only at source; impl/dmi-cache.py makes them
    # readable, so when the cache exists they must actually come through.
    cache = os.environ.get('DC_DMI_CACHE',
                           os.path.expanduser('~/.config/deepcool-linux/dmi.json'))
    if os.path.exists(cache):
        r = run(['node', '-e',
                 'const s=require("%s/impl/sensors.js").read(),i=require("%s/impl/sysinfo.js")();'
                 'console.log(JSON.stringify([s["Memory Clock"].Value,i.ramSlotNum,'
                 'i.ramSlotOccupied,i.ramModuleManufacturer]))' % (HERE, HERE)])
        try: clk, slots, occ, mfr = json.loads(r.stdout.strip())
        except Exception: clk = slots = occ = 0; mfr = ''
        try: raw_mts = json.load(open(cache)).get('memoryClockMTs', 0)
        except Exception: raw_mts = 0
        # clk > 0 alone can't catch the doubling bug this port has already
        # shipped once (sensors.js halves the DMI cache's MT/s figure into a
        # bus clock; the app doubles whatever it's given before display, so
        # a display bug and a sensor bug can cancel out and still pass a
        # bare >0 check). Assert the actual relationship: clk is raw_mts/2,
        # rounded, within the same tolerance sensors.js's own rounding uses.
        check('sensor', 'memory clock comes through the DMI cache without root',
              clk > 0 and raw_mts > 0 and abs(clk - round(raw_mts / 2)) <= 1,
              '%s MT/s bus clock from a %s MT/s DIMM rating' % (clk, raw_mts))
        check('sensor', 'DIMM layout comes through the cache', slots > 0 and occ > 0,
              '%s slots, %s populated, %s' % (slots, occ, mfr))
    else:
        skip('sensor', 'DMI cache not written (run: sudo ./impl/dmi-cache.py)')
    # The three supply rails only exist once a SuperIO driver is bound. Where
    # one is, they must reach the wire -- that is the whole point of the
    # libsensors path in boardVolts(). Where none is, there is nothing to check.
    r = run(['node', '-e',
             'const s=require("%s/impl/sensors.js").read();'
             'console.log(JSON.stringify(["Motherboard v3 volt","Motherboard v5 volt",'
             '"Motherboard v12 volt"].map(k=>s[k].Value)))' % HERE])
    try: v3, v5, v12 = json.loads(r.stdout.strip())
    except Exception: v3 = v5 = v12 = 0
    superio = any(
        os.path.exists('/sys/class/hwmon/%s/name' % d)
        and open('/sys/class/hwmon/%s/name' % d).read().strip().startswith(('it86', 'it87', 'nct'))
        for d in os.listdir('/sys/class/hwmon'))
    if superio:
        check('sensor', 'the SuperIO rails are read and plausible',
              2.9 < v3 < 3.7 and 4.5 < v5 < 5.5 and 11.0 < v12 < 13.0,
              '%s / %s / %s V' % (v3, v5, v12))
    else:
        skip('sensor', 'no SuperIO hwmon bound; the rails have no source')

    check('sensor', 'data channel pipe listened without collision',
          not any(e.get('event') == 'pipe.listen-failed' for e in evs))

    # uploads: DCLd records must extract as real JPEGs
    ups = [e for e in evs if e.get('event') == 'upload.resources.after']
    # driver/upload-media.js tries three JPEG crops then one GIF, and
    # sys/get-resources' counts are cumulative across attempts -- so summing
    # jpg+gif and taking the max across every attempt reaches its highest
    # value on the *last* (GIF) attempt's record even when the GIF itself
    # never actually landed, because the three earlier JPEGs are still
    # sitting in the same cumulative count. That let the whole GIF half of
    # opencv.js (convertGifToJpeg, getGifImageData) break silently. Track
    # jpg and gif separately and require each to have actually grown.
    got_jpg = max([e.get('jpg') or 0 for e in ups] or [0])
    got_gif = max([e.get('gif') or 0 for e in ups] or [0])
    check('media', 'JPEG uploads landed in the library', got_jpg >= 1, '%d items' % got_jpg)
    check('media', 'GIF uploads landed in the library', got_gif >= 1, '%d items' % got_gif)
    # The transfer stream is the non-command traffic on the same endpoint,
    # recorded as 64-byte chunks; reassemble it and walk the DCLd records.
    raw = bytearray()
    for e in evs:
        if e.get('event') != 'web.transferOut': continue
        h = (e.get('data') or {}).get('hex') or ''
        if len(h) == 96 and h.startswith('aa2e') and h[84:92] == '48494443': continue
        raw += bytes.fromhex(h)
    dcld = 0; jpegs = 0; geos = []
    bad_jpeg_sums = []    # records whose complete JPEG failed sum16 == offset-9 field
    bad_header_sums = []  # records whose header (bytes 0..61) failed sum16 == offset-62 field
    off = 0
    while True:
        i = raw.find(b'DCLd', off)
        if i < 0: break
        dcld += 1
        n = int.from_bytes(raw[i+5:i+9], 'little')
        want = int.from_bytes(raw[i+9:i+11], 'little')
        body = bytes(raw[i+64:i+64+n])
        complete = len(body) == n and body[:2] == b'\xff\xd8' and body[-2:] == b'\xff\xd9'
        if complete:
            jpegs += 1
            geo = jpeg_size(body)
            if geo: geos.append(geo)
        # Checked for every record, not only ones that already passed the
        # "complete JPEG" test above -- sums_ok used to start True and could
        # only be set False from inside that same `if complete:` branch, so a
        # transfer regression that truncated every body ("jpegs != dcld"
        # correctly failed) still reported "every record checksum matches"
        # as a bare PASS, pointing away from the actual corruption.
        if not complete or sum16(body) != want:
            bad_jpeg_sums.append(i)
        # COMMANDS.md's second checksum -- sum16 of header bytes 0..61 against
        # the uint16 LE at offset 62 -- was never checked here at all, even
        # though the device verifies it too ("Both checksums verified
        # byte-exact on every captured transfer").
        if len(raw) >= i + 64:
            header = raw[i:i+62]
            header_want = int.from_bytes(raw[i+62:i+64], 'little')
            if sum16(header) != header_want:
                bad_header_sums.append(i)
        else:
            bad_header_sums.append(i)
        off = i + 4
    check('media', 'DCLd records found in the transfer stream', dcld >= 1, '%d records' % dcld)
    check('media', 'every record body is a complete JPEG', jpegs == dcld and dcld > 0,
          '%d/%d' % (jpegs, dcld))
    check('media', 'every record checksum matches its JPEG', not bad_jpeg_sums,
          '%d/%d bad' % (len(bad_jpeg_sums), dcld))
    check('media', 'every record header checksum matches (COMMANDS.md offset 62)',
          not bad_header_sums, '%d/%d bad' % (len(bad_header_sums), dcld))
    # COMMANDS.md's own measurements against the real cooler: every uploaded
    # frame -- still or GIF, landscape or portrait crop -- gets resized to the
    # panel's fixed 480x640 portrait geometry before it goes out. Nothing
    # before this asserted that geometry; a resize regression (aspect ratio
    # preserved instead of forced, wrong axis, opencv.js's -resize dropped)
    # would still pass every other media check here.
    check('media', 'every uploaded JPEG is the panel\'s native 480x640',
          bool(geos) and all(g == (480, 640) for g in geos),
          '%d/%d at 480x640: %s' % (sum(1 for g in geos if g == (480, 640)), len(geos),
                                     sorted(set(geos)) if geos else 'none decoded'))

    fatal = [l for l in app_log.splitlines() if 'FATAL' in l or 'Uncaught' in l]
    check('flow', 'no Chromium-level fatal error in the app log', not fatal, fatal[0][:100] if fatal else '')

    # A JS-level crash never reaches app.log at all: usb-shim.js installs
    # process.on('uncaughtException'/'unhandledRejection') handlers (so Node
    # doesn't print its own banner and exit) and logs the error to usb.jsonl
    # instead. Checking app.log for those checks a channel the app's own
    # errors are diverted away from -- measured against this repo's checked-in
    # capture, that log grep finds nothing while usb.jsonl holds 1680 recorded
    # unhandled rejections. Read the channel the errors actually go to.
    unhandled = [e for e in evs if e.get('event') in ('uncaughtException', 'unhandledRejection', 'driver.script-failed')]
    check('flow', 'no unhandled JS error in the app', not unhandled,
          '%d (first: %s)' % (len(unhandled), (unhandled[0].get('reason') or unhandled[0].get('error') or '')[:120]) if unhandled else '')

# ---------------------------------------------------------------- phase 5
import math
def js_round(x):
    """Math.round: half away from zero for positives, not Python's half-to-even."""
    return math.floor(x + 0.5)

FORMULAS = {
    'clock': lambda mhz: (lambda n: (n // 100, n % 100))(js_round(js_round(mhz) / 1000 * 100)),
}
def encoding_sweep():
    print('\n[5] wire encoding (0x01 slots 2 and 6)')
    plan = [
        {'CPU Clock': 1234.5, 'Memory Used': 1234, 'Memory Available': 8766},
        {'CPU Clock': 999,    'Memory Used': 2550, 'Memory Available': 7450},
        {'CPU Clock': 5678,   'Memory Used': 1,    'Memory Available': 2},
    ]
    plan = [p for p in plan for _ in range(5)]
    cap = os.path.join(SCRATCH, 'capture-enc')
    shutil.rmtree(cap, ignore_errors=True); os.makedirs(cap, exist_ok=True)
    env = {'DC_CAPTURE_DIR': cap, 'DC_PIDS': '0x0009', 'DISPLAY': '',
           'DC_SENSOR_SWEEP': json.dumps(plan, separators=(',', ':')), 'DC_SENSOR_PUSH_MS': '1000'}
    run(['./run-only.sh', '70'], env=env, timeout=200)

    cur = None; seen = defaultdict(Counter)
    for e in events(os.path.join(cap, 'usb.jsonl')):
        if e.get('event') == 'sensor.sweep':
            cur = e.get('values')
        elif e.get('event') == 'web.transferOut' and e.get('ep') == 2 and cur:
            h = (e.get('data') or {}).get('hex') or ''
            if len(h) == 96 and h[4:6] == '01':
                p = bytes.fromhex(h)[3:42]
                slot = lambda i: (p[3*i] | (p[3*i+1] << 8), p[3*i+2])
                seen[json.dumps(cur, sort_keys=True)][(slot(2), slot(6))] += 1
    check('encoding', 'sweep produced 0x01 frames', bool(seen), '%d distinct steps' % len(seen))
    for key, counter in seen.items():
        v = json.loads(key)
        (s2, s6), _ = counter.most_common(1)[0]
        exp6 = FORMULAS['clock'](v['CPU Clock'])
        check('encoding', 'clock %s MHz -> %s' % (v['CPU Clock'], exp6), tuple(s6) == exp6, 'got %s' % (s6,))
        pct = v['Memory Used'] / (v['Memory Used'] + v['Memory Available']) * 100
        # the app prints the double and parses its decimal digits, truncated to a byte
        txt = repr(pct)
        frac = int(txt.split('.')[1]) & 0xFF if '.' in txt else 0
        exp2 = (int(pct), frac)
        check('encoding', 'memory %.6f%% -> %s' % (pct, exp2), tuple(s2) == exp2, 'got %s' % (s2,))

# ---------------------------------------------------------------- phase 6
def ui_tour():
    print('\n[6] UI')
    shots = os.path.join(SCRATCH, 'shots')
    env = {'DC_SHOTDIR': shots, 'DC_CAPTURE_DIR': os.path.join(SCRATCH, 'capture-ui'),
           'DC_PIDS': '0x0009', 'DISPLAY': ''}
    r = run(['./ui-tour.sh', '01-dash:28,95 02-config:28,154 03-device:28,214 04-dash:28,95'],
            env=env, timeout=300)
    pngs = sorted(f for f in os.listdir(shots)) if os.path.isdir(shots) else []
    pngs = [p for p in pngs if p.endswith('.png') and p != 'xvfb.log']
    check('ui', 'four pages captured', len(pngs) >= 4, '%d shots' % len(pngs))
    for p in pngs[:4]:
        size = os.path.getsize(os.path.join(shots, p))
        check('ui', '%s is a painted window' % p, size > 20000, '%d bytes' % size)
    # Four existing, non-trivial-sized files pass even if every click in the
    # tour silently did nothing and all four are screenshots of the same
    # unchanged page -- nothing above compares them. The tour visits
    # dashboard -> config -> device -> dashboard specifically to prove
    # round-trip navigation works, so the three genuinely different
    # destinations should not be byte-identical to each other (the two
    # dashboard visits are EXPECTED to match -- that is the round trip
    # succeeding, not a bug).
    def shot_for(word):
        hit = [p for p in pngs if word in p]
        return open(os.path.join(shots, hit[0]), 'rb').read() if hit else None
    dash, config, device = shot_for('dash'), shot_for('config'), shot_for('device')
    if dash and config and device:
        distinct = len({dash, config, device}) == 3
        check('ui', 'dashboard, config and device pages are visually distinct', distinct,
              'identical byte-for-byte' if not distinct else 'all three differ')
    else:
        check('ui', 'dashboard, config and device pages are visually distinct', False,
              'could not find all three shots by name: %s' % pngs)
    evs = events(os.path.join(SCRATCH, 'capture-ui', 'usb.jsonl'))
    check('ui', 'main window was shown', any(e.get('event') == 'ui.force.show' for e in evs))
    check('ui', 'splash was dismissed', any(e.get('event') == 'ui.force.hide-splash' for e in evs))
    r2 = run(['grep', '-c', 'systeminfo {', os.path.join(SCRATCH, 'capture-ui', 'app.log')])
    check('ui', 'UI run also had live system info', (r2.stdout.strip() or '0') != '0', r2.stdout.strip())

# ---------------------------------------------------------------- phase 7
HW_SOCK = '/tmp/dc-e2e-bridge.sock'

def _bridge_call(sock, req):
    import struct
    b = json.dumps(req).encode()
    sock.sendall(struct.pack('<I', len(b)) + b)
    n = struct.unpack('<I', sock.recv(4))[0]
    buf = b''
    while len(buf) < n:
        buf += sock.recv(n - len(buf))
    return json.loads(buf)

def _frame(cmd, payload=b'', extra_hi=0):
    b = bytearray(48)
    b[0], b[1], b[2] = 0xAA, 0x2E, cmd
    b[3:3 + len(payload)] = payload[:39]
    b[42:46] = b'HIDC'
    v = (sum(b[:46]) + (extra_hi << 8)) & 0xFFFF
    b[46], b[47] = v & 0xFF, v >> 8
    return bytes(b)

def hardware():
    """Everything above drives a synthetic device. This drives the cooler."""
    print('\n[7] real hardware')
    r = run(['bash', '-c', 'lsusb | grep -q 3633:0009'])
    if r.returncode != 0:
        skip('hardware', 'no MYSTIQUE on the bus')
        return
    import socket, signal, subprocess as sp, struct
    for f in (HW_SOCK,):
        try: os.unlink(f)
        except FileNotFoundError: pass
    env = dict(os.environ); env['DC_FIX_CHECKSUM'] = '1'
    bridge = sp.Popen(['python3', os.path.join(HERE, 'impl/usb-bridge.py'), HW_SOCK],
                      cwd=HERE, env=env, stdout=sp.PIPE, stderr=sp.PIPE, text=True)
    try:
        for _ in range(50):
            if os.path.exists(HW_SOCK): break
            time.sleep(0.1)
        why = ''
        if not os.path.exists(HW_SOCK):
            bridge.poll()
            why = (bridge.stderr.read() or '').strip().splitlines()[-1:] or ['']
            why = why[0][:120]
            if 'Busy' in why or 'busy' in why:
                why += '  (something else is holding the device -- a stray bridge?)'
        check('hardware', 'bridge came up', os.path.exists(HW_SOCK), why)
        if not os.path.exists(HW_SOCK):
            return
        s = socket.socket(socket.AF_UNIX); s.connect(HW_SOCK)
        check('hardware', 'bridge holds the device', _bridge_call(s, {'op': 'ping'}).get('ok'))

        _bridge_call(s, {'op': 'out', 'ep': 1, 'hex': _frame(0x12).hex()})
        rep = _bridge_call(s, {'op': 'in', 'ep': 1, 'len': 64})
        raw = bytes.fromhex(rep.get('hex', '')) if rep.get('ok') else b''
        check('hardware', 'device answers the 0x12 handshake', len(raw) == 48, '%d bytes' % len(raw))
        if len(raw) == 48:
            check('hardware', 'reply header is 0x55, not the harness 0xAA', raw[0] == 0x55,
                  '0x%02x' % raw[0])
            check('hardware', 'reply echoes the command with status 0',
                  raw[2] == 0x12 and raw[3] == 0, 'cmd 0x%02x status %d' % (raw[2], raw[3]))
            check('hardware', 'reply checksum is sum16 over bytes 0..45',
                  int.from_bytes(raw[46:48], 'little') == sum16(raw[:46]))
            check('hardware', 'device reports a stored PC serial',
                  bool(raw[4:36].rstrip(b'\x00')), raw[4:36].rstrip(b'\x00').decode('ascii', 'replace'))

        out = _bridge_call(s, {'op': 'out', 'ep': 1, 'hex': _frame(0x14).hex()})
        check('hardware', 'the media-erase command 0x14 is refused',
              out.get('refused') == '0x14', str(out))
        rep = _bridge_call(s, {'op': 'in', 'ep': 1, 'len': 64})
        check('hardware', 'a refused command still gets an answer, so the app continues',
              rep.get('synthetic') is True)

        # The app's broken sensor checksum, with and without the repair.
        payload = (bytes([45, 0, 0]) + bytes([30, 0, 0]) + bytes([33, 0, 85])
                   + bytes(9) + bytes([3, 0, 20]) + bytes(18))
        _bridge_call(s, {'op': 'out', 'ep': 2, 'hex': _frame(0x01, payload, extra_hi=21).hex()})
        rep = _bridge_call(s, {'op': 'in', 'ep': 2, 'len': 64})
        st = bytes.fromhex(rep['hex'])[3] if rep.get('ok') else -1
        check('hardware', 'the repair makes the cooler accept the sensor push', st == 0,
              'status %d' % st)
        s.close()
    finally:
        bridge.send_signal(signal.SIGTERM)
        try: bridge.wait(timeout=5)
        except Exception: bridge.kill()
        try: os.unlink(HW_SOCK)
        except FileNotFoundError: pass

    # ... and the same frame unrepaired, which is what the app really sends.
    env2 = dict(os.environ); env2['DC_FIX_CHECKSUM'] = '0'
    bridge = sp.Popen(['python3', os.path.join(HERE, 'impl/usb-bridge.py'), HW_SOCK],
                      cwd=HERE, env=env2, stdout=sp.PIPE, stderr=sp.PIPE, text=True)
    try:
        for _ in range(50):
            if os.path.exists(HW_SOCK): break
            time.sleep(0.1)
        # The first bridge block (above) guards its connect exactly this way;
        # this one used to go straight to socket.connect(), which raises
        # FileNotFoundError with a bare traceback -- killing the whole suite,
        # every later phase included -- instead of one clean FAIL, whenever
        # this second bridge can't claim the device (the first bridge's
        # usbfs teardown still in flight, or a stray bridge from an earlier
        # crashed run still holding 3633:0009).
        why = ''
        if not os.path.exists(HW_SOCK):
            bridge.poll()
            why = (bridge.stderr.read() or '').strip().splitlines()[-1:] or ['']
            why = why[0][:120]
            if 'Busy' in why or 'busy' in why:
                why += '  (something else is holding the device -- a stray bridge?)'
        if check('hardware', 'second bridge came up', os.path.exists(HW_SOCK), why):
            s = socket.socket(socket.AF_UNIX); s.connect(HW_SOCK)
            _bridge_call(s, {'op': 'out', 'ep': 2, 'hex': _frame(0x01, payload, extra_hi=21).hex()})
            rep = _bridge_call(s, {'op': 'in', 'ep': 2, 'len': 64})
            st = bytes.fromhex(rep['hex'])[3] if rep.get('ok') else -1
            check('hardware', "unrepaired, the cooler rejects it with status 2 (the app's bug)",
                  st == 2, 'status %d' % st)
            s.close()
    finally:
        bridge.send_signal(signal.SIGTERM)
        try: bridge.wait(timeout=5)
        except Exception: bridge.kill()
        try: os.unlink(HW_SOCK)
        except FileNotFoundError: pass

    # Finally the app itself, end to end, against the cooler.
    cap = os.path.join(SCRATCH, 'capture-hw')
    shutil.rmtree(cap, ignore_errors=True); os.makedirs(cap, exist_ok=True)
    r = run(['./run-real.sh', '75'], env={'DC_CAPTURE_DIR': cap, 'DISPLAY': ''}, timeout=200)
    evs = events(os.path.join(cap, 'usb.jsonl')) if os.path.exists(os.path.join(cap, 'usb.jsonl')) else []
    # A run whose bridge never came up (run-real.sh exits before Electron even
    # starts) leaves evs == []. Every check below that reads "not any(...)" or
    # "not bad" over an empty list passes vacuously in that state -- this used
    # to let two of the four checks report PASS from a run that never
    # happened at all. Assert the run actually produced traffic first, and
    # skip the negatives (not the positives -- inits==1 and pushes>10 already
    # correctly fail on empty data) when it did not.
    ran = check('hardware', 'the app ran against the cooler and produced traffic',
                 len(evs) > 100, '%d events, run-real.sh exit %s' % (len(evs), r.returncode))
    inits = sum(1 for ep, b in frames(evs) if b[2] == 0x12)
    check('hardware', 'the app initialises the device once, not in a loop', inits == 1,
          '%d handshakes' % inits)
    last, bad, pushes = None, [], 0
    for e in evs:
        if e.get('event') == 'web.transferOut':
            h = (e.get('data') or {}).get('hex') or ''
            if len(h) == 96 and h.startswith('aa2e'):
                last = h[4:6]
                if last == '01': pushes += 1
        elif e.get('event') == 'web.transferIn':
            hx = (e.get('reply') or {}).get('hex') or ''
            if len(hx) >= 8 and int(hx[6:8], 16) != 0:
                bad.append((last, int(hx[6:8], 16)))
    if ran:
        check('hardware', 'the cooler accepts every frame the app sends', not bad,
              '%d rejected' % len(bad))
    check('hardware', 'sensor readings are reaching the panel', pushes > 10, '%d pushes' % pushes)
    if ran:
        check('hardware', 'no read fell back to a canned reply',
              not any(e.get('event') == 'bridge.in-fallback' for e in evs))


# ---------------------------------------------------------------- main
def main():
    quick = '--quick' in sys.argv
    t0 = time.time()
    preflight()
    clean_state()
    cap = full_flow()
    assert_capture(cap)
    if quick:
        skip('encoding', "--quick: encoding_sweep() did not run")
        skip('ui', "--quick: ui_tour() did not run")
    else:
        encoding_sweep()
        ui_tour()
        if '--no-hw' in sys.argv:
            skip('hardware', '--no-hw: hardware() did not run')
        else:
            hardware()

    print('\n' + '=' * 64)
    per = defaultdict(lambda: [0, 0])
    for phase, _, ok, _ in results:
        per[phase][0 if ok else 1] += 1
    skip_per = Counter(phase for phase, _ in skips)
    for phase in sorted(set(per) | set(skip_per)):
        p, f = per.get(phase, [0, 0])
        s = skip_per.get(phase, 0)
        line = '  %-10s %2d passed, %d failed' % (phase, p, f)
        if s: line += ', %d skipped' % s
        print(line)
    failed = [r for r in results if not r[2]]
    print('=' * 64)
    summary = '  %d checks, %d failed, %.0fs' % (len(results), len(failed), time.time() - t0)
    # "68 checks, 0 failed" reads as the whole suite ran clean -- it says
    # nothing about the checks that were never attempted because a phase (or
    # a SKIP inside one) was bypassed. Naming how many were skipped, and
    # why, next to that headline number is the whole fix: a shrunk suite and
    # a fully green one no longer look identical here.
    if skips:
        summary += ', %d skipped' % len(skips)
    print(summary)
    if skips:
        print('\nskipped (not run, not counted as pass or fail):')
        for phase, reason in skips:
            print('  [%s] %s' % (phase, reason))
    if failed:
        print('\nfailures:')
        for phase, name, _, detail in failed:
            print('  [%s] %s   %s' % (phase, name, detail))
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(main())
