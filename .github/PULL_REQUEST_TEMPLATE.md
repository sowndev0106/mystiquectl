## What changed

<!-- Describe the change concisely. If it touches the USB shim/protocol
layer (shim.py, shim/usb-shim.js, impl/usb-bridge.py) or adds/changes a
protocol finding, summarize what changed at that level too. -->

## Why

<!-- What problem does this solve, or what does it enable? Link any related
issue (e.g. "Fixes #123"). -->

## How was this tested?

<!-- Required. Be specific -- "it works" isn't enough for anything touching
shim/protocol code. -->

- [ ] Ran `./e2e.py` and it passed (paste the pass/fail summary below)
- [ ] Tested against **real hardware** (MYSTIQUE, USB `3633:0009`)
- [ ] Tested against the **synthetic/fake device** only
- [ ] Not applicable / testing not possible for this change (explain why below)

```
<!-- paste relevant e2e.py output, or driver/*.js output, here -->
```

If you tested against real hardware, what distro/kernel? If this PR adds a
new protocol finding, how was it captured/verified (see CONTRIBUTING.md's
"Protocol changes" section) -- please don't submit guessed values without a
capture behind them.

## Checklist

- [ ] The change is focused (one fix/feature/refactor per PR, not several
      unrelated changes bundled together)
- [ ] No new npm or pip dependency was added (or, if one genuinely seems
      necessary, it's called out explicitly here and was discussed in an
      issue first)
- [ ] No placeholder/TODO code left in
- [ ] This PR does **not** bundle DeepCool's `app.asar` or any other file
      extracted from DeepCool's official installer
- [ ] Docs (`README.md`, `CONTRIBUTING.md`, etc.) updated if behavior or
      setup steps changed

## Additional context

<!-- Anything else a reviewer should know: follow-up work you're planning,
known limitations, alternatives you considered and rejected, etc. -->
