#!/usr/bin/env bash
# Run the app with its real window on a headless X server and grab screenshots.
#
#   ./run-ui.sh [seconds] [shot1_at,shot2_at,...]
#
# Same shim/stub environment as run-only.sh -- the difference is that this one
# brings up Xvfb and lets the renderer actually paint, so we can see the UI
# rather than only the IPC traffic.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DURATION="${1:-60}"
SHOTS="${2:-12,20,30,45}"

DISP="${DC_DISPLAY:-:99}"
GEOM="${DC_GEOM:-1440x960x24}"
SHOTDIR="${DC_SHOTDIR:-$HERE/shots}"
mkdir -p "$SHOTDIR"
rm -f "$SHOTDIR"/*.png

ELECTRON_BIN="${DC_ELECTRON_DIR:-$HERE/.electron}/electron"
ASAR="${DC_ASAR:-$HOME/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c/DeepCool/resources/app.asar}"
export DC_CAPTURE_DIR="${DC_CAPTURE_DIR:-$HERE/capture}"
export DC_ANNOUNCE_EVERY="${DC_ANNOUNCE_EVERY:-999999}"
export DC_IMPL_DIR="${DC_IMPL_DIR:-$HERE/impl}"
export DC_STUB="${DC_STUB:-edge_nativeclr,electron-edge-js,system_info,skia,wincapture,ffmplayer,opencv,ready.node,/C122/,/L122/,/L086/,/L136/,/CH690/,/L142/}"

mkdir -p "$DC_CAPTURE_DIR"
rm -f "$DC_CAPTURE_DIR/usb.jsonl"
[ -f "$DC_CAPTURE_DIR/replies.json" ]     || cp "$HERE/defaults-replies.json"     "$DC_CAPTURE_DIR/replies.json"
[ -f "$DC_CAPTURE_DIR/stub-values.json" ] || cp "$HERE/defaults-stub-values.json" "$DC_CAPTURE_DIR/stub-values.json"

pkill -f "Xvfb $DISP" 2>/dev/null
sleep 0.5
Xvfb "$DISP" -screen 0 "$GEOM" -nolisten tcp >"$SHOTDIR/xvfb.log" 2>&1 &
XVFB_PID=$!
sleep 1.5

export DISPLAY="$DISP"
timeout "$DURATION" "$ELECTRON_BIN" --no-sandbox "$ASAR" > "$DC_CAPTURE_DIR/app.log" 2>&1 &
APP_PID=$!

start=$(date +%s)
IFS=',' read -ra AT_ALL <<< "$SHOTS"
# The default schedule (12,20,30,45) is independent of DURATION (default 60),
# so a deliberately short run -- ./run-ui.sh 20 -- used to still "shoot" t=30
# and t=45 well after `timeout "$DURATION"` had already killed Electron: the
# root Xvfb window is still there with no client on it, so `import` still
# succeeds and still prints its success line, for a screenshot of nothing.
AT=(); DROPPED=()
for t in "${AT_ALL[@]}"; do
  if [ "$t" -ge "$DURATION" ]; then DROPPED+=("$t"); else AT+=("$t"); fi
done
if [ "${#DROPPED[@]}" -gt 0 ]; then
  echo "note: dropping shot(s) at t=$(IFS=,; echo "${DROPPED[*]}")s -- at or past DURATION=${DURATION}s, the app would already be gone" >&2
fi
for t in "${AT[@]}"; do
  now=$(( $(date +%s) - start ))
  wait_for=$(( t - now ))
  [ "$wait_for" -gt 0 ] && sleep "$wait_for"
  import -display "$DISP" -window root "$SHOTDIR/t${t}s.png" 2>/dev/null \
    && echo "shot t=${t}s -> $SHOTDIR/t${t}s.png"
  xdotool search --onlyvisible --name . getwindowname %@ 2>/dev/null | sed 's/^/    window: /'
done

wait "$APP_PID" 2>/dev/null
kill "$XVFB_PID" 2>/dev/null
echo "done; log: $DC_CAPTURE_DIR/app.log"
