# Contributing to mystiquectl

Thanks for considering a contribution. mystiquectl is a small, reverse-engineered
Linux compatibility layer for DeepCool's MYSTIQUE 360 LCD AIO cooler, built by
repacking DeepCool's own official Electron app with a USB recording/replay shim.
It has no affiliation with DeepCool. Because it depends on protocol details
nobody outside DeepCool has documented, contributions that touch the
shim/protocol layer are held to a higher evidentiary bar than a typical bug fix
-- see "Protocol changes" below before you start.

## Before you file an issue

1. Search existing issues first -- someone may have already hit the same thing.
2. Say whether you were testing against **real hardware** (a physical MYSTIQUE,
   USB vendor:product `3633:0009`) or the **synthetic/fake device** used for
   protocol capture and CI-less testing. Bug reports and protocol claims mean
   very different things depending on which one you used.
3. Include your distro, kernel version (`uname -r`), and, if the issue involves
   USB communication at all, the output of `lsusb -v -d 3633:0009` (redact
   nothing -- there's no personal data in a USB descriptor dump) and any
   relevant `impl/usb-bridge.py` log output.
4. Use the issue templates under `.github/ISSUE_TEMPLATE/` -- they ask for
   exactly the fields above plus reproduction steps.

## Proposing changes

We use the standard GitHub fork-and-pull-request workflow:

1. Fork the repository and create a branch off `main` with a short, descriptive
   name (`fix/usb-bridge-socket-perms`, not `patch-1`).
2. Make your change. Keep the diff focused on one thing -- a bug fix, a single
   feature, a single refactor. Large, multi-purpose PRs are much harder to
   review honestly and are more likely to sit unreviewed; if you have several
   unrelated changes, open several PRs.
3. Write a commit message that explains *why*, not just *what*.
4. Open a pull request using `.github/PULL_REQUEST_TEMPLATE.md`. Fill in every
   section, especially the testing section -- see "Testing your change" below.
5. Be responsive to review feedback. Since this is a small/single-maintainer
   project, review can take a while; a gentle bump after a week or two is fine.

## Coding style

This project deliberately keeps its dependency footprint minimal, and PRs are
expected to preserve that rather than grow it:

- **Python**: stdlib-only wherever at all possible. The one accepted exception
  is `pyusb` (the `python3-usb` distro package), used solely by
  `impl/usb-bridge.py` to talk to the real cooler over libusb1. Don't add a
  new pip dependency to solve a problem the standard library already handles
  (`argparse`, `json`, `socket`, `struct`, `subprocess`, etc. cover almost
  everything this codebase needs). If you think a new dependency is genuinely
  justified, open an issue to discuss it before sending the PR.
- **JavaScript** (`impl/*.js`, `shim/usb-shim.js`, `driver/*.js`): Node
  built-ins only (`fs`, `path`, `net`, `os`, `child_process`, `events`,
  `crypto`, `module`, ...). There is intentionally no `package.json` and no
  `node_modules` -- everything runs inside the vendored Electron 23.3.13
  binary's bundled Node runtime. Do not introduce an npm dependency or add a
  build step.
- Match the existing style of whichever file you're editing (naming,
  indentation, error-handling conventions) rather than introducing a new
  convention in one corner of the codebase.
- No placeholder/TODO code in a submitted PR -- if a piece isn't finished,
  mark the PR as a draft instead.

## Protocol changes

Everything this project knows about the MYSTIQUE's USB protocol was learned by
recording and replaying real traffic (see `shim.py`, `analyze.py`, `map.py`,
`sweep.py`) -- there is no vendor spec to consult. Because of that, a PR that
adds or changes a **protocol finding** (a new command byte, a new report
format, a new field meaning, a changed timing/handshake assumption, etc.) must
say how it was captured or verified, not just assert a value. Concretely,
please include in the PR description:

- What you ran to capture the traffic (e.g. `shim.py` in record mode against
  the official DeepCool app, `sweep.py` output, a `capture*/` directory's
  contents) and against which firmware/app version.
- Whether you reproduced it more than once, and whether it was confirmed
  against real hardware or only inferred from a capture.
- If you're drawing on prior research outside this repo (for example, an
  earlier `~/deepcool-mystique-re` capture set from before this project had
  its current name), say so and describe what that source contains -- don't
  assume the reviewer has access to it.

Speculative or guessed protocol values without any capture/verification story
behind them will most likely be asked to be re-done rather than merged as-is.

## Testing your change before submitting

This repo's correctness tool is `e2e.py`. Run it before submitting any change
that touches `shim/`, `shim.py`, `impl/`, or `driver/`:

```sh
./e2e.py
```

A few things to know:

- Most of the suite runs fine against the **synthetic/fake device** with no
  real cooler attached, and this is what most contributors will be running.
- A subset of checks (the "real hardware" section) only runs, and only means
  anything, with a real MYSTIQUE plugged in over USB (`3633:0009`). If you
  don't have the hardware, that's fine -- just say so in the PR's testing
  section rather than claiming full coverage.
- The full suite spins up Xvfb and a real Electron process and takes several
  minutes. It is a local/manual verification tool; it is **not** run by CI
  (CI runners have no USB device and no GPU/display), so don't expect a CI
  job to catch protocol regressions for you.
- For changes confined to a single layer, the narrower drivers under
  `driver/` (invoked by `e2e.py`, but runnable standalone against a running
  shim) and `sweep.py` / `analyze.py` / `map.py` are often faster to iterate
  with than the full suite.

If a change genuinely can't be exercised by `e2e.py` (e.g. it only affects
`install.sh` or documentation), say so explicitly in the PR instead of leaving
the testing section blank.

## A note on scope

mystiquectl repacks DeepCool's own official `app.asar` at install time; it does
not and must never bundle it. If your change assumes the presence of a
specific `app.asar` build, describe the DeepCool app version you tested
against, since different Windows installer versions may ship a different
bundle internally.

## License

By submitting a contribution, you agree it will be distributed under this
project's license, GPL-3.0 (see `LICENSE`).
