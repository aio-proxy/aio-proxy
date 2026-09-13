# Codex TOML source baseline for Grok planning

This directory makes Task 3A reproducible from this PR alone. The patch contains the four original Codex config-document source and test files from local provenance commit `6c30e00ca0c22014fe75f54a2f910cf255c3b0bd`. That commit ID records provenance only; fetching or resolving it is not required.

The patch is a reference artifact, not installed production code. It contains no user configuration or credentials; tokens in tests are synthetic. It adds no dependencies to this documentation PR. The source requires `toml-eslint-parser@1.0.3` when applied for implementation.

From the repository root, when `packages/cli/src/agent/codex/config-document/` does not already exist:

```sh
rtk git apply --check docs/superpowers/references/grok-toml-baseline/codex-config-document.patch
rtk git apply docs/superpowers/references/grok-toml-baseline/codex-config-document.patch
rtk proxy shasum -a 256 -c docs/superpowers/references/grok-toml-baseline/SHA256SUMS
rtk bun add --cwd packages/cli --exact toml-eslint-parser@1.0.3
rtk bun test packages/cli/src/agent/codex/config-document
```

If Codex has since been integrated, keep the newer source and run its tests instead of applying this add-only patch. Do not overwrite existing files. Task 3A then extracts the common text-editing implementation and migrates the Codex caller; the baseline is not a second implementation to maintain.

`SHA256SUMS` records the original four files before extraction. It is an integrity check for applying this reference, not a check that the eventual refactored files must keep the same bytes.
