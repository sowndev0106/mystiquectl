#!/usr/bin/env bash
# mystiquectl installer / updater.
#
#   ./install.sh              first-time setup (same as "install")
#   ./install.sh install
#   ./install.sh update       git pull + refresh electron + re-check deps
#
# Safe to run repeatedly either way. What it does:
#   - checks for the system packages the real-hardware path needs
#     (python3, python3-usb, usbutils) and offers to install them
#   - fetches the pinned Electron build into .electron/ (never committed --
#     see the note in run-only.sh for why the version has to match exactly)
#   - installs the recording/replay shim into your own extracted app.asar,
#     if DC_ASAR (or the default Bottles path) points at one
#   - installs a `mystiquectl` launcher into ~/.local/bin
#
# This script does not, and will never, download or bundle DeepCool's own
# app.asar or its Windows installer -- see README's Installation section for
# where to get your own copy.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-install}"

# Must match the version run-only.sh / run-real.sh / run-ui.sh / ui-tour.sh
# all look for -- the app is a bytenode bundle built against this exact
# Electron release, and a different one loads a V8 the bytecode isn't valid
# for.
ELECTRON_VERSION=23.3.13
ELECTRON_DIR="${DC_ELECTRON_DIR:-$HERE/.electron}"

log()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$ACTION" in
  install|update) ;;
  *) echo "usage: $0 [install|update]" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------- update --
if [ "$ACTION" = update ]; then
  if [ -d "$HERE/.git" ]; then
    log "updating source (git pull --ff-only)..."
    git -C "$HERE" pull --ff-only
  else
    warn "$HERE is not a git checkout -- skipping source update, only refreshing electron/deps/launcher below"
  fi
fi

# ------------------------------------------------------- system packages --
MISSING=()
have python3 || MISSING+=(python3)
python3 -c "import usb.core" >/dev/null 2>&1 || MISSING+=(python3-usb)
have lsusb    || MISSING+=(usbutils)

if [ "${#MISSING[@]}" -gt 0 ]; then
  log "missing packages: ${MISSING[*]}"
  if have apt-get; then
    log "installing via apt-get (needs sudo)..."
    sudo apt-get update -y && sudo apt-get install -y "${MISSING[@]}"
  elif have dnf; then
    PKGS=(); for m in "${MISSING[@]}"; do [ "$m" = python3-usb ] && PKGS+=(python3-pyusb) || PKGS+=("$m"); done
    log "installing via dnf (needs sudo)..."
    sudo dnf install -y "${PKGS[@]}"
  elif have pacman; then
    PKGS=(); for m in "${MISSING[@]}"; do [ "$m" = python3-usb ] && PKGS+=(python-pyusb) || PKGS+=("$m"); done
    log "installing via pacman (needs sudo)..."
    sudo pacman -S --needed --noconfirm "${PKGS[@]}"
  else
    warn "unrecognised package manager -- install these yourself: ${MISSING[*]}"
  fi
else
  log "system packages: OK (python3, python3-usb, usbutils)"
fi

for extra in xdotool import; do
  have "$extra" || warn "$extra not found -- only needed for the optional ui-tour.sh / ui-tour-real.sh scripted demo driver, not for day-to-day use against your real cooler"
done

# ------------------------------------------------------------- electron --
case "$(uname -m)" in
  x86_64)        ELECTRON_ARCH=x64 ;;
  aarch64|arm64) ELECTRON_ARCH=arm64 ;;
  *) warn "no known electron $ELECTRON_VERSION build for $(uname -m) -- set DC_ELECTRON_DIR to a manually-fetched build"; ELECTRON_ARCH="" ;;
esac

CURRENT=""
[ -f "$ELECTRON_DIR/version" ] && CURRENT="$(cat "$ELECTRON_DIR/version" 2>/dev/null || true)"
if [ -n "$ELECTRON_ARCH" ] && { [ "$CURRENT" != "$ELECTRON_VERSION" ] || [ ! -x "$ELECTRON_DIR/electron" ]; }; then
  log "fetching electron $ELECTRON_VERSION (linux-$ELECTRON_ARCH) into $ELECTRON_DIR ..."
  rm -rf "$ELECTRON_DIR"
  mkdir -p "$ELECTRON_DIR"
  url="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-linux-${ELECTRON_ARCH}.zip"
  curl -fsSL -o "$ELECTRON_DIR/electron.zip" "$url"
  unzip -q -o "$ELECTRON_DIR/electron.zip" -d "$ELECTRON_DIR"
  rm -f "$ELECTRON_DIR/electron.zip"
  log "electron $ELECTRON_VERSION ready"
elif [ -n "$ELECTRON_ARCH" ]; then
  log "electron $ELECTRON_VERSION already present"
fi

# ------------------------------------------------------------- app.asar --
DEFAULT_ASAR="$HOME/.var/app/com.usebottles.bottles/data/bottles/bottles/Local/drive_c/DeepCool/resources/app.asar"
ASAR="${DC_ASAR:-$DEFAULT_ASAR}"
if [ -f "$ASAR" ]; then
  log "app.asar found: $ASAR"
  if grep -qa DC_CAPTURE_DIR "$ASAR" 2>/dev/null; then
    log "recording/replay shim already installed"
  else
    log "installing the recording/replay shim into it..."
    DC_ASAR="$ASAR" "$HERE/shim.py" install
  fi
else
  warn "no app.asar at $ASAR"
  warn "mystiquectl ships no DeepCool code -- extract your own app.asar from"
  warn "DeepCool's official Windows installer (see README: Installation),"
  warn "then either place it at that path or re-run as:"
  warn "  DC_ASAR=/path/to/app.asar $0 $ACTION"
fi

# ------------------------------------------------------------- launcher --
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/mystiquectl" <<LAUNCHER
#!/usr/bin/env bash
# Generated by install.sh -- re-run install.sh to regenerate, don't edit by hand.
exec env DC_UI=1 "$HERE/run-real.sh" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/mystiquectl"
log "launcher installed: $BIN_DIR/mystiquectl"

case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH -- add to your shell rc: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

log ""
log "done. Run 'mystiquectl' to start the app against your real cooler."
log "Run './install.sh update' any time to pull the latest source and refresh electron."
