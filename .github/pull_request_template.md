## Summary

-

## Original Reference Read

- [ ] Not applicable for this PR.
- [ ] Read only for behavior-level audit; no implementation code copied.
- Files read:
- Behavior to preserve:
- Behavior/UI to discard:
- Independent rewrite mapping:

## Local-only Exclusion

- [ ] No `SPEC.md`, `spec_ko.md`, `AGENTS.md`, `ROADMAP.md`, `dontupload/`, `.gstack/`, or local compose/test output staged.
- [ ] No API keys, model files, translated game builds, runtime exports, logs, screenshots, local DBs, benchmark output, or generated build/cache output included.
- [ ] Committed tests use synthetic/mock fixtures only and do not reference `dontupload/City_Of_Secrets`.

## Runtime And Provider Boundary

- [ ] Runtime overlay remains cache-only.
- [ ] No provider endpoint, API key, authorization header, translation queue, launcher, monitor, precacher, diagnostics window, or hotkey UI added to runtime.
- [ ] Provider calls, if any, are limited to developer app/CLI pre-translation flows.

## QA, Security, And Release Hardening

- [ ] License independence reviewed; dependency/source changes are explained.
- [ ] Release/source archive exclusion checked when relevant.
- [ ] No CD, updater, packaging publish, cloud secret workflow, or release automation added unless explicitly approved.

## Verification

- [ ] `cargo fmt --check`
- [ ] `cargo test --workspace`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo deny check`
- [ ] `npm test -- --run`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `node --test runtime/overlay-plugin/tests/runtime-overlay.test.js`
- [ ] `scripts/check-local-only.sh --staged`
- [ ] `scripts/check-local-only.sh --tree`
- [ ] `scripts/check-release-archive.sh`
