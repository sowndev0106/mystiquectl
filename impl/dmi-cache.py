#!/usr/bin/env python3
"""
Cache the SMBIOS memory tables so the app can read them without root.

/sys/firmware/dmi is mode 0400, so memory speed and the DIMM layout are
invisible to a normally-launched app -- the dashboard shows "0 MHz" and the
Computer Configuration page leaves Memory blank. None of it changes while the
machine is running, so reading it once as root and caching it is enough.

  sudo ./impl/dmi-cache.py            write the cache
  ./impl/dmi-cache.py --show          print what is cached

The cache holds only what the app displays: configured speed, slot count,
populated count, manufacturer. No serial numbers.
"""
import json, os, pwd, sys, glob, time

def _home():
    """Under sudo, ~ is /root -- but the cache is for the user who will run the
    app, so resolve to their home, not the one sudo handed us."""
    user = os.environ.get('SUDO_USER')
    if user:
        try:
            return pwd.getpwnam(user).pw_dir
        except KeyError:
            pass
    return os.path.expanduser('~')


HOME = _home()
CACHE = os.environ.get('DC_DMI_CACHE', os.path.join(HOME, '.config/deepcool-linux/dmi.json'))
OWNER = os.environ.get('SUDO_UID')


def _target_ids():
    """(uid, gid) of the user this cache is for, or None when not run under
    sudo (nothing to drop to)."""
    if not OWNER:
        return None
    gid = os.environ.get('SUDO_GID')
    if gid:
        return int(OWNER), int(gid)
    try:
        return int(OWNER), pwd.getpwuid(int(OWNER)).pw_gid
    except KeyError:
        return int(OWNER), int(OWNER)


def fingerprint():
    """A cheap, world-readable identity for the board this cache describes.
    /sys/class/dmi/id/* is mode 0444 -- no root needed -- and changes when the
    motherboard or its BIOS is replaced, which is the one case where a value
    frozen at write time ("None of it changes while the machine is running")
    stops being true."""
    def read1(name):
        try:
            with open('/sys/class/dmi/id/' + name) as fh:
                return fh.read().strip()
        except OSError:
            return ''
    return '|'.join(read1(n) for n in ('board_vendor', 'board_name', 'bios_date'))


def dmi_string(buf, index):
    if not index:
        return ''
    off = buf[1]
    i = 1
    while off < len(buf):
        end = buf.find(b'\x00', off)
        if end < 0 or end == off:
            break
        if i == index:
            return buf[off:end].decode('latin1').strip()
        off, i = end + 1, i + 1
    return ''


def word(buf, flen, off, ext_off):
    """flen is the structure's own Length byte (buf[1]) -- the formatted
    area's real size. len(buf) is not a valid bound here: the kernel's
    dmi-sysfs raw file is formatted area *plus* string table, and on an
    SMBIOS revision older than the field being read, that offset lands in the
    strings, not past the end of the buffer. A DDR3-era board (type-17 Length
    0x1C, no Configured Memory Speed field) with a device locator like
    "DIMM0" would otherwise read two ASCII bytes at 0x20 as a little-endian
    speed and report ~48 MT/s instead of falling through to the real value at
    0x15."""
    if flen < off + 2:
        return 0
    v = int.from_bytes(buf[off:off + 2], 'little')
    if v != 0xFFFF:
        return v
    return int.from_bytes(buf[ext_off:ext_off + 4], 'little') if flen >= ext_off + 4 else 0


def collect():
    devices = []
    for path in sorted(glob.glob('/sys/firmware/dmi/entries/17-*/raw')):
        with open(path, 'rb') as fh:
            devices.append(fh.read())
    if not devices:
        raise SystemExit('no SMBIOS type-17 structures readable -- run me as root')
    speed, manufacturer, occupied = 0, '', 0
    for b in devices:
        if len(b) < 2 or b[1] < 0x18:
            continue
        flen = b[1]
        size = int.from_bytes(b[0x0C:0x0E], 'little')
        if size == 0x7FFF and flen >= 0x20:
            size = int.from_bytes(b[0x1C:0x20], 'little')
        # 0 is "no module in this socket" (really empty); 0xFFFF is "a module
        # is here, size unknown" -- SMBIOS distinguishes them on purpose, and
        # this used to fold both into "not occupied", undercounting
        # ramSlotOccupied on hardware that reports the latter.
        if not size:
            continue
        occupied += 1
        if not speed:
            speed = word(b, flen, 0x20, 0x58) or word(b, flen, 0x15, 0x54)
        if not manufacturer:
            manufacturer = dmi_string(b, b[0x17])
    return {'memoryClockMTs': speed, 'ramSlotNum': len(devices),
            'ramSlotOccupied': occupied, 'ramModuleManufacturer': manufacturer}


def main():
    if '--show' in sys.argv:
        try:
            st = os.stat(CACHE)
            cached = json.load(open(CACHE))
        except OSError:
            raise SystemExit('no cache at %s' % CACHE)
        age_h = (time.time() - st.st_mtime) / 3600
        stale = cached.get('boardFingerprint') and cached.get('boardFingerprint') != fingerprint()
        print(json.dumps(cached, indent=2))
        print('-- written %.1fh ago%s' % (age_h, ', for a DIFFERENT board (stale)' if stale else ''))
        return
    data = collect()
    data['boardFingerprint'] = fingerprint()
    data['writtenAt'] = int(time.time())

    # This runs as root (sudo ./impl/dmi-cache.py), and CACHE is either
    # DC_DMI_CACHE verbatim from the invoking user's environment or a path
    # under their home -- neither validated before. Concretely:
    # `ln -sf /etc/sudoers.d/zz ~/.config/deepcool-linux/dmi.json; sudo
    # ./impl/dmi-cache.py` used to truncate, chmod 0644 and chown back
    # whatever that symlink pointed at, using root's privileges the whole
    # way. Refusing a target that does not resolve under the target user's
    # home closes the "point it somewhere else entirely" half; dropping to
    # that user's uid/gid before ever touching the filesystem closes the
    # "it's a symlink" half, since every operation after this line runs with
    # only that user's own permissions -- root never opens, follows, chmods
    # or chowns anything.
    real_home = os.path.realpath(HOME)
    real_dir = os.path.realpath(os.path.dirname(CACHE) or '.')
    if os.path.commonpath([real_home, real_dir]) != real_home:
        raise SystemExit('refusing to write outside %s: %s (resolves to %s)'
                          % (real_home, CACHE, real_dir))

    ids = _target_ids()
    if ids:
        uid, gid = ids
        os.setresgid(gid, gid, gid)
        os.setresuid(uid, uid, uid)

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    # O_NOFOLLOW makes the open itself the check: if CACHE is a symlink by
    # the time we get here (a TOCTOU race, not just the simple case above),
    # this raises ELOOP instead of writing through it.
    fd = os.open(CACHE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
    os.fchmod(fd, 0o644)  # belt-and-braces against umask
    with os.fdopen(fd, 'w') as fh:  # takes ownership of fd; closes it either way
        json.dump(data, fh, indent=2)
    print('cached to %s: %s' % (CACHE, json.dumps(data)))


if __name__ == '__main__':
    main()
