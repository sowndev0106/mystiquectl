---
name: Bug report
about: Report something broken in mystiquectl
title: "[Bug] "
labels: bug
assignees: ''
---

<!--
Thanks for taking the time to file a bug. Please fill in as much of this as
you can -- reports missing the hardware/testing-mode context are much harder
to act on, since this project's behavior depends heavily on whether you're
running against a real cooler or the synthetic/fake device.
-->

## Summary

<!-- One or two sentences describing the problem. -->

## Environment

- **Cooler model / PID**: <!-- e.g. DeepCool MYSTIQUE 360; USB PID should be
  `0009` (vendor `3633`) if this is the supported device -- run
  `lsusb -d 3633:` to confirm and paste the exact line -->
- **Testing mode**: <!-- real hardware, synthetic/fake device, or both -->
- **Distro + version**: <!-- e.g. Arch, Fedora 40, Ubuntu 24.04 -->
- **Kernel version**: <!-- output of `uname -r` -->
- **How you ran the tool**: <!-- run.sh / run-real.sh / run-ui.sh / run-only.sh / other -->
- **DeepCool app.asar source/version**: <!-- which official DeepCool Windows
  installer version you extracted app.asar from, if known -->
- **Electron version in `.electron/`**: <!-- should be 23.3.13 unless you
  changed something -->

## Steps to reproduce

1.
2.
3.

## Expected behavior

<!-- What you expected to happen. -->

## Actual behavior

<!-- What actually happened. Paste exact error text/output where possible. -->

## Logs / capture attachments

<!--
If this involves USB communication, please attach or paste relevant output:
- `impl/usb-bridge.py` console output
- The relevant `capture*/` directory contents (if you ran shim.py in record
  mode), or e2e.py output
- `lsusb -v -d 3633:0009` output

If a log or capture file is large, attach it as a file rather than pasting
inline; if it's sensitive for some reason, say so and we can discuss a
private channel.
-->

## Additional context

<!-- Anything else relevant: recent changes, whether this is a regression
from a version that used to work, etc. -->
