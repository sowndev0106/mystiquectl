#!/usr/bin/env python3
"""Install / remove the recording USB shim inside DeepCool's app.asar.

    ./shim.py status
    ./shim.py install
    ./shim.py uninstall

The shim replaces node_modules/usb/dist/index.js -- the `main` of the `usb`
package, so every `require('usb')` in the app resolves to it -- and prepends a
`require("usb")` to the app's entry point so it loads first.

Loading first is not cosmetic. The shim rewrites Windows-style paths by
wrapping the fs functions in place, and graceful-fs (under fs-extra) captures
its own references to those functions when it loads. Load the shim after that
and half the app's writes bypass it, which puts the temporary files in one
directory tree and the finished ones in another.

The original archive is kept next to it as app.asar.orig and restored by
`uninstall`.

Safe to run repeatedly: install always repacks from the pristine backup.
"""

import contextlib
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asar  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
# Default assumes a Bottles (Flatpak Wine) prefix, since that is what this was
# developed against -- but the extraction path depends entirely on which Wine
# frontend and prefix layout a given user has, so every other runner in this
# repo (run.sh, run-only.sh, run-real.sh, ui-tour.sh, e2e.py) already lets
# DC_ASAR override it. This used to be the one script that didn't, which
# silently pointed every install/uninstall/status at the maintainer's own
# Bottles path no matter where anyone else's app.asar actually was.
BOTTLE = os.path.expanduser(
    "~/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c"
)
_DEFAULT_ASAR = os.path.join(BOTTLE, "DeepCool", "resources", "app.asar")
ASAR = os.environ.get("DC_ASAR", _DEFAULT_ASAR)
BACKUP = ASAR + ".orig"
TARGET = "/node_modules/usb/dist/index.js"
ENTRY = "/out/main/index.js"
ENTRY_PRELUDE = b'require("usb");  // recording shim, loaded before any app module\n' 
SHIM = os.path.join(HERE, "shim", "usb-shim.js")
# C:\deepcool-capture is the shim's OWN fallback (shim/usb-shim.js) for when
# DC_CAPTURE_DIR is unset and it is actually running under Wine -- but every
# runner in this repo (run-only.sh, run-real.sh, run-ui.sh, ui-tour.sh, e2e.py)
# sets DC_CAPTURE_DIR explicitly to a directory in the repo, so that bottle
# path is never where a real recording lands. status() used to look there
# unconditionally and report "none yet" next to thousands of real events
# sitting in ./capture. Match run-only.sh's own default instead.
CAPTURE = os.environ.get("DC_CAPTURE_DIR", os.path.join(HERE, "capture"))


def human(n):
    return f"{n / 1048576:.1f} MB"


def installed():
    if not os.path.exists(ASAR):
        return False
    fh, base, header = asar.read(ASAR)
    try:
        meta = dict(asar.walk(header)).get(TARGET)
        if not meta:
            return False
        return b"DC_CAPTURE_DIR" in asar.read_file(fh, base, meta)
    finally:
        fh.close()


def status():
    if not os.path.exists(ASAR):
        print(f"app.asar not found at {ASAR}")
        return 1
    print(f"app.asar   {ASAR}  ({human(os.path.getsize(ASAR))})")
    print(f"backup     {'present' if os.path.exists(BACKUP) else 'none'}"
          + (f"  ({human(os.path.getsize(BACKUP))})" if os.path.exists(BACKUP) else ""))
    print(f"shim       {'INSTALLED' if installed() else 'not installed'}")
    log = os.path.join(CAPTURE, "usb.jsonl")
    if os.path.exists(log):
        with open(log, "rb") as f:
            lines = sum(1 for _ in f)
        print(f"capture    {log}  ({lines} events, {human(os.path.getsize(log))})")
    else:
        print(f"capture    none yet ({log})")
    return 0


def _asar_is_complete(path):
    """A truncated .asar still has a readable header -- the header lives in
    the first few MB and walk() only reads JSON, not file bodies -- so
    os.path.exists plus a successful asar.read() proves nothing. Confirm the
    file is at least as long as the header claims the last entry needs."""
    try:
        fh, base, header = asar.read(path)
    except Exception:
        return False
    try:
        need = base
        for _, meta in asar.walk(header):
            if meta.get("unpacked"):
                continue
            need = max(need, base + int(meta["offset"]) + int(meta["size"]))
    finally:
        fh.close()
    return os.path.getsize(path) >= need


def install():
    if not os.path.exists(ASAR):
        print(f"error: {ASAR} not found")
        return 1
    if os.path.exists(BACKUP) and not _asar_is_complete(BACKUP):
        print(f"error: {BACKUP} exists but is truncated or corrupt "
              f"({human(os.path.getsize(BACKUP))}) -- refusing to repack from it.\n"
              f"If app.asar is still the untouched original, move the backup aside and "
              f"re-run; otherwise DeepCool needs reinstalling.")
        return 1
    if not os.path.exists(BACKUP):
        print(f"backing up -> {BACKUP} ({human(os.path.getsize(ASAR))}) ...")
        # Non-atomic here would leave a short-but-present app.asar.orig on any
        # interruption (Ctrl-C, power loss, disk full) -- indistinguishable
        # from a real backup to the exists() check above, and the only copy
        # of the untouched app. Write to a sibling name and fsync before the
        # rename makes "the file is at BACKUP" and "the file is complete" the
        # same fact.
        part = BACKUP + ".part"
        with open(ASAR, "rb") as src, open(part, "wb") as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        shutil.copystat(ASAR, part)
        os.replace(part, BACKUP)
    with open(SHIM, "rb") as f:
        shim = f.read()

    tmp = ASAR + ".new"
    print(f"repacking from pristine backup, injecting {TARGET} ({len(shim)} bytes) ...")

    def progress(i, total):
        print(f"\r  {i}/{total} entries", end="", flush=True)

    fh, base, header = asar.read(BACKUP)
    try:
        entry = asar.read_file(fh, base, dict(asar.walk(header))[ENTRY])
    finally:
        fh.close()

    try:
        total = asar.repack(
            BACKUP, tmp,
            replace={TARGET: shim, ENTRY: ENTRY_PRELUDE + entry},
            progress=progress,
        )
    except BaseException:
        # repack() cleans up its own .body side file; tmp (dst, ~312 MB) is
        # this function's responsibility since only it decides what happens
        # to it afterward (os.replace on success). Left alone, a failed or
        # interrupted repack -- disk full partway through, Ctrl-C -- leaves a
        # partial app.asar.new next to the 312 MB backup and the still-intact
        # live app.asar, silently eating disk space that the next attempt
        # could have used.
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise
    print(f"\r  {total}/{total} entries")
    os.replace(tmp, ASAR)
    os.makedirs(CAPTURE, exist_ok=True)
    print(f"installed. new size {human(os.path.getsize(ASAR))}")
    print(f"capture dir: {CAPTURE}  (C:\\deepcool-capture inside the bottle)")
    return 0


def uninstall():
    if not os.path.exists(BACKUP):
        print("error: no backup to restore from")
        return 1
    if not _asar_is_complete(BACKUP):
        print(f"error: {BACKUP} is truncated or corrupt "
              f"({human(os.path.getsize(BACKUP))}) -- refusing to restore from it")
        return 1
    # Same reasoning as install()'s backup: copy2 in place means an
    # interrupted restore leaves app.asar itself half-overwritten, with
    # nothing left to fall back to.
    part = ASAR + ".part"
    with open(BACKUP, "rb") as src, open(part, "wb") as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        os.fsync(dst.fileno())
    shutil.copystat(BACKUP, part)
    os.replace(part, ASAR)
    print(f"restored original app.asar ({human(os.path.getsize(ASAR))})")
    return 0


COMMANDS = {"status": status, "install": install, "uninstall": uninstall}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd not in COMMANDS:
        print(__doc__)
        sys.exit(2)
    sys.exit(COMMANDS[cmd]())
