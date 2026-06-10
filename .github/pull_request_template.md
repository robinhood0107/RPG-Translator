## Summary

-

## Implementation Summary

- [ ] Describes implemented behavior and user-visible or developer-visible effects.
- [ ] Describes changed verification or guard behavior when relevant.
- [ ] Uses objective feature, implementation, and verification facts only.

## Public Wording Guard

- [ ] Issue and pull request text uses public-facing behavior and verification wording only.
- [ ] No private document names, private filesystem locations, provenance claims, or private source labels are included.
- [ ] Historical cleanup is not repeated unless a fresh scan reports a current match.

## Repository Boundary

- [ ] No private, generated, sensitive, or machine-local files staged.
- [ ] No API keys, model files, translated game builds, runtime exports, logs, screenshots, databases, benchmark output, or generated build/cache output included.
- [ ] Committed tests use synthetic/mock fixtures only.

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
- [ ] `scripts/check-github-public-copy.sh --stdin < .github/pull_request_template.md`
