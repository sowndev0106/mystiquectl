#!/usr/bin/env bash
# Run the app against the REAL cooler.
#
#   ./run-real.sh [seconds]      headless, for capture
#   DC_UI=1 ./run-real.sh        on your desktop, until you close it
#   DC_UI=1 DC_BACKGROUND=1 ./run-real.sh
#                                started hidden, in the tray (mystiquectl
#                                --background, at login)
#
# If the app is already running (from mystiquectl, usually in the tray),
# DC_UI=1 shows its window instead of starting a second one, DC_BACKGROUND=1
# does nothing, and a headless run refuses rather than restart the bridge
# out from under it.
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

DC_ELECTRON_BIN="${DC_ELECTRON_DIR:-$HERE/.electron}/electron"
DC_UI_ASAR="${DC_ASAR:-$HOME/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c/DeepCool/resources/app.asar}"

# What the app's window needs on top of the bridge -- shared by a normal
# DC_UI start and a hand-over to one already running.
ui_env() {
  export DISPLAY="${DISPLAY:-:1}"
  mkdir -p "$DC_CAPTURE_DIR"; rm -f "$DC_CAPTURE_DIR/usb.jsonl"
  [ -f "$DC_CAPTURE_DIR/replies.json" ]     || cp "$HERE/defaults-replies.json"     "$DC_CAPTURE_DIR/replies.json"
  [ -f "$DC_CAPTURE_DIR/stub-values.json" ] || cp "$HERE/defaults-stub-values.json" "$DC_CAPTURE_DIR/stub-values.json"
  export DC_IMPL_DIR="${DC_IMPL_DIR:-$HERE/impl}"
  export DC_ANNOUNCE_EVERY="${DC_ANNOUNCE_EVERY:-999999}"
  export DC_STUB="${DC_STUB:-edge_nativeclr,electron-edge-js,system_info,skia,wincapture,ffmplayer,opencv,ready.node,/C122/,/L122/,/L086/,/L136/,/CH690/,/L142/}"
}

# Already running = a main electron process on this same app.asar (only its
# own children carry --type=, and other Electron apps run other files) with
# the bridge socket in place. A socket left behind by a killed bridge doesn't
# count on its own: nothing is there to use it. Chromium rewrites its
# /proc/<pid>/cmdline into one space-joined string (switches first, so
# "--no-sandbox -autoRun <asar>"), hence matching words, not NUL-separated
# arguments.
app_running() {
  [ -S "$SOCK" ] || return 1
  local p args
  for p in $(pgrep -x electron); do
    args=" $(tr '\0' ' ' 2>/dev/null < "/proc/$p/cmdline") " || continue
    case "$args" in *" --type="*) continue ;; esac
    case "$args" in *" $DC_UI_ASAR "*) APP_PID="$p"; return 0 ;; esac
  done
  return 1
}

# A second electron on the same app.asar trips the app's own single-instance
# lock: the running one shows its window, this one exits within a couple of
# seconds. Restarting the bridge, as below, would instead cut the running app
# off the cooler. The shim in this second one logs too, so it gets a
# throwaway capture dir rather than the running app's -- which is also why a
# failure is shown here before that dir goes.
hand_over() {
  # Asked to show its window in its first few seconds -- a click on the menu
  # entry right after autostart started it -- the app shows a window that
  # isn't loaded yet and its own -autoRun startup (done ~6s in) leaves it
  # hidden. So wait until it has been up DC_HANDOVER_SETTLE seconds.
  local age settle="${DC_HANDOVER_SETTLE:-10}"
  age="$(ps -o etimes= -p "$APP_PID" 2>/dev/null | tr -d ' ')"
  if [ -n "$age" ] && [ "$age" -lt "$settle" ]; then
    echo "the app is still starting -- showing its window in $(( settle - age ))s"
    sleep $(( settle - age ))
  fi
  echo "already running -- showing its window"
  DC_CAPTURE_DIR="$(mktemp -d)"; export DC_CAPTURE_DIR
  trap 'rm -rf "$DC_CAPTURE_DIR"' EXIT
  export DC_REAL_USB="$SOCK" DC_PIDS="${DC_PIDS:-0x0009}"
  ui_env
  "$DC_ELECTRON_BIN" --no-sandbox "$DC_UI_ASAR" > "$DC_CAPTURE_DIR/app.log" 2>&1 9>&-
  local rc=$?
  [ "$rc" = 0 ] || { echo "error: handing over to the running app failed (electron exit $rc):" >&2; tail -n 20 "$DC_CAPTURE_DIR/app.log" >&2; }
  exit "$rc"
}

if app_running; then
  if [ "${DC_UI:-0}" != "1" ]; then
    echo "error: the app is already running (mystiquectl, in the tray) and holds the cooler -- quit it from the tray first" >&2
    exit 1
  fi
  if [ "${DC_BACKGROUND:-0}" = "1" ]; then
    echo "already running"
    exit 0
  fi
  hand_over
fi

# Not up yet is not the same as nobody starting it: from here to a running
# app takes a few seconds (bridge, serial read, electron), and a second run in
# that window -- autostart racing a click on the menu entry -- would kill the
# first one's bridge below and leave its app with none. So only one run at a
# time gets past this lock, held for as long as this script runs. Nothing it
# starts inherits it (9>&-): a lingering child must not block the next start.
if command -v flock >/dev/null; then
  exec 9>"$SOCK.lock"
  if ! flock -n 9; then
    if [ "${DC_UI:-0}" != "1" ]; then
      echo "error: another run (mystiquectl, or ui-tour-real.sh) holds the cooler -- let it finish or quit it first" >&2
      exit 1
    fi
    if [ "${DC_BACKGROUND:-0}" = "1" ]; then
      echo "already starting"
      exit 0
    fi
    for _ in $(seq $(( ${DC_HANDOVER_WAIT:-20} * 4 ))); do
      app_running && hand_over
      sleep 0.25
    done
    echo "error: another run holds the cooler and its app didn't come up within ${DC_HANDOVER_WAIT:-20}s" >&2
    exit 1
  fi
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
python3 "$HERE/impl/usb-bridge.py" "$SOCK" > "${DC_BRIDGE_LOG:-/tmp/dc-bridge.log}" 2>&1 9>&- &
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
  ui_env
  # DC_BACKGROUND=1 skips both window-placement blocks below: the force-show
  # they turn on would pop the window up 7s into what should be a start
  # hidden in the tray.
  # A multi-head desktop puts the window on whichever head the compositor feels
  # like. Ask for the largest connected output; DC_FORCE_BOUNDS=x,y,w,h
  # overrides. This lands correctly on X11 and on the Xvfb the tour uses, and
  # is ignored under Wayland -- see the note in README.
  if [ "${DC_BACKGROUND:-0}" != "1" ] && [ -z "${DC_FORCE_BOUNDS:-}" ] && command -v xrandr >/dev/null; then
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
  if [ "${DC_BACKGROUND:-0}" != "1" ] && [ -n "${DC_FORCE_BOUNDS:-}" ]; then
    export DC_FORCE_BOUNDS
    export DC_TRACE_UI=1
    export DC_FORCE_SHOW="${DC_FORCE_SHOW:-7000}"
    echo "window      : asked for $DC_FORCE_BOUNDS (a Wayland compositor may ignore it)"
  fi
  echo "display     : $DISPLAY"
  # This branch used a literal "$HERE/.electron/electron", ignoring
  # DC_ELECTRON_DIR even though run-only.sh (the non-UI branch, two lines
  # down) honours it -- the same variable moved the binary in one branch of
  # this script and did nothing in the other. DC_ELECTRON_BIN, set at the
  # top, reuses the same expression; fail with a clear message instead of
  # bash's own "No such file or directory" when the binary or the shim is
  # missing -- run-only.sh's fetch-and-unzip only runs for the branch that
  # calls it.
  if [ ! -x "$DC_ELECTRON_BIN" ]; then
    echo "error: electron not found at $DC_ELECTRON_BIN -- run ./run-only.sh once to fetch it, or set DC_ELECTRON_DIR" >&2
    exit 1
  fi
  if ! grep -qa DC_CAPTURE_DIR "$DC_UI_ASAR" 2>/dev/null; then
    echo "error: shim not installed in $DC_UI_ASAR -- run ./shim.py install" >&2
    exit 1
  fi
  # -autoRun is the app's own start-at-login switch (what it registers with
  # setLoginItemSettings on Windows): it comes up with only its tray icon.
  AUTORUN=(); [ "${DC_BACKGROUND:-0}" = "1" ] && AUTORUN=(-autoRun)
  "$DC_ELECTRON_BIN" --no-sandbox "$DC_UI_ASAR" "${AUTORUN[@]}" > "$DC_CAPTURE_DIR/app.log" 2>&1 9>&-
else
  "$HERE/run-only.sh" "${1:-60}" 9>&-
fi
