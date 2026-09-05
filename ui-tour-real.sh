#!/usr/bin/env bash
# ui-tour.sh, but against the real cooler: starts impl/usb-bridge.py first and
# seeds the device serial so the app does not sit in its re-init loop.
#
#   ./ui-tour-real.sh "page:- cpufan:253,522"
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOCK="${DC_USB_SOCK:-/tmp/dc-usb-bridge.sock}"

lsusb 2>/dev/null | grep -q '3633:0009' || { echo "no MYSTIQUE on the bus" >&2; exit 1; }
for p in $(pgrep -x python3); do tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q usb-brid && kill $p; done
sleep 0.4
# A killed bridge leaves its socket file behind, and the wait loop below only
# looks for the file -- so without this it returns before the new bridge has
# bound, and the first request finds nothing listening.
rm -f "$SOCK"
python3 "$HERE/impl/usb-bridge.py" "$SOCK" > "${DC_BRIDGE_LOG:-/tmp/dc-bridge.log}" 2>&1 &
BRIDGE=$!
trap 'kill $BRIDGE 2>/dev/null' EXIT
for _ in $(seq 30); do [ -S "$SOCK" ] && break; sleep 0.1; done
[ -S "$SOCK" ] || { echo "bridge did not come up; see ${DC_BRIDGE_LOG:-/tmp/dc-bridge.log}" >&2; exit 1; }

export DC_CAPTURE_DIR="${DC_CAPTURE_DIR:-$HERE/capture-ui-real}"
mkdir -p "$DC_CAPTURE_DIR"
cp "$HERE/defaults-stub-values.json" "$DC_CAPTURE_DIR/stub-values.json"
SERIAL="$(python3 "$HERE/impl/device-serial.py" "$SOCK" 2>/dev/null || true)"
if [ -n "$SERIAL" ]; then
  # Same reasoning as run-real.sh: this script has no `set -e` either, so
  # printing "bound as" unconditionally hid a failed write.
  if python3 - "$DC_CAPTURE_DIR/stub-values.json" "$SERIAL" <<'PYX'
import json, sys
p, serial = sys.argv[1], sys.argv[2]
v = json.load(open(p)); v['system_info.getBiosSerialNumber'] = serial
json.dump(v, open(p, 'w'), indent=2)
PYX
  then
    echo "bound as    : $SERIAL"
  else
    echo "bound as    : FAILED to seed $DC_CAPTURE_DIR/stub-values.json with $SERIAL; the app will re-init on a loop" >&2
  fi
else
  echo "warning: no device serial; the app will re-init once a second" >&2
fi

export DC_REAL_USB="$SOCK"
export DC_PIDS="${DC_PIDS:-0x0009}"
export DC_SHOTDIR="${DC_SHOTDIR:-$HERE/shots-real}"
# Not exec: that would replace this shell and lose the EXIT trap that
# stops the bridge.
"$HERE/ui-tour.sh" "$@"
