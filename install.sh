#!/usr/bin/env bash
# mystiquectl installer / updater.
#
#   ./install.sh              first-time setup (same as "install")
#   ./install.sh install
#   ./install.sh update       git pull + refresh electron + re-check deps
#
# Piped from curl it first clones the repo into ~/.local/share/mystiquectl
# (override with MYSTIQUECTL_DIR), or pulls it if already there, re-runs
# itself from there, and starts the app at the end if it can.
#
# Safe to run repeatedly either way. What it does:
#   - checks for the system packages the real-hardware path needs
#     (python3, python3-usb, usbutils) and offers to install them
#   - fetches the pinned Electron build into .electron/ (never committed --
#     see the note in run-only.sh for why the version has to match exactly)
#   - installs the recording/replay shim into your own extracted app.asar,
#     if DC_ASAR (or the default Bottles path) points at one
#   - installs a `mystiquectl` launcher into ~/.local/bin, plus a menu entry
#     and icon so the app shows up in your desktop's app launcher
#
# This script does not, and will never, download or bundle DeepCool's own
# app.asar or its Windows installer -- see README's Installation section for
# where to get your own copy.

set -euo pipefail
ACTION="${1:-install}"

# Piped in (curl ... | bash) there is no BASH_SOURCE and no checkout around
# this script -- only this one file was downloaded. Resolving HERE the usual
# way then silently lands on the current directory, and everything below
# (electron, the launcher's run-real.sh path) points somewhere that holds no
# source. So clone the repo first and re-run the copy inside it.
SELF="${BASH_SOURCE[0]:-}"
if [ -z "$SELF" ] || [ ! -f "$(dirname "$SELF")/run-real.sh" ]; then
  REPO="${MYSTIQUECTL_REPO:-https://github.com/sowndev0106/mystiquectl.git}"
  DEST="${MYSTIQUECTL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mystiquectl}"
  command -v git >/dev/null 2>&1 || { echo "error: git is needed to fetch mystiquectl -- install it and re-run" >&2; exit 1; }
  if [ -d "$DEST/.git" ]; then
    printf 'updating existing checkout in %s ...\n' "$DEST"
    git -C "$DEST" pull --ff-only
  elif [ -e "$DEST" ]; then
    echo "error: $DEST exists but is not a git checkout -- move it aside or set MYSTIQUECTL_DIR" >&2; exit 1
  else
    printf 'cloning mystiquectl into %s ...\n' "$DEST"
    mkdir -p "$(dirname "$DEST")"
    git clone --depth 1 "$REPO" "$DEST"
  fi
  # Already pulled just above, so the copy in there needn't pull again.
  exec env MYSTIQUECTL_PULLED=1 MYSTIQUECTL_LAUNCH=1 bash "$DEST/install.sh" "$@"
fi
HERE="$(cd "$(dirname "$SELF")" && pwd)"

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
if [ "$ACTION" = update ] && [ -z "${MYSTIQUECTL_PULLED:-}" ]; then
  if [ -d "$HERE/.git" ]; then
    log "updating source (git pull --ff-only)..."
    git -C "$HERE" pull --ff-only
    # The rest of this run would otherwise be the old install.sh bash already
    # read in -- re-run the one that was just pulled, so its changes apply now
    # and not only on the next update.
    exec env MYSTIQUECTL_PULLED=1 bash "$HERE/install.sh" "$@"
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
# Only a pointer into the checkout: what `mystiquectl` does lives in the
# repo's own ./mystiquectl, so a git pull updates it without re-running this.
cat > "$BIN_DIR/mystiquectl" <<LAUNCHER
#!/usr/bin/env bash
# Generated by install.sh -- re-run install.sh to regenerate, don't edit by hand.
exec "$HERE/mystiquectl" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/mystiquectl"
log "launcher installed: $BIN_DIR/mystiquectl"

case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH -- add to your shell rc: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --------------------------------------------------- menu entry and icon --
# Exec is the launcher's absolute path: a desktop session's PATH often lacks
# ~/.local/bin even when an interactive shell's has it. StartupWMClass is the
# app's own package.json name, which Electron uses as the window class -- it
# is what lets the dock group the running window under this icon.
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
mkdir -p "$DATA_DIR/applications" "$DATA_DIR/icons/hicolor/scalable/apps"
cp "$HERE/packaging/mystiquectl.svg" "$DATA_DIR/icons/hicolor/scalable/apps/mystiquectl.svg"
cat > "$DATA_DIR/applications/mystiquectl.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=mystiquectl
GenericName=Cooler Control
Comment=Control the DeepCool MYSTIQUE LCD cooler (unofficial)
Exec="$BIN_DIR/mystiquectl"
Icon=mystiquectl
Terminal=false
Categories=Utility;System;HardwareSettings;
Keywords=deepcool;mystique;cooler;lcd;aio;
StartupWMClass=DeepCool
DESKTOP
have update-desktop-database && update-desktop-database "$DATA_DIR/applications" >/dev/null 2>&1 || true
log "menu entry installed: $DATA_DIR/applications/mystiquectl.desktop"

log ""
log "done. Run 'mystiquectl' (or pick mystiquectl in your app menu) to start the app against your real cooler."
log "Run '$HERE/install.sh update' (or 'mystiquectl update') any time to pull the latest source and refresh electron."

# ---------------------------------------------------------------- launch --
# Only for the curl | bash path: someone who ran ./install.sh by hand, or the
# packaged /usr/bin wrapper that calls this and then starts the app itself,
# would otherwise get it started twice.
if [ -n "${MYSTIQUECTL_LAUNCH:-}" ]; then
  why=""
  # Not grep -q: under pipefail its early exit can SIGPIPE lsusb and turn a
  # match into a failure.
  if ! lsusb 2>/dev/null | grep '3633:0009' >/dev/null; then
    why="no MYSTIQUE cooler (3633:0009) plugged in"
  elif [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    why="no desktop session to show it on"
  elif [ ! -x "$ELECTRON_DIR/electron" ]; then
    why="electron is missing from $ELECTRON_DIR"
  elif ! grep -qa DC_CAPTURE_DIR "$ASAR" 2>/dev/null; then
    why="no app.asar with the shim installed (see the warnings above)"
  fi
  if [ -n "$why" ]; then
    log "not starting the app: $why -- fix that, then run 'mystiquectl'."
  else
    # Detached, so the terminal comes back and closing it doesn't take the
    # app down; mystiquectl notices it has no terminal and reports a failed
    # start as a desktop notification instead.
    log "starting mystiquectl ..."
    setsid -f "$BIN_DIR/mystiquectl" </dev/null >/dev/null 2>&1
  fi
fi
