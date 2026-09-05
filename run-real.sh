#!/usr/bin/env bash
# Run the app against the REAL cooler.
#
#   ./run-real.sh [seconds]      headless, for capture
#   DC_UI=1 ./run-real.sh        on your desktop, until you close it
#
# Starts impl/usb-bridge.py (which holds 3633:0009) and points the shim at it,
# so what the UI does reaches the panel. The bridge refuses 0x11/0x13/0x14 --
# the commands that rewrite the stored PC serial or erase the device's media --
# unless DC_USB_ALLOW names them. The app sends 0x14 on every start, so without
# that guard simply launching this would wipe the cooler's images.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOCK="${DC_USB_SOCK:-/tmp/dc-usb-bridge.sock}"

if ! lsusb 2>/dev/null | grep -q '3633:0009'; then
  echo "error: no DeepCool MYSTIQUE (3633:0009) on the bus" >&2; exit 1
fi

# pkill -f matches the WHOLE command line of any process, not just a
# python3 interpreter running this script -- `vim impl/usb-bridge.py` (or
# `less`/`tail -f` on it) open in another terminal has that string on its
# own argv too, and used to get SIGTERM'd with no message about what was
# just killed. Restrict the match to actual python3 processes first, the
# same way ui-tour-real.sh already does.
for p in $(pgrep -x python3); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q usb-brid && kill "$p"; done
sleep 0.4
# A killed bridge leaves its socket file behind, and the wait loop below only
# tests for the file -- so without this it returns before the new bridge has
# bound, the serial read finds nothing listening, and the app spends the run
# re-initialising once a second.
rm -f "$SOCK"
python3 "$HERE/impl/usb-bridge.py" "$SOCK" > "${DC_BRIDGE_LOG:-/tmp/dc-bridge.log}" 2>&1 &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT
for _ in $(seq 30); do [ -S "$SOCK" ] && break; sleep 0.1; done
[ -S "$SOCK" ] || { echo "error: bridge did not come up; see ${DC_BRIDGE_LOG:-/tmp/dc-bridge.log}" >&2; exit 1; }
echo "bridge      : $SOCK  (guard on 0x11/0x13/0x14)"

# The cooler stores the serial of the PC it was bound to. The app compares it
# with the host BIOS serial and, on a mismatch, re-runs its entire init once a
# second -- 84 times in a 90s run before this. Read it back and seed the stub
# so the handshake passes; nothing is written to the device.
export DC_CAPTURE_DIR="${DC_CAPTURE_DIR:-$HERE/capture-real}"
mkdir -p "$DC_CAPTURE_DIR"
[ -f "$DC_CAPTURE_DIR/stub-values.json" ] || cp "$HERE/defaults-stub-values.json" "$DC_CAPTURE_DIR/stub-values.json"
if [ "${DC_BIND_SERIAL:-1}" = "1" ]; then
  SERIAL="$(python3 "$HERE/impl/device-serial.py" "$SOCK" 2>/dev/null || true)"
  if [ -n "$SERIAL" ]; then
    # Without checking this, a failed write (bad JSON already in the file, a
    # permissions problem, disk full) still printed the reassuring "bound as"
    # line below -- there is no `set -e` in this script, so the heredoc's own
    # failure was silently swallowed -- and the app would spend the run
    # re-initialising once a second with no hint that the seed never landed.
    if python3 - "$DC_CAPTURE_DIR/stub-values.json" "$SERIAL" <<'PYX'
import json, sys
p, serial = sys.argv[1], sys.argv[2]
v = json.load(open(p))
v['system_info.getBiosSerialNumber'] = serial
json.dump(v, open(p, 'w'), indent=2)
PYX
    then
      echo "bound as    : $SERIAL  (read from the device, not written)"
    else
      echo "bound as    : FAILED to seed $DC_CAPTURE_DIR/stub-values.json with $SERIAL; the app will re-init on a loop" >&2
    fi
  else
    echo "bound as    : could not read the device serial; the app will re-init on a loop" >&2
  fi
fi

export DC_REAL_USB="$SOCK"
export DC_PIDS="${DC_PIDS:-0x0009}"
if [ "${DC_UI:-0}" = "1" ]; then
  export DISPLAY="${DISPLAY:-:1}"
  # A multi-head desktop puts the window on whichever head the compositor feels
  # like. Ask for the largest connected output; DC_FORCE_BOUNDS=x,y,w,h
  # overrides. This lands correctly on X11 and on the Xvfb the tour uses, and
  # is ignored under Wayland -- see the note in README.
  if [ -z "${DC_FORCE_BOUNDS:-}" ] && command -v xrandr >/dev/null; then
    DC_FORCE_BOUNDS="$(xrandr --query 2>/dev/null | awk '
      # $2 is the exact token "connected" or "disconnected" in xrandr --query
      # output; the old /[^d]connected/ meant to exclude the latter by
      # checking the character just before "connected" is not "d", but that
      # character is "s" ("di-s-connected"), so it matched both and only the
      # geometry-regex guard below happened to still filter most disconnected
      # outputs out.
      $2 == "connected" {
        if (match($0, /[0-9]+x[0-9]+\+[0-9]+\+[0-9]+/)) {
          geo = substr($0, RSTART, RLENGTH)
          split(geo, a, /[x+]/)
          area = a[1] * a[2]
          if (area > best) { best = area; w = a[1]; h = a[2]; x = a[3]; y = a[4] }
        }
      }
      END {
        if (best) {
          ww = (w > 1400) ? 1280 : w - 80; hh = (h > 1000) ? 900 : h - 120
          printf "%d,%d,%d,%d", x + int((w - ww) / 2), y + int((h - hh) / 2), ww, hh
        }
      }')"
  fi
  if [ -n "${DC_FORCE_BOUNDS:-}" ]; then
    export DC_FORCE_BOUNDS
    export DC_TRACE_UI=1
    export DC_FORCE_SHOW="${DC_FORCE_SHOW:-7000}"
    echo "window      : asked for $DC_FORCE_BOUNDS (a Wayland compositor may ignore it)"
  fi
  mkdir -p "$DC_CAPTURE_DIR"; rm -f "$DC_CAPTURE_DIR/usb.jsonl"
  [ -f "$DC_CAPTURE_DIR/replies.json" ]     || cp "$HERE/defaults-replies.json"     "$DC_CAPTURE_DIR/replies.json"
  [ -f "$DC_CAPTURE_DIR/stub-values.json" ] || cp "$HERE/defaults-stub-values.json" "$DC_CAPTURE_DIR/stub-values.json"
  export DC_IMPL_DIR="${DC_IMPL_DIR:-$HERE/impl}"
  export DC_ANNOUNCE_EVERY="${DC_ANNOUNCE_EVERY:-999999}"
  export DC_STUB="${DC_STUB:-edge_nativeclr,electron-edge-js,system_info,skia,wincapture,ffmplayer,opencv,ready.node,/C122/,/L122/,/L086/,/L136/,/CH690/,/L142/}"
  echo "display     : $DISPLAY"
  # This branch used a literal "$HERE/.electron/electron", ignoring
  # DC_ELECTRON_DIR even though run-only.sh (the non-UI branch, two lines
  # down) honours it -- the same variable moved the binary in one branch of
  # this script and did nothing in the other. Reuse the same expression, and
  # fail with a clear message instead of bash's own "No such file or
  # directory" when the binary or the shim is missing -- run-only.sh's
  # fetch-and-unzip only runs for the branch that calls it.
  DC_ELECTRON_BIN="${DC_ELECTRON_DIR:-$HERE/.electron}/electron"
  DC_UI_ASAR="${DC_ASAR:-$HOME/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c/DeepCool/resources/app.asar}"
  if [ ! -x "$DC_ELECTRON_BIN" ]; then
    echo "error: electron not found at $DC_ELECTRON_BIN -- run ./run-only.sh once to fetch it, or set DC_ELECTRON_DIR" >&2
    exit 1
  fi
  if ! grep -qa DC_CAPTURE_DIR "$DC_UI_ASAR" 2>/dev/null; then
    echo "error: shim not installed in $DC_UI_ASAR -- run ./shim.py install" >&2
    exit 1
  fi
  "$DC_ELECTRON_BIN" --no-sandbox "$DC_UI_ASAR" > "$DC_CAPTURE_DIR/app.log" 2>&1
else
  "$HERE/run-only.sh" "${1:-60}"
fi
