---
name: Feature request
about: Suggest an idea or protocol addition for mystiquectl
title: "[Feature] "
labels: enhancement
assignees: ''
---

<!--
mystiquectl works by repacking DeepCool's own official Electron app.asar with
a USB shim, and by reimplementing the Windows-only sensor/telemetry services
that app expects. Most "feature requests" here are really one of:
  (a) exposing something the DeepCool app's UI already does, that isn't
      wired up correctly on Linux yet, or
  (b) a new USB protocol finding (a mode, a setting, a byte) discovered by
      capturing real traffic.
Please say which kind this is -- it changes what evidence is useful.
-->

## Is this a UI/behavior gap or a new protocol finding?

<!-- Pick one and delete the other section below if it doesn't apply. -->

### If it's a UI/behavior gap

- **What DeepCool app feature is affected**: <!-- e.g. a Computer
  Configuration page field, a fan curve mode, a display theme -->
- **What happens today on Linux**: <!-- stubbed out, wrong value, crashes, etc. -->
- **What the Windows app does** (if you've used it): <!-- ... -->

### If it's a new protocol finding

- **What you captured**: <!-- e.g. a new command byte, a report field, a
  timing requirement -->
- **How you captured/verified it**: <!-- shim.py record mode against the
  real DeepCool app + real hardware, sweep.py output, analyze.py output,
  a prior ~/deepcool-mystique-re capture, etc. -- see CONTRIBUTING.md's
  "Protocol changes" section for what's expected here -->
- **Reproduced more than once?**: <!-- yes/no -->

## Environment (if relevant)

- **Cooler model / PID**: <!-- e.g. DeepCool MYSTIQUE 360, USB `3633:0009` -->
- **Testing mode**: <!-- real hardware, synthetic/fake device, or both -->
- **Distro / kernel version**: <!-- e.g. Fedora 40, `uname -r` output -->

## Proposed solution

<!-- What you'd like to see happen. If you're willing to submit a PR for
this, say so -- see CONTRIBUTING.md. -->

## Alternatives considered

<!-- Any workarounds you're using today, or other approaches you considered. -->

## Additional context

<!-- Capture files, screenshots of the DeepCool Windows app, links to prior
discussion, etc. -->
