#!/usr/bin/env bash
# Capture a run and print the analysis.
#
#   ./run.sh                 45s capture run
#   ./run.sh 120             longer run
#   DC_PIDS=0x0022 ./run.sh  present a different product id
#
# Requires: ./shim.py install  (patches app.asar; ./shim.py uninstall reverts)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/run-only.sh" "${1:-45}"
echo
exec "$HERE/analyze.py" "${DC_CAPTURE_DIR:-$HERE/capture}"
