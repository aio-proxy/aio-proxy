### Task 10: Run Final Verification

**Files:**
- Modify tests only: split every touched handwritten test file over 300 lines into directly discovered concern files.
- Modify: `.superpowers/sdd/task-10-brief.md`
- Modify: `.superpowers/sdd/task-10-report.md`
- Modify: `docs/superpowers/plans/2026-07-17-oauth-plugin-main-compliance.md`
- Carry forward: tracked `.superpowers/sdd/task-4-report.md`, an intentional
  earlier-task correction already present when Task 10 began.
- No production files.

**Interfaces:**
- Confirms locally: the rebased branch passes all checks, contains no oversized touched handwritten files, and addresses the open ChatGPT catalog comment.
- Records remotely: the current published PR state; publication and the final
  mergeability recheck remain pending an authorized finishing choice.

- [x] **Step 0: Close the strict touched-test size gate without behavior changes**

Capture the focused baseline, split the 10 oversized test files by existing
concern, and compare the directly discovered split suites with the baseline:

```bash
AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/core-final rtk bun test \
  packages/core/_test/request-log-{write,summary,list}.test.ts \
  packages/core/_test/router-{resolution,aliases}.test.ts

rtk proxy sh -c 'cd packages/server && \
  AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/server-final \
  bun test --preload=./_test/setup.ts \
  _test/anthropic-messages-{native,model,failures,count-tokens}.test.ts \
  _test/dashboard-providers-mutation-{basic,aliases,concurrency}.test.ts \
  _test/gemini-generate-content-{native,model,stream,routing}.test.ts \
  _test/openai-completions-{native,model-stream,usage,fallback,errors,boundaries}.test.ts \
  _test/openai-responses-{native,model,unsupported}.test.ts \
  _test/pipeline-{boundaries,raw-fallback,model-stream,terminal}.test.ts \
  _test/server-{health-models,model-ordering,config,provider-probe,plugin-install}.test.ts'

AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/types-final rtk bun test \
  packages/types/_test/schemas-{config-acceptance,config-rejection,provider-mutation,provider-alias-mutation,events}.test.ts
```

Expected: Core remains 34 tests / 90 assertions, Server remains 165 tests /
498 assertions, and Types remains 44 tests / 70 assertions. Every new
handwritten test and support file is at most 300 lines, original test names and
assertions are preserved, and no side-effect import shell is introduced.

- [x] **Step 1: Check touched source sizes without adding repository tooling**

```bash
rtk proxy sh -c '
base=$(git merge-base origin/main HEAD)
git diff --diff-filter=AM --name-only "$base"...HEAD -- "*.ts" "*.tsx" "*.js" "*.jsx" |
while IFS= read -r file; do
  [ -f "$file" ] || continue
  lines=$(wc -l < "$file" | tr -d " ")
  [ "$lines" -gt 300 ] && printf "%s\t%s\n" "$lines" "$file"
done
'
```

Expected: no output.

- [x] **Step 2: Run complete local verification**

```bash
rtk bun run check
AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/unit rtk bun run test:unit
rtk bun run build
AIO_PROXY_HOME=/tmp/aio-proxy-task10-split/cli-binary rtk bun run --filter @aio-proxy/cli build:binary
rtk bunx tsc --noEmit -p packages/server/tsconfig.json
rtk git diff --check
rtk git status --short
```

Expected: all commands pass; the worktree contains only intentional changes.

- [x] **Step 3: Inspect current PR comments and published mergeability**

```bash
rtk proxy python3 /Users/bytedance/.codex/plugins/cache/openai-curated-remote/github/0.1.8-2841cf9749ae/skills/gh-address-comments/scripts/fetch_comments.py
rtk gh pr view 29 --json mergeable,mergeStateStatus,headRefOid
```

Observed: the ChatGPT catalog comment is addressed in verified local code, but
the published PR head remains `CONFLICTING`/`DIRTY`. Do not reply to or resolve
the GitHub thread without explicit user authorization.

- [ ] **Step 4: Publish the verified branch and recheck remote mergeability**

This is a finishing choice, not a local verification step. Only after explicit
authorization to push:

```bash
rtk git push --force-with-lease origin codex/oauth-plugin-system-design
rtk gh pr view 29 --json mergeable,mergeStateStatus,headRefOid
```

Expected after authorized publication: the PR head matches the verified local
commit and mergeability is re-evaluated. Force-push is not authorized yet, so
this step remains pending.

## Self-Review

- Spec coverage: rebase/conflicts, corrected Dashboard type interpretation, raw ChatGPT catalog with hidden models retained, es-toolkit import, Dashboard form/component rules, Bun colocation, all confirmed production/test size violations, and final PR comment verification are covered.
- Intentionally excluded: moving shared DTOs from `@aio-proxy/types` to `@aio-proxy/server`, adding Rstest outside Dashboard, calling Codex's internal authenticated `/models` endpoint, and changing OAuth behavior during file splits.
- Placeholder scan: local verification has no deferred implementation
  decisions; remote publication remains an explicit finishing choice.
- Type consistency: catalog exports, TTL constant, public OAuth/core/CLI/server signatures, and directory entry points match current names.
