Status: COMPLETE

Implemented dispatch using the leased provider snapshot. The server now resolves the committed ChatGPT Responses raw wrapper by package ID, passes only the original transport and guardian evaluator, and falls back to the selected transport when no wrapper is registered. Integration coverage builds the real plugin registry/setup path, verifies the api-review/evaluation accounting, and verifies direct transport fallback without a wrapper.

Tests: `cd packages/server && bun test --preload=./__tests__/setup.ts src/routes/pipeline/guardian-integration.test.ts` — 18 passed.

Concerns: The broader `raw-session.test.ts` run currently includes unrelated failures from concurrent workspace changes; the focused guardian integration suite passes.
