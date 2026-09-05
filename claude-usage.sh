#!/usr/bin/env bash
# Sets the number the MYSTIQUE panel's System Monitor aux-display slot shows
# in place of its real memory percentage -- see the "custom sensor-slot
# value" section in shim/usb-shim.js. Meant for something like Claude Code's
# own /usage output, checked and typed in by hand -- there is no API this
# pulls the number from automatically.
#
#   ./claude-usage.sh 42        # next sensor push (within ~1s) shows 42
#   ./claude-usage.sh 42 1      # use slot 1 (CPU usage%) instead of slot 2 (memory%)
#   ./claude-usage.sh --clear   # remove the override, real memory% comes back
#
# Takes effect immediately on a running run-real.sh session -- the shim
# re-reads this file on every sensor push, no restart needed.
set -euo pipefail
PATH_FILE="${DC_CLAUDE_USAGE_PATH:-$HOME/.config/mystiquectl/claude-usage.json}"
mkdir -p "$(dirname "$PATH_FILE")"

if [ "${1:-}" = "--clear" ]; then
  rm -f "$PATH_FILE"
  echo "cleared -- slot 2 (memory%) will show the real value again"
  exit 0
fi

PERCENT="${1:?usage: $0 <0-100> [slot] | --clear}"
SLOT="${2:-2}"

case "$PERCENT" in ''|*[!0-9]*) echo "error: percent must be a whole number 0-100" >&2; exit 1;; esac
if [ "$PERCENT" -lt 0 ] || [ "$PERCENT" -gt 100 ]; then
  echo "error: percent must be 0-100, got $PERCENT" >&2; exit 1
fi
case "$SLOT" in ''|*[!0-9]*) echo "error: slot must be an integer 0-12" >&2; exit 1;; esac

printf '{"percent": %s, "slot": %s}\n' "$PERCENT" "$SLOT" > "$PATH_FILE"
echo "set: slot $SLOT -> $PERCENT% (takes effect within ~1s on a running session)"
