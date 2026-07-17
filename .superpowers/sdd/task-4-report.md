# Task 4 Report

## Status

DONE

## Commit

- `cdf59ff` — `test: enable colocated bun test discovery`
- `1395229` — `test: preserve package verification paths`
- `d210005` — `test: preserve root verification coverage`

## Changes

- Changed `test:unit` to `bun test` in core, plugin SDK, GitHub Copilot, and OpenAI ChatGPT packages.
- Changed CLI and server `test:unit` to `bun test --preload=./_test/setup.ts`.
- Preserved all existing `test` scripts and CLI/server preload behavior.
- `bun.lock` was unchanged.
- Follow-up: changed plugin SDK `test` to run both `test:unit` and `test:types`.
- Follow-up: changed OpenAI ChatGPT `test` to delegate to `test:unit`.
- Follow-up: added plugin SDK `test:types` explicitly to root `preflight` after `turbo run test:unit`.
- Follow-up: changed GitHub Copilot `test` to delegate to `test:unit`.

## Verification

- `rtk bun run --filter @aio-proxy/core test:unit` — 463 passed across 45 files.
- `rtk bun run --filter @aio-proxy/cli test:unit` — 147 passed across 11 files.
- `rtk bun run --filter @aio-proxy/server test:unit` — 376 passed across 28 files.
- `rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test:unit` — 26 passed across 5 files, including `src/catalog.test.ts` and all existing `_test/` suites.
- `rtk bun run --filter @aio-proxy/plugin-sdk test:unit` — 16 passed across 2 files.
- `rtk bun run --filter @aio-proxy/plugin-sdk test:types` — passed.
- `rtk bun run --filter @aio-proxy/plugin-github-copilot test:unit` — 20 passed across 2 files.
- `rtk bun run check` — exit 0; reported pre-existing informational Biome diagnostics outside this change.
- `rtk git diff --check` — passed before commit.

## Follow-up Verification

- `rtk bun run --filter @aio-proxy/plugin-sdk test` — 16 unit tests passed across 2 files, then `tsc -p tsconfig.test.json` passed; exit 0.
- `rtk bun run --filter @aio-proxy/plugin-openai-chatgpt test` — 26 tests passed across 5 files, including `src/catalog.test.ts` and all existing `_test/` suites; exit 0.
- `rtk git diff --check` — passed before follow-up commit.
- Manifest assertions confirmed plugin SDK `test` includes unit and type suites, and ChatGPT `test` delegates to `test:unit`.
- `bun.lock` remained unchanged.

## Final Follow-up Verification

- `rtk bun run --filter @aio-proxy/plugin-sdk test:types` — TypeScript contract checks passed; exit 0.
- `rtk bun run --filter @aio-proxy/plugin-github-copilot test` — 20 tests passed across 2 files through `test:unit`; exit 0.
- Manifest validation confirmed root `preflight` runs `bun run --filter @aio-proxy/plugin-sdk test:types` after all unit suites.
- Manifest validation confirmed GitHub Copilot `test` delegates to `bun run test:unit` while `test:unit` remains exact `bun test`.
- `rtk git diff --check` — passed before final follow-up commit.
- `bun.lock` remained unchanged.

## Review

- Spec review: no findings.
- Review follow-ups resolved all findings: plugin SDK type contracts remain in package and root verification paths, and both built-in plugin `test` scripts delegate to broad `test:unit` discovery.

## Concerns

- None.
