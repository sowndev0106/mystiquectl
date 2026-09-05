#!/usr/bin/env bash
# Run DeepCool's main process on Linux Electron with the recording shim.
# (run.sh wraps this and prints the analysis; sweep.py calls it directly.)
#
# The app is a bytenode bundle built for Electron 23.3.13; the bytecode is
# portable to the same Electron build on Linux, so the whole main process runs
# natively here. Everything Windows-only (the .NET bridge, the Skia canvas, the
# per-model native protocol modules, the sensor and capture addons) is replaced
# by recording stubs, and `usb` is replaced by the synthetic MYSTIQUE.
#
#   ./run-only.sh [seconds]
#
# Requires: ./shim.py install  (patches app.asar; ./shim.py uninstall reverts)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DURATION="${1:-45}"

ELECTRON_VERSION=23.3.13
ELECTRON_DIR="${DC_ELECTRON_DIR:-$HERE/.electron}"
ELECTRON_BIN="$ELECTRON_DIR/electron"

ASAR="${DC_ASAR:-$HOME/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c/DeepCool/resources/app.asar}"
export DC_CAPTURE_DIR="${DC_CAPTURE_DIR:-$HERE/capture}"

# Windows-only natives. The per-model protocol modules are stubbed too: they
# are Windows DLLs and cannot load here. MYSTIQUE does not need them -- its
# protocol is JavaScript, which is exactly why it is the model we can capture.
# One device announcement per run: repeated announcements re-run the whole
# init sequence and those frames land in the middle of whatever a driver is
# doing, which makes them impossible to attribute. sweep.py overrides this.
export DC_ANNOUNCE_EVERY="${DC_ANNOUNCE_EVERY:-999999}"
export DC_TRACE_IPC="${DC_TRACE_IPC:-}"
export DC_TRACE_UI="${DC_TRACE_UI:-}"
export DC_TRACE_JSON_MATCH="${DC_TRACE_JSON_MATCH:-}"
export DC_TRACE_JSON="${DC_TRACE_JSON:-}"
export DC_SENSOR_FAKE="${DC_SENSOR_FAKE:-}"
export DC_SENSOR_SWEEP="${DC_SENSOR_SWEEP:-}"
export DC_SENSOR_PUSH_MS="${DC_SENSOR_PUSH_MS:-1000}"
export DC_TRACE_PATH="${DC_TRACE_PATH:-}"
export DC_IMPL_DIR="${DC_IMPL_DIR:-$HERE/impl}"
export DC_STUB="${DC_STUB:-edge_nativeclr,electron-edge-js,system_info,skia,wincapture,ffmplayer,opencv,ready.node,/C122/,/L122/,/L086/,/L136/,/CH690/,/L142/}"

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "fetching electron $ELECTRON_VERSION (linux-x64) ..."
  mkdir -p "$ELECTRON_DIR"
  url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-x64.zip"
  curl -sSL -o "$ELECTRON_DIR/electron.zip" "$url"
  unzip -q -o "$ELECTRON_DIR/electron.zip" -d "$ELECTRON_DIR"
  rm -f "$ELECTRON_DIR/electron.zip"
fi

# Clear the previous run's log before either preflight check can exit --
# otherwise a caller whose only failure signal is "does usb.jsonl look right"
# (sweep.py is exactly this) re-analyses a stale, unrelated success and
# reports it as this run's result, with nothing to say the app never started.
mkdir -p "$DC_CAPTURE_DIR"
rm -f "$DC_CAPTURE_DIR/usb.jsonl"

if [ ! -f "$ASAR" ]; then
  echo "error: app.asar not found at $ASAR" >&2
  exit 1
fi

if ! grep -qa DC_CAPTURE_DIR "$ASAR"; then
  echo "error: shim not installed in $ASAR -- run ./shim.py install" >&2
  exit 1
fi

# The app is a GUI application and Electron aborts without a display
# ("Missing X server or $DISPLAY" -> "The platform failed to initialize").
# It used to survive headless only because it never got far enough to open its
# windows; now that startup completes, it needs a screen even for an IPC run.
XVFB_PID=""
if [ -z "${DISPLAY:-}" ]; then
  DISP="${DC_DISPLAY:-:99}"
  pkill -f "Xvfb $DISP" 2>/dev/null || true
  sleep 0.3
  Xvfb "$DISP" -screen 0 1280x860x24 -nolisten tcp >"$DC_CAPTURE_DIR/xvfb.log" 2>&1 &
  XVFB_PID=$!
  sleep 1.2
  export DISPLAY="$DISP"
  echo "display     : $DISP (Xvfb)"
fi
# Under `set -e`, a failing EXIT trap becomes the script's own exit status --
# and this one failed whenever DISPLAY was already set (XVFB_PID stays "",
# `[ -n "" ]` is false, `&&` short-circuits, cleanup "fails"). That silently
# turned a clean run into exit 1 with no error printed, which made run.sh
# abort before ever reaching its analysis step. The trailing `true` makes the
# trap's own success independent of whether there was anything to kill.
cleanup() { [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null; true; }
trap cleanup EXIT

# Seed the answers that get the device through initialisation, unless the
# caller (or a previous run) already put something there.
[ -f "$DC_CAPTURE_DIR/replies.json" ]     || cp "$HERE/defaults-replies.json"     "$DC_CAPTURE_DIR/replies.json"
[ -f "$DC_CAPTURE_DIR/stub-values.json" ] || cp "$HERE/defaults-stub-values.json" "$DC_CAPTURE_DIR/stub-values.json"

echo "capture dir : $DC_CAPTURE_DIR"
echo "pids        : ${DC_PIDS:-all candidates}"
echo "running     : ${DURATION}s"

# --no-sandbox: the unpacked Electron's chrome-sandbox is not setuid root.
set +e
timeout "$DURATION" "$ELECTRON_BIN" --no-sandbox "$ASAR" > "$DC_CAPTURE_DIR/app.log" 2>&1
rc=$?
set -e
if [ $rc -eq 124 ]; then
  echo "(stopped at timeout, as intended)"
  exit 0
fi
# Any other code is the app actually exiting on its own -- normal only if
# something asked it to (DC_FORCE_SHOW screenshot flows do). The final
# statement's own exit status used to become this script's, and
# `[ $rc -eq 124 ] && echo A || echo B` succeeds via whichever echo ran
# regardless of $rc, so a real crash (segfault, missing library, the
# sandbox rejecting --no-sandbox) was reported as "app exited: N" and then
# exit 0 anyway -- every caller that only checks $? believed the run went
# fine. run.sh's `exec analyze.py` and sweep.py's failure check both depend
# on this now actually meaning something.
echo "(app exited: $rc)"
exit "$rc"

