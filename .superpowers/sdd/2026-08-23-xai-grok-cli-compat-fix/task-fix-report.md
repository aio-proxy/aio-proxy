# xAI Grok CLI compatibility fix

- Added a regression test proving a top-level `automation_update` function is forwarded unchanged.
- Confirmed the new test failed before the production fix because the tool was sanitized.
- Updated tool matching so plain `automation_update` is recognized only inside the `codex_app` namespace; qualified `codex_app__automation_update` remains recognized at top level.
- Added a runtime regression test proving non-`/responses` request bodies are forwarded unchanged.
- Verification: `bun test packages/plugins/xai-grok/src/runtime/sanitize-responses.test.ts packages/plugins/xai-grok/src/runtime/runtime.test.ts`
- Result: 8 passed, 0 failed.
