# Security Policy

## Scope

mystiquectl is a **local device-control tool**. It runs on your own machine,
talks to a DeepCool MYSTIQUE 360 LCD AIO cooler over USB (either the real
device at vendor:product `3633:0009` or a synthetic/fake device used for
protocol capture and testing), and repacks DeepCool's own official Electron
`app.asar` (which you supply yourself -- this repo never bundles it) to run
natively on Linux. There is no server component, no network service exposed
to other hosts, and no account system.

Given that shape, the realistic attack surface is local, not remote. Areas we
consider in-scope for a security report include:

- **`impl/usb-bridge.py`'s Unix domain socket.** This bridge process is what
  actually forwards commands to the real cooler's USB endpoint on behalf of
  the repacked Electron app. If its socket is created with overly permissive
  file permissions (world-writable or world-readable) or in a predictable,
  shared location, another local user on a multi-user system could
  potentially inject commands to the cooler or read traffic intended for
  another user. Reports about socket permissions, path predictability, or
  missing peer-credential checks on this socket are welcome.
- **The recording/replay shim's test-only hooks.** `shim/usb-shim.js` and
  `shim.py` support environment-variable-driven test hooks (such as
  `DC_PICK_FILE`-style overrides) used only for capturing and replaying USB
  traffic during development. These hooks are **not** meant to be enabled in
  a normal end-user install -- if you find a way for them to be triggered
  unintentionally in a default/normal run (i.e. without the operator
  deliberately setting the relevant env var), that's a legitimate finding.
- Anything else that would let a co-located, unprivileged local user tamper
  with another user's cooler session, escalate privileges, or execute
  arbitrary code via a file this tool parses (capture files, config, media
  uploaded through the app's own media-upload feature, etc.).

**Out of scope**: vulnerabilities that require the reporter to already have
root, or to already control the DeepCool `app.asar` the user chooses to point
this tool at (that file is trusted input the user supplies themselves from
DeepCool's own installer); vulnerabilities purely within Electron itself,
which should instead be reported to the [Electron project](https://github.com/electron/electron/security)
(this project pins and fetches an official upstream Electron release and does
not patch it); and vulnerabilities in DeepCool's own official Windows
software, which is out of this project's control and should be reported to
DeepCool.

## Reporting a Vulnerability

Please report security issues privately using
[GitHub's private security advisory feature](../../security/advisories/new)
on this repository, rather than opening a public issue. This lets us discuss
and fix the issue before any details are public.

If you're unsure whether something qualifies, or the private advisory form
isn't available to you for some reason, opening a regular (public) GitHub
issue with as few exploit-relevant details as possible, and a note asking a
maintainer to move the conversation private, is an acceptable fallback.

Please include, where relevant:

- The affected file(s)/component (e.g. `impl/usb-bridge.py`,
  `shim/usb-shim.js`).
- Whether reproducing it requires the real hardware or only the synthetic
  device.
- Your OS/distro and how you ran the tool (`run.sh`, `run-real.sh`, etc.).
- Steps to reproduce, or a minimal proof of concept.

## Response

This is a small, unfunded, reverse-engineering compatibility project
maintained on a best-effort basis. There is **no bug bounty program** and no
guaranteed response SLA, but security reports will be prioritized over
ordinary feature requests and we'll do our best to acknowledge a report and
work out a fix and coordinated disclosure timeline with you.

## Supported Versions

There are no long-term-supported release branches at this time; security
fixes are made against the latest state of the default branch. If the project
starts tagging releases, this section will be updated to reflect which
versions receive fixes.
