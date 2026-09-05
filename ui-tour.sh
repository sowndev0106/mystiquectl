#!/usr/bin/env bash
# Bring the app up on a headless X server, reveal the main window, then walk
# the UI with real clicks and screenshot each page.
#
#   ./ui-tour.sh "dashboard:- device:28,154 list:28,214"
#
# Each step is  label:x,y  (a bare '-' means "just screenshot, no click").
# Coordinates are window-relative; the window is pinned to 0,0.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOUR="${1:-dashboard:-}"
SETTLE="${DC_TOUR_SETTLE:-3}"
# The app now reaches its main window on its own (~6s); this only pins the
# window to 0,0 at a known size so click coordinates stay stable.
SHOW_AT="${DC_SHOW_AT:-8}"

DISP="${DC_DISPLAY:-:99}"
W="${DC_W:-1280}"; H="${DC_H:-860}"
SHOTDIR="${DC_SHOTDIR:-$HERE/shots}"
mkdir -p "$SHOTDIR"; rm -f "$SHOTDIR"/*.png

ELECTRON_BIN="${DC_ELECTRON_DIR:-$HERE/.electron}/electron"
ASAR="${DC_ASAR:-$HOME/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c/DeepCool/resources/app.asar}"
export DC_CAPTURE_DIR="${DC_CAPTURE_DIR:-$HERE/capture}"
export DC_ANNOUNCE_EVERY="${DC_ANNOUNCE_EVERY:-999999}"
export DC_IMPL_DIR="${DC_IMPL_DIR:-$HERE/impl}"
export DC_STUB="${DC_STUB:-edge_nativeclr,electron-edge-js,system_info,skia,wincapture,ffmplayer,opencv,ready.node,/C122/,/L122/,/L086/,/L136/,/CH690/,/L142/}"
export DC_TRACE_UI=1
export DC_FORCE_SHOW=$((SHOW_AT * 1000))
# The default (13) happened to be safely after the default SHOW_AT (8), but
# the two were never actually linked -- DC_SHOW_AT exists precisely for a
# slow-starting app, and raising it without also raising DC_WAIT starts
# clicking before the shim has revealed and re-pinned the window to
# DC_FORCE_BOUNDS. Every coordinate in the tour is window-relative, so those
# early clicks land wherever the compositor had left the window, not at 0,0.
WAIT_BEFORE="${DC_WAIT:-$((SHOW_AT + 5))}"
if [ "$WAIT_BEFORE" -le "$SHOW_AT" ]; then
  echo "error: DC_WAIT=$WAIT_BEFORE must be greater than DC_SHOW_AT=$SHOW_AT -- the tour would start clicking before the window is shown and pinned" >&2
  exit 1
fi
export DC_FORCE_BOUNDS="0,0,$W,$H"
export DC_PICK_FILE="${DC_PICK_FILE:-}"
export DC_TRACE_DB="${DC_TRACE_DB:-}"
export DC_TRACE_WRITE="${DC_TRACE_WRITE:-}"

mkdir -p "$DC_CAPTURE_DIR"; rm -f "$DC_CAPTURE_DIR/usb.jsonl"
[ -f "$DC_CAPTURE_DIR/replies.json" ]     || cp "$HERE/defaults-replies.json"     "$DC_CAPTURE_DIR/replies.json"
[ -f "$DC_CAPTURE_DIR/stub-values.json" ] || cp "$HERE/defaults-stub-values.json" "$DC_CAPTURE_DIR/stub-values.json"

pkill -f "Xvfb $DISP" 2>/dev/null; sleep 0.5
Xvfb "$DISP" -screen 0 "${W}x${H}x24" -nolisten tcp >"$SHOTDIR/xvfb.log" 2>&1 &
XVFB_PID=$!; sleep 1.5
export DISPLAY="$DISP"

# Without this, Ctrl-C or a killed wrapper during the WAIT_BEFORE sleep or the
# tour loop below (or `set -u`/pipefail aborting on an unbound var or a
# failed pipe) skips straight past the cleanup at the bottom of the script,
# leaving Xvfb and the Electron main process running forever. Set as soon as
# XVFB_PID exists so even an early exit still kills it.
trap 'kill "${APP_PID:-}" "$XVFB_PID" 2>/dev/null' EXIT

"$ELECTRON_BIN" --no-sandbox "$ASAR" > "$DC_CAPTURE_DIR/app.log" 2>&1 &
APP_PID=$!

sleep "$WAIT_BEFORE"

i=0
for step in $TOUR; do
  if [[ "$step" != *:* ]]; then
    # No colon means ${step%%:*} and ${step#*:} both just return $step
    # unchanged (neither pattern matches), so label==coord=="dashboard" for a
    # step like "dashboard" instead of "dashboard:-". That used to fall
    # through into the click branch with a non-numeric, non-"-" coord and
    # print x/y with %s, writing an unquoted bareword into JSON
    # ({"x":dashboard,...}) that hard-crashes analyze.py/map.py/tour-frames.py
    # on the very first parse of this file. Fail loudly here instead, at the
    # one point that knows what the step string was supposed to look like.
    echo "error: tour step '$step' has no ':' -- expected label:x,y or label:-" >&2
    exit 1
  fi
  label="${step%%:*}"; coord="${step#*:}"
  if [ "$coord" != "-" ]; then
    if [[ ! "$coord" =~ ^[0-9]+,[0-9]+$ ]]; then
      echo "error: tour step '$step' has a non-numeric coordinate '$coord' -- expected x,y or -" >&2
      exit 1
    fi
    x="${coord%%,*}"; y="${coord##*,}"
    # Marker in the capture stream, so the frames a click produced can be
    # attributed to that click rather than guessed at from ordering alone.
    printf '{"event":"tour.click","label":"%s","x":%d,"y":%d}\n' "$label" "$x" "$y" \
      >> "$DC_CAPTURE_DIR/usb.jsonl"
    xdotool mousemove "$x" "$y" click 1
    sleep "$SETTLE"
  fi
  i=$((i+1))
  import -display "$DISP" -window root "$SHOTDIR/$(printf %02d $i)-$label.png" 2>/dev/null \
    && echo "shot $label -> $SHOTDIR/$(printf %02d $i)-$label.png"
done

kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
kill "$XVFB_PID" 2>/dev/null
echo "log: $DC_CAPTURE_DIR/app.log"
