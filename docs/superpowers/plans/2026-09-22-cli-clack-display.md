# CLI Clack Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move aio-proxy CLI prompts and the named human-readable result views onto one `@clack/prompts` display layer without changing Commander, config, auth, logs, or exit codes.

**Architecture:** `packages/cli/src/ui/` owns TTY/color gates, a Clack adapter, one lazy command session, and pure summary strings. Commands keep their business checks and call the session only after the existing non-interactive failure would not already apply. Query commands print summary strings through the current `print` / `console.log` path and never open a session.

**Tech Stack:** TypeScript, Bun test, `@clack/prompts` 1.8.1, Paraglide (`@aio-proxy/i18n`), Commander (unchanged), Changesets.

**Spec:** `docs/superpowers/specs/2026-09-22-cli-clack-display-design.md`

**Branch:** Implement on the existing branch `cursor/cli-clack-display-spec-c50a`. The spec is already committed there. Do not open a second pull request.

## Global Constraints

- Dependency: add only `@clack/prompts` at exactly `1.8.1` in `packages/cli/package.json`. Do not add it to the root catalog. Do not add or import `@clack/core`.
- Components: `text`, `password`, `confirm`, `select`, `multiselect`, `intro`, `outro`, `cancel`, `note`, `spinner`, `isCancel`, `updateSettings`, plus each call's `signal`, `input`, and `output`. Do not use `group`, `tasks`, `progress`, `box`, `stream`, `autocomplete`, `path`, or `date`.
- Leave `withGuide` at the library default. No second border, ASCII logo, gradient, or decorative emoji.
- Interactive titles use the brand string `aio-proxy`, including when argv0 is `aiop`.
- One `intro` per command. `renderConfigSpec`, capability selection, and the manual callback do not print their own title. Print `intro` on the first real prompt or the Codex note. No prompt and no note means no `intro` and no `outro`.
- A success path that printed `intro` uses one `outro` as the completion sentence. Do not add a second "完成" line. A prompt cancel calls `cancel` once and does not call `outro`. A spinner cancel keeps the library's cancel line and does not call `cancel` again. Codex cancellation that becomes Codex's own result prints neither `cancel` nor `outro`.
- Plugin sentences move from stdout to that `outro` only when a prompt ran: `cli.plugin.added`, `cli.provider.package_installed`, `cli.plugin.configured`, `cli.plugin.removed_secrets_purged`, `cli.plugin.removed_secrets_retained`, `cli.plugin.pruned`. With no prompt they stay on stdout.
- Provider login stdout stays the provider id only. Its `outro` is the new short sentence, and only if a prompt ran.
- Codex's existing multi-line result stays on stdout. Its `outro` is a new short sentence and does not repeat the result lines.
- Prompts, spinner, `intro`, `outro`, and `cancel` write to stderr. Data that is stdout today stays on stdout. The `run` startup summary stays on stderr.
- `status`, `doctor`, provider list, and plugin list are not sessions and do not print `intro`.
- Prompting, color, and machine output are three separate switches. `canPrompt` does not know about `--json`.
- The adapter throws `PromptCancelledError` for a Clack cancel value. UI code does not call `process.exit` and does not install an exiting SIGINT handler.
- `close` only stops a leftover spinner and restores the terminal. It does not print `Error.message`, does not call `outro` for a failure, and does not mutate the error. A prompt-originated `PromptCancelledError` calls `cancel` once. If the spinner already printed its cancel line, `close` does not print a second one. Failure after an intro does not get an outro.
- `formatCliError` returns `{ message: '' }` for `PromptCancelledError` before any other branch. Do not add that error to `isKnownCliUserError`. `toExitCode` stays `2`. `main` already skips an empty formatted message.
- `spin` passes an `AbortSignal` into the task and awaits the task until that task settles. Do not use `Promise.race`. User Ctrl+C aborts that signal and, after the task settles, rejects `PromptCancelledError`. An external abort rejects `signal.reason`. `@clack/prompts` 1.8.1 writes the spinner cancel line and then calls `onCancel`; a later `clear()` does not erase that line.
- Delete `@inquirer/prompts` only after every call site has moved.
- New copy goes into all five locales: `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`. Compile with `bun run i18n:compile`.
- Clack `confirm` gets localized `active` / `inactive`. When the caller omits `initialValue`, the adapter passes `false` (the library default is `true`).
- `updateSettings` sets the visible library `cancel` and `error` messages. The select footer has no message slot; leave it.
- Do not change `EXIT` or `toExitCode`. Do not add `PromptCancelledError` to `isKnownCliUserError`.
- Do not change LogTape, Commander Help, command names, flags, config format, or `@aio-proxy/plugin-sdk`.
- Do not add `--json` to a command that does not have it.
- Do not roll back a finished npm install, config write, or external login.
- Password mask is `*`. A placeholder is never the submitted value. Secret empty submit stays `""`. Number `0` stays numeric `0`. Boolean `false` is a real answer.
- `ui/index.ts` is the only file outside `ui/` may import. `ui/` does not import the form package.
- Handwritten non-test files stay at or under 500 lines. Colocate tests next to their source. Do not add a new `_test/` file.
- Every commit needs `export PATH="$HOME/.bun/bin:$PATH"` so lefthook can find `bunx`. Do not skip hooks.

---

## File Structure

- `packages/cli/src/ui/mode/` — `canPrompt`, `useColor`. No Clack import. Same-name directory: `index.ts` (exports only), `mode.ts`, `mode.test.ts`.
- `packages/cli/src/ui/prompts/` — ask types, `PromptCancelledError`, `createClackPrompts`. Same-name directory with export-only `index.ts`.
- `packages/cli/src/ui/session/` — lazy intro, outro, cancel, spinner, static progress. Same-name directory with export-only `index.ts`.
- `packages/cli/src/ui/summary/` — pure strings for status, doctor, and lists. Same-name directory with export-only `index.ts`.
- `packages/cli/src/ui/index.ts` — re-exports only from the four directories.
- `packages/cli/src/plugin-commands/form/render.ts` — map fields onto the new ask types. Visibility, `compatibleDefault`, schema, and secret boundaries stay.
- `packages/cli/src/plugin-commands/plugin/deps.ts` — `openSession` seam and production `canPrompt`.
- `packages/cli/src/plugin-commands/plugin/add.ts`, `configure.ts`, `remove.ts` — one session around prompts; success sentence follows intro.
- `packages/cli/src/plugin-commands/provider-login/capability.ts` and `deps.ts` — select/confirm/manual URL through the session.
- `packages/cli/src/agent/codex/codex.ts` and `wizard/wizard.ts` — Clack prompts, `session.spin`, `session.note`; drop the hand-rolled spinner.
- `packages/cli/src/status/status.ts`, `doctor/doctor.ts`, `provider-commands.ts`, `run/run.ts` — call summary formatters. `--json` stays.
- `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json` — `cli.ui.*`.
- `.changeset/cli-clack-display.md` — product note, last task only.

`PluginFormPrompts` moves to `ui/prompts/`. `packages/cli/src/plugin-commands/form/index.ts` re-exports that type from the ui barrel so existing form imports keep compiling. The ui barrel must not import `form`.

Production commands that can prompt take an optional `openSession` on their deps. Existing harnesses leave it unset, so they keep stub prompts and stdout success lines. `createCommandSession` itself throws when `canPrompt` is false and must not read stdin.

`CommandSession.finish` returns `boolean`: `true` when it wrote an outro. Callers print the success sentence on stdout only when it returns `false`. The spec's `finish(): void` cannot tell the caller which stream owns the sentence.

`confirm`, `select`, and `multiselect` take an optional `PromptContext` so the manual OAuth confirm can pass the login `AbortSignal`. The spec's prompt-context section requires that signal; the printed `CommandSession` block omitted the argument.

`progress(message)` writes one static stderr line and does not animate. This cycle's commands do not call it. `session.spin` is the Codex session scan. `run` is not spun.

---

### Task 1: Prompt and color gates

**Files:**
- Create: `packages/cli/src/ui/mode.ts`
- Test: `packages/cli/src/ui/mode.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export type PromptIo = { readonly stdinIsTTY: boolean; readonly stderrIsTTY: boolean; readonly env: NodeJS.ProcessEnv }`
  - `export function canPrompt(io: PromptIo): boolean`
  - `export function useColor(streamIsTTY: boolean, env: NodeJS.ProcessEnv): boolean`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/ui/mode.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { canPrompt, useColor, type PromptIo } from './mode';

const tty = (env: NodeJS.ProcessEnv = {}): PromptIo => ({
  stdinIsTTY: true,
  stderrIsTTY: true,
  env,
});

describe('canPrompt', () => {
  test('prompts only when stdin and stderr are TTYs and CI is unset, empty, 0, or false', () => {
    expect(canPrompt(tty())).toBe(true);
    expect(canPrompt(tty({ CI: '' }))).toBe(true);
    expect(canPrompt(tty({ CI: '0' }))).toBe(true);
    expect(canPrompt(tty({ CI: 'false' }))).toBe(true);
    expect(canPrompt(tty({ CI: 'true' }))).toBe(false);
    expect(canPrompt(tty({ CI: '1' }))).toBe(false);
    expect(canPrompt({ ...tty(), stdinIsTTY: false })).toBe(false);
    expect(canPrompt({ ...tty(), stderrIsTTY: false })).toBe(false);
  });

  test('stdout TTY and NO_COLOR do not decide prompting', () => {
    expect(canPrompt(tty({ NO_COLOR: '' }))).toBe(true);
    expect(canPrompt(tty({ NO_COLOR: '1' }))).toBe(true);
  });
});

describe('useColor', () => {
  test('colors only a TTY stream when NO_COLOR is unset', () => {
    expect(useColor(true, {})).toBe(true);
    expect(useColor(true, { NO_COLOR: '' })).toBe(false);
    expect(useColor(true, { NO_COLOR: '1' })).toBe(false);
    expect(useColor(false, {})).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/mode.test.ts`

Expected: FAIL because `./mode` cannot be resolved.

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/ui/mode.ts`:

```ts
export type PromptIo = {
  readonly stdinIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly env: NodeJS.ProcessEnv;
};

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function canPrompt(io: PromptIo): boolean {
  return io.stdinIsTTY && io.stderrIsTTY && !isCi(io.env);
}

export function useColor(streamIsTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return streamIsTTY && env.NO_COLOR === undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/mode.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/ui/mode.ts packages/cli/src/ui/mode.test.ts
git commit -m "feat(cli): add prompt mode gates"
```

---

### Task 2: Display copy in five locales

**Files:**
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`
- Generated: `packages/i18n/src/paraglide/**` (via compile; do not hand-edit)
- Test: `packages/i18n/__tests__/locale-parity.test.ts` (existing; do not edit)

**Interfaces:**
- Consumes: nothing
- Produces: `m['cli.ui.yes']`, `m['cli.ui.no']`, `m['cli.ui.cancelled']`, `m['cli.ui.error']`, `m['cli.ui.title_plugin_add']`, `m['cli.ui.title_plugin_config']`, `m['cli.ui.title_plugin_remove']`, `m['cli.ui.title_plugin_prune']`, `m['cli.ui.title_provider_login']`, `m['cli.ui.title_codex_configure']`, `m['cli.ui.outro_provider_login']`, `m['cli.ui.outro_codex_configure']`, `m['cli.ui.provider_list_empty']`, `m['cli.ui.status_deep_unexpected']`. No placeholders.

- [ ] **Step 1: Insert the same key set into all five catalogs**

Insert this object as the first child of `"cli"` in each file. The middle dot is U+00B7.

`en.json`:

```json
"ui": {
  "yes": "Yes",
  "no": "No",
  "cancelled": "Cancelled",
  "error": "Something went wrong",
  "title_plugin_add": "aio-proxy · Add plugin",
  "title_plugin_config": "aio-proxy · Configure plugin",
  "title_plugin_remove": "aio-proxy · Remove plugin",
  "title_plugin_prune": "aio-proxy · Prune plugins",
  "title_provider_login": "aio-proxy · Provider login",
  "title_codex_configure": "aio-proxy · Configure Codex",
  "outro_provider_login": "Signed in",
  "outro_codex_configure": "Codex configuration finished",
  "provider_list_empty": "No providers",
  "status_deep_unexpected": "Provider health data could not be displayed"
},
```

`zh-Hans.json`:

```json
"ui": {
  "yes": "是",
  "no": "否",
  "cancelled": "已取消",
  "error": "出错了",
  "title_plugin_add": "aio-proxy · 添加插件",
  "title_plugin_config": "aio-proxy · 配置插件",
  "title_plugin_remove": "aio-proxy · 移除插件",
  "title_plugin_prune": "aio-proxy · 清理插件",
  "title_provider_login": "aio-proxy · 登录 Provider",
  "title_codex_configure": "aio-proxy · 配置 Codex",
  "outro_provider_login": "登录完成",
  "outro_codex_configure": "Codex 配置完成",
  "provider_list_empty": "没有 Provider",
  "status_deep_unexpected": "无法显示 Provider 健康数据"
},
```

`zh-Hant.json`:

```json
"ui": {
  "yes": "是",
  "no": "否",
  "cancelled": "已取消",
  "error": "發生錯誤",
  "title_plugin_add": "aio-proxy · 添加外掛",
  "title_plugin_config": "aio-proxy · 設定外掛",
  "title_plugin_remove": "aio-proxy · 移除外掛",
  "title_plugin_prune": "aio-proxy · 清理外掛",
  "title_provider_login": "aio-proxy · 登入 Provider",
  "title_codex_configure": "aio-proxy · 設定 Codex",
  "outro_provider_login": "登入完成",
  "outro_codex_configure": "Codex 設定完成",
  "provider_list_empty": "沒有 Provider",
  "status_deep_unexpected": "無法顯示 Provider 健康資料"
},
```

`ja.json`:

```json
"ui": {
  "yes": "はい",
  "no": "いいえ",
  "cancelled": "キャンセルしました",
  "error": "問題が発生しました",
  "title_plugin_add": "aio-proxy · プラグインを追加",
  "title_plugin_config": "aio-proxy · プラグインを設定",
  "title_plugin_remove": "aio-proxy · プラグインを削除",
  "title_plugin_prune": "aio-proxy · プラグインを整理",
  "title_provider_login": "aio-proxy · Provider にログイン",
  "title_codex_configure": "aio-proxy · Codex を設定",
  "outro_provider_login": "ログインしました",
  "outro_codex_configure": "Codex の設定が完了しました",
  "provider_list_empty": "Provider はありません",
  "status_deep_unexpected": "Provider の健全性データを表示できません"
},
```

`ko.json`:

```json
"ui": {
  "yes": "예",
  "no": "아니오",
  "cancelled": "취소했습니다",
  "error": "문제가 발생했습니다",
  "title_plugin_add": "aio-proxy · 플러그인 추가",
  "title_plugin_config": "aio-proxy · 플러그인 구성",
  "title_plugin_remove": "aio-proxy · 플러그인 제거",
  "title_plugin_prune": "aio-proxy · 플러그인 정리",
  "title_provider_login": "aio-proxy · Provider 로그인",
  "title_codex_configure": "aio-proxy · Codex 구성",
  "outro_provider_login": "로그인했습니다",
  "outro_codex_configure": "Codex 구성을 마쳤습니다",
  "provider_list_empty": "Provider가 없습니다",
  "status_deep_unexpected": "Provider 상태를 표시할 수 없습니다"
},
```

Do not edit the pre-existing wizard strings that contain the letters TODO.

- [ ] **Step 2: Compile and run parity**

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /agent/repos/aio-proxy
bun run i18n:compile
cd packages/i18n && bun test __tests__/locale-parity.test.ts
```

Expected: compile exits 0 and the parity test PASS. `m['cli.ui.yes']` typechecks after compile.

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/i18n/messages/zh-Hant.json packages/i18n/messages/ja.json packages/i18n/messages/ko.json packages/i18n/src/paraglide
git commit -m "feat(i18n): add CLI display copy"
```

---

### Task 3: Clack prompt adapter

**Files:**
- Modify: `packages/cli/package.json` dependencies
- Modify: `bun.lock` (via `bun install` from the repo root)
- Create: `packages/cli/src/ui/prompts.ts`
- Test: `packages/cli/src/ui/prompts.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1. Locale strings are not read here; callers pass `active` / `inactive` later. This task's adapter reads `m['cli.ui.yes']` and `m['cli.ui.no']` at call time for `confirm`.
- Produces:

```ts
export type PromptContext = { readonly signal?: AbortSignal };

export type TextAsk = {
  readonly message: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
};

export type PasswordAsk = { readonly message: string; readonly mask?: string };

export type ConfirmAsk = { readonly message: string; readonly initialValue?: boolean };

export type SelectChoice<T> = {
  readonly label: string;
  readonly value: T;
  readonly hint?: string;
};

export type SelectAsk<T> = {
  readonly message: string;
  readonly choices: readonly SelectChoice<T>[];
  readonly initialValue?: T;
};

export type PluginFormPrompts = {
  readonly input: (ask: TextAsk, context?: PromptContext) => Promise<string>;
  readonly password: (ask: PasswordAsk, context?: PromptContext) => Promise<string>;
  readonly confirm: (ask: ConfirmAsk, context?: PromptContext) => Promise<boolean>;
  readonly select: <T>(ask: SelectAsk<T>, context?: PromptContext) => Promise<T>;
};

export type ClackStreams = {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
};

export type ClackPromptFns = {
  text: (options: Record<string, unknown>) => Promise<unknown>;
  password: (options: Record<string, unknown>) => Promise<unknown>;
  confirm: (options: Record<string, unknown>) => Promise<unknown>;
  select: (options: Record<string, unknown>) => Promise<unknown>;
  multiselect: (options: Record<string, unknown>) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
};

export function createClackPrompts(streams: ClackStreams, fns?: ClackPromptFns): PluginFormPrompts & {
  multiselect<T>(
    ask: SelectAsk<T> & { readonly initialValues?: readonly T[] },
    context?: PromptContext,
  ): Promise<readonly T[]>;
};

export class PromptCancelledError extends Error {
  override readonly name = 'PromptCancelledError';
}
```

`multiselect` is not part of `PluginFormPrompts`. Codex is the only caller. It always passes `required: false` to Clack. Clack 1.8.1 defaults `required` to `true` and then shows a hardcoded English empty-selection message. There is no `validate` slot. The Codex wrapper in Task 9 re-prompts with `cli.agent.codex.sources_required` when the returned array is empty.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/ui/prompts.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { createClackPrompts, PromptCancelledError, type ClackPromptFns } from './prompts';

const streams = { input: process.stdin, output: process.stderr };
const CANCEL = Symbol('cancel');

function fake(overrides: Partial<ClackPromptFns> = {}): { fns: ClackPromptFns; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const record =
    (name: string, value: unknown) =>
    async (options: Record<string, unknown>): Promise<unknown> => {
      calls.push({ name, ...options });
      return value;
    };
  return {
    calls,
    fns: {
      text: record('text', ''),
      password: record('password', ''),
      confirm: record('confirm', false),
      select: record('select', undefined),
      multiselect: record('multiselect', []),
      isCancel: (value) => value === CANCEL,
      ...overrides,
    },
  };
}

describe('createClackPrompts', () => {
  test('passes placeholder through and returns an empty submit as an empty string', async () => {
    const { fns, calls } = fake();
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Name', placeholder: 'Ada' })).resolves.toBe('');
    expect(calls[0]).toMatchObject({ name: 'text', message: 'Name', placeholder: 'Ada', input: streams.input, output: streams.output });
    expect(calls[0]).not.toHaveProperty('defaultValue');
    expect(calls[0]).not.toHaveProperty('initialValue');
  });

  test('sends a text default as both initialValue and defaultValue and returns that default', async () => {
    const { fns, calls } = fake({
      text: async (options) => {
        calls.push({ name: 'text', ...options });
        return options.defaultValue ?? '';
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Endpoint', defaultValue: 'https://old.test' })).resolves.toBe('https://old.test');
    expect(calls[0]).toMatchObject({ initialValue: 'https://old.test', defaultValue: 'https://old.test' });
  });

  test('asks for a secret with mask * and returns an empty string', async () => {
    const { fns, calls } = fake();
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.password({ message: 'Token', mask: '*' })).resolves.toBe('');
    expect(calls[0]).toMatchObject({ name: 'password', message: 'Token', mask: '*' });
    expect(calls[0]).not.toHaveProperty('defaultValue');
    expect(calls[0]).not.toHaveProperty('initialValue');
  });

  test('returns select values 0 and false unchanged', async () => {
    const { fns } = fake({
      select: async (options) => (options.options as { value: unknown }[])[0]?.value,
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(
      prompts.select({ message: 'Count', choices: [{ label: 'Zero', value: 0 }] }),
    ).resolves.toBe(0);
    await expect(
      prompts.select({ message: 'Flag', choices: [{ label: 'No', value: false }] }),
    ).resolves.toBe(false);
  });

  test('starts confirm at no when initialValue is omitted and localizes yes and no', async () => {
    const { fns, calls } = fake({
      confirm: async (options) => {
        calls.push(options);
        return options.initialValue;
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.confirm({ message: 'Trust?' })).resolves.toBe(false);
    expect(calls[0]).toMatchObject({ initialValue: false, active: 'Yes', inactive: 'No' });
    await expect(prompts.confirm({ message: 'Trust?', initialValue: true })).resolves.toBe(true);
  });

  test('turns a Clack cancel value into PromptCancelledError and does not exit', async () => {
    const exit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
    }) as typeof process.exit;
    try {
      const { fns } = fake({ text: async () => CANCEL });
      const prompts = createClackPrompts(streams, fns);
      const error = await prompts.input({ message: 'Name' }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PromptCancelledError);
      expect((error as PromptCancelledError).message).toBe('');
      expect(exited).toBe(false);
    } finally {
      process.exit = exit;
    }
  });

  test('rejects an already aborted signal with signal.reason and does not call Clack', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const { fns } = fake({
      text: async () => {
        called = true;
        return 'x';
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Name' }, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(called).toBe(false);
  });

  test('prefers signal.reason when the signal aborts during the prompt', async () => {
    const controller = new AbortController();
    const { fns } = fake({
      text: async () => {
        controller.abort();
        return CANCEL;
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Name' }, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
  });

  test('multiselect passes required false, initial values, and preserves 0', async () => {
    const { fns, calls } = fake({
      multiselect: async (options) => {
        calls.push(options);
        return [0];
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(
      prompts.multiselect({
        message: 'Sources',
        choices: [{ label: 'Zero', value: 0 }],
        initialValues: [0],
      }),
    ).resolves.toEqual([0]);
    expect(calls[0]).toMatchObject({ required: false, initialValues: [0], input: streams.input, output: streams.output });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/prompts.test.ts`

Expected: FAIL because `./prompts` cannot be resolved.

- [ ] **Step 3: Add the dependency and the adapter**

From `/agent/repos/aio-proxy`, add `"@clack/prompts": "1.8.1"` to `packages/cli/package.json` `dependencies` (exact version, no caret). Run `bun install`.

Create `packages/cli/src/ui/prompts.ts`:

```ts
import { confirm, isCancel, multiselect, password, select, text } from '@clack/prompts';
import { m } from '@aio-proxy/i18n';

export type PromptContext = { readonly signal?: AbortSignal };

export type TextAsk = {
  readonly message: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
};

export type PasswordAsk = { readonly message: string; readonly mask?: string };

export type ConfirmAsk = { readonly message: string; readonly initialValue?: boolean };

export type SelectChoice<T> = {
  readonly label: string;
  readonly value: T;
  readonly hint?: string;
};

export type SelectAsk<T> = {
  readonly message: string;
  readonly choices: readonly SelectChoice<T>[];
  readonly initialValue?: T;
};

export type PluginFormPrompts = {
  readonly input: (ask: TextAsk, context?: PromptContext) => Promise<string>;
  readonly password: (ask: PasswordAsk, context?: PromptContext) => Promise<string>;
  readonly confirm: (ask: ConfirmAsk, context?: PromptContext) => Promise<boolean>;
  readonly select: <T>(ask: SelectAsk<T>, context?: PromptContext) => Promise<T>;
};

export type ClackStreams = {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
};

export type ClackPromptFns = {
  text: (options: Record<string, unknown>) => Promise<unknown>;
  password: (options: Record<string, unknown>) => Promise<unknown>;
  confirm: (options: Record<string, unknown>) => Promise<unknown>;
  select: (options: Record<string, unknown>) => Promise<unknown>;
  multiselect: (options: Record<string, unknown>) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
};

const defaultFns: ClackPromptFns = {
  text: (options) => text(options as never),
  password: (options) => password(options as never),
  confirm: (options) => confirm(options as never),
  select: (options) => select(options as never),
  multiselect: (options) => multiselect(options as never),
  isCancel: (value) => isCancel(value),
};

export class PromptCancelledError extends Error {
  override readonly name = 'PromptCancelledError';
  constructor() {
    super('');
  }
}

function rejectIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

async function settle<T>(run: () => Promise<unknown>, signal: AbortSignal | undefined, cancelled: (value: unknown) => boolean): Promise<T> {
  rejectIfAborted(signal);
  const value = await run();
  rejectIfAborted(signal);
  if (cancelled(value)) throw new PromptCancelledError();
  return value as T;
}

export function createClackPrompts(streams: ClackStreams, fns: ClackPromptFns = defaultFns): PluginFormPrompts & {
  multiselect<T>(ask: SelectAsk<T> & { readonly initialValues?: readonly T[] }, context?: PromptContext): Promise<readonly T[]>;
} {
  const io = { input: streams.input, output: streams.output };
  return {
    input: (ask, context) =>
      settle<string>(
        () =>
          fns.text({
            ...io,
            message: ask.message,
            ...(ask.placeholder === undefined ? {} : { placeholder: ask.placeholder }),
            ...(ask.defaultValue === undefined
              ? {}
              : { defaultValue: ask.defaultValue, initialValue: ask.defaultValue }),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    password: (ask, context) =>
      settle<string>(
        () =>
          fns.password({
            ...io,
            message: ask.message,
            mask: ask.mask ?? '*',
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    confirm: (ask, context) =>
      settle<boolean>(
        () =>
          fns.confirm({
            ...io,
            message: ask.message,
            initialValue: ask.initialValue ?? false,
            active: m['cli.ui.yes'](),
            inactive: m['cli.ui.no'](),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    select: <T>(ask: SelectAsk<T>, context?: PromptContext) =>
      settle<T>(
        () =>
          fns.select({
            ...io,
            message: ask.message,
            options: ask.choices.map((choice) => ({
              value: choice.value,
              label: choice.label,
              ...(choice.hint === undefined ? {} : { hint: choice.hint }),
            })),
            ...(ask.initialValue === undefined ? {} : { initialValue: ask.initialValue }),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    multiselect: <T>(ask: SelectAsk<T> & { readonly initialValues?: readonly T[] }, context?: PromptContext) =>
      settle<readonly T[]>(
        () =>
          fns.multiselect({
            ...io,
            message: ask.message,
            required: false,
            options: ask.choices.map((choice) => ({
              value: choice.value,
              label: choice.label,
              ...(choice.hint === undefined ? {} : { hint: choice.hint }),
            })),
            ...(ask.initialValues === undefined ? {} : { initialValues: [...ask.initialValues] }),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
  };
}
```

Do not pass `withGuide`. Do not import `@clack/core`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/prompts.test.ts`

Expected: PASS, 9 tests. The confirm test expects English `Yes` / `No` because the test locale is English.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/package.json bun.lock packages/cli/src/ui/prompts.ts packages/cli/src/ui/prompts.test.ts
git commit -m "feat(cli): adapt Clack prompts"
```

---

### Task 4: Command display session

**Files:**
- Create: `packages/cli/src/ui/session.ts`
- Create: `packages/cli/src/ui/index.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/src/ui/session.test.ts`
- Test: `packages/cli/src/main.rendering.test.ts`

**Interfaces:**
- Consumes: `PromptIo`, `canPrompt` from `./mode`; `ClackPromptFns`, `ClackStreams`, `ConfirmAsk`, `createClackPrompts`, `PasswordAsk`, `PluginFormPrompts`, `PromptCancelledError`, `PromptContext`, `SelectAsk`, `TextAsk` from `./prompts`.
- Produces:

```ts
export type SessionIo = PromptIo & ClackStreams;

export type SessionCopy = { readonly cancelled: string; readonly error: string };

export type SessionChrome = {
  intro: (title?: string, options?: { output?: NodeJS.WritableStream }) => void;
  outro: (message?: string, options?: { output?: NodeJS.WritableStream }) => void;
  cancel: (message?: string, options?: { output?: NodeJS.WritableStream }) => void;
  note: (message?: string, title?: string, options?: { output?: NodeJS.WritableStream }) => void;
  updateSettings: (settings: { messages?: { cancel?: string; error?: string } }) => void;
  spinner: (options?: {
    output?: NodeJS.WritableStream;
    onCancel?: () => void;
    signal?: AbortSignal;
    cancelMessage?: string;
  }) => {
    start: (message?: string) => void;
    clear: () => void;
    readonly isCancelled: boolean;
  };
  prompts: ClackPromptFns;
};

export type CommandSession = {
  readonly prompts: PluginFormPrompts;
  confirm(ask: ConfirmAsk, context?: PromptContext): Promise<boolean>;
  select<T>(ask: SelectAsk<T>, context?: PromptContext): Promise<T>;
  multiselect<T>(ask: SelectAsk<T> & { readonly initialValues?: readonly T[] }, context?: PromptContext): Promise<readonly T[]>;
  spin<T>(message: string, task: (signal: AbortSignal) => Promise<T>, context?: PromptContext): Promise<T>;
  note(message: string): void;
  progress(message: string): void;
  finish(success: string): boolean;
  close(error?: unknown): void;
};

export function createCommandSession(title: string, io: SessionIo, copy: SessionCopy, chrome?: SessionChrome): CommandSession;
export function openProductionSession(title: string): CommandSession;
export function shouldAnimateSpinner(io: PromptIo): boolean;
```

`shouldAnimateSpinner` is exported from `session/` for its test. Do not export it from `ui/index.ts`.

`createCommandSession` throws `new Error('Refusing to open a prompt session without a TTY')` when `canPrompt(io)` is false, before touching `io.input`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/ui/session.test.ts`:

```ts
import { Readable, Writable } from 'node:stream';

import { spinner } from '@clack/prompts';
import { describe, expect, test } from 'bun:test';

import { PromptCancelledError } from './prompts';
import { createCommandSession, shouldAnimateSpinner, type SessionChrome } from './session';

const copy = { cancelled: 'Cancelled', error: 'Something went wrong' };
const title = 'aio-proxy · Configure plugin';

function memoryOutput(): { output: Writable; text: () => string } {
  let body = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { output, text: () => body };
}

function recording(): { chrome: SessionChrome; events: string[]; cancelSpinner: () => void } {
  const events: string[] = [];
  let cancelled = false;
  let onCancel: (() => void) | undefined;
  return {
    events,
    cancelSpinner() {
      cancelled = true;
      onCancel?.();
    },
    chrome: {
      intro(value) {
        events.push(`intro:${value ?? ''}`);
      },
      outro(value) {
        events.push(`outro:${value ?? ''}`);
      },
      cancel(value) {
        events.push(`cancel:${value ?? ''}`);
      },
      note(value, noteTitle) {
        events.push(`note:${value ?? ''}:${noteTitle ?? ''}`);
      },
      updateSettings(settings) {
        events.push(`settings:${settings.messages?.cancel ?? ''}:${settings.messages?.error ?? ''}`);
      },
      spinner(options) {
        onCancel = options?.onCancel;
        return {
          start(message) {
            events.push(`start:${message ?? ''}`);
          },
          clear() {
            events.push('clear');
          },
          get isCancelled() {
            return cancelled;
          },
        };
      },
      prompts: {
        text: async () => 'ok',
        password: async () => '',
        confirm: async () => false,
        select: async () => 'us',
        multiselect: async () => [],
        isCancel: () => false,
      },
    },
  };
}

function open(chrome: SessionChrome, output: Writable = memoryOutput().output) {
  return createCommandSession(
    title,
    { stdinIsTTY: true, stderrIsTTY: true, env: {}, input: process.stdin, output },
    copy,
    chrome,
  );
}

describe('createCommandSession', () => {
  test('refuses a non-TTY session without reading stdin', () => {
    let read = false;
    const input = new Readable({
      read() {
        read = true;
        this.destroy(new Error('read stdin'));
      },
    });
    expect(() =>
      createCommandSession(
        title,
        { stdinIsTTY: false, stderrIsTTY: true, env: {}, input, output: memoryOutput().output },
        copy,
        recording().chrome,
      ),
    ).toThrow('Refusing to open a prompt session without a TTY');
    expect(read).toBe(false);
  });

  test('prints one intro on the first prompt and one outro only after that intro', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    expect(session.finish('Saved')).toBe(false);
    expect(rec.events.some((event) => event.startsWith('outro:'))).toBe(false);
    await session.prompts.input({ message: 'Name' });
    await session.prompts.input({ message: 'Name again' });
    expect(rec.events.filter((event) => event.startsWith('intro:'))).toEqual([`intro:${title}`]);
    expect(session.finish('Saved')).toBe(true);
    expect(session.finish('Saved')).toBe(false);
    const later = new Error('later');
    session.close(later);
    expect(later.message).toBe('later');
    expect(rec.events.filter((event) => event.startsWith('outro:'))).toEqual(['outro:Saved']);
    expect(rec.events.some((event) => event.startsWith('cancel:'))).toBe(false);
  });

  test('cancel after a prompt is one cancel line', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    await session.prompts.input({ message: 'Name' });
    session.close(new PromptCancelledError());
    expect(rec.events).toContain('cancel:Cancelled');
    expect(rec.events.some((event) => event.startsWith('outro:'))).toBe(false);
  });

  test('a business error after a prompt is not printed and is not mutated', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    await session.prompts.input({ message: 'Name' });
    const error = new Error('unknown plugin secret');
    session.close(error);
    expect(error.message).toBe('unknown plugin secret');
    expect(rec.events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);
    expect(rec.events.join('\n')).not.toContain('unknown plugin secret');
  });

  test('close with no error or an empty message prints nothing', async () => {
    const silent = recording();
    const session = open(silent.chrome);
    await session.prompts.input({ message: 'Name' });
    session.close();
    expect(silent.events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);

    const empty = recording();
    const second = open(empty.chrome);
    await second.prompts.input({ message: 'Name' });
    second.close(new Error(''));
    expect(empty.events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);
  });

  test('a note introduces the session once and spin does not', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    session.note('No key');
    expect(rec.events).toContain('note:No key:');
    expect(rec.events.filter((event) => event.startsWith('intro:'))).toHaveLength(1);
    await expect(session.spin('load', async () => 7)).resolves.toBe(7);
    expect(rec.events).toContain('start:load');
    expect(rec.events).toContain('clear');
    expect(rec.events.filter((event) => event.startsWith('intro:'))).toHaveLength(1);
  });

  test('cancelling a spinner aborts the still-running task before spin settles', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    let sawAbort = false;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = session.spin('load', (signal) => {
      started();
      return new Promise<number>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            resolve(1);
          },
          { once: true },
        );
      });
    });
    await ready;
    rec.cancelSpinner();
    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(sawAbort).toBe(true);
    session.close(new PromptCancelledError());
    expect(rec.events.filter((event) => event.startsWith('cancel:'))).toEqual([]);
    expect(rec.events.some((event) => event.startsWith('intro:'))).toBe(false);
  });

  test('an external abort rejects signal.reason while the task is still running', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    const controller = new AbortController();
    const reason = new Error('stop-scan');
    let sawAbort = false;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = session.spin(
      'load',
      (signal) => {
        started();
        return new Promise<number>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve(1);
            },
            { once: true },
          );
        });
      },
      { signal: controller.signal },
    );
    await ready;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(sawAbort).toBe(true);
    expect(rec.events.some((event) => event.startsWith('cancel:'))).toBe(false);
  });

  test('a real Clack spinner prints its cancel line before onCancel and clear cannot remove it', () => {
    let body = '';
    const output = new Writable({
      write(chunk, _encoding, callback) {
        body += String(chunk);
        callback();
      },
    });
    let onCancelRan = false;
    const ui = spinner({
      output,
      cancelMessage: 'spinner-cancelled',
      onCancel: () => {
        onCancelRan = true;
      },
    });
    const exit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
      return undefined as never;
    }) as typeof process.exit;
    try {
      ui.start('scan');
      process.emit('SIGINT');
      const afterCancel = body;
      ui.clear();
      expect(onCancelRan).toBe(true);
      expect(afterCancel).toContain('spinner-cancelled');
      expect(body).toBe(afterCancel);
      expect(exited).toBe(false);
    } finally {
      ui.clear();
      process.exit = exit;
    }
  });

  test('progress is one static line and settings are applied once', () => {
    const rec = recording();
    const sink = memoryOutput();
    const session = open(rec.chrome, sink.output);
    session.progress('Loading');
    expect(sink.text()).toBe('Loading\n');
    expect(sink.text()).not.toContain('\u001b');
    expect(rec.events.some((event) => event.startsWith('intro:'))).toBe(false);
    expect(rec.events.filter((event) => event.startsWith('settings:'))).toEqual(['settings:Cancelled:Something went wrong']);
  });
});

describe('shouldAnimateSpinner', () => {
  test('animates only a stderr TTY outside CI', () => {
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: true, env: {} })).toBe(true);
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: false, env: {} })).toBe(false);
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: true, env: { CI: 'true' } })).toBe(false);
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: true, env: { CI: '0' } })).toBe(true);
  });
});
```

Append these tests to `packages/cli/src/main.rendering.test.ts`. They drive a real session and then the top-level formatter. Import `createCommandSession` and `PromptCancelledError` from `./ui`, and `isKnownCliUserError` plus `toExitCode` from `./exit/exit`. Use a fake `SessionChrome` that records outro/cancel and does not print the error. `memoryOutput` can be a local `Writable` in that file.

```ts
test('an unknown error after a prompt stays secret through close and formatCliError', async () => {
  const events: string[] = [];
  let body = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  const session = createCommandSession(
    'aio-proxy · Add plugin',
    { stdinIsTTY: true, stderrIsTTY: true, env: {}, input: process.stdin, output },
    { cancelled: 'Cancelled', error: 'Something went wrong' },
    {
      intro() {},
      outro(value) {
        events.push(`outro:${value ?? ''}`);
      },
      cancel(value) {
        events.push(`cancel:${value ?? ''}`);
      },
      note() {},
      updateSettings() {},
      spinner: () => ({ start() {}, clear() {}, get isCancelled() { return false; } }),
      prompts: {
        text: async () => 'ok',
        password: async () => '',
        confirm: async () => false,
        select: async () => 'us',
        multiselect: async () => [],
        isCancel: () => false,
      },
    },
  );
  await session.prompts.input({ message: 'Name' });
  const error = new Error('unknown plugin secret');
  session.close(error);
  const formatted = formatCliError(error, 'en');
  expect(error.message).toBe('unknown plugin secret');
  expect(body).not.toContain('unknown plugin secret');
  expect(events.join('\n')).not.toContain('unknown plugin secret');
  expect(events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);
  expect(formatted.message).toBe('Unexpected internal error');
  expect(formatted.message).not.toContain('unknown plugin secret');
});

test('PromptCancelledError formats to an empty message and stays exit 2', () => {
  const error = new PromptCancelledError();
  expect(formatCliError(error, 'en').message).toBe('');
  expect(formatCliError(error, 'en').message).not.toBe('Unexpected internal error');
  expect(isKnownCliUserError(error)).toBe(false);
  expect(toExitCode(error)).toBe(2);
});
```

Import `Writable` from `node:stream` in `main.rendering.test.ts`. `main` prints only when `formatted.message !== ''`, so the empty cancel message is one cancel sentence from the session and no second internal-error line. Do not add a test that puts `PromptCancelledError` in `isKnownCliUserError`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/session.test.ts src/main.rendering.test.ts`

Expected: FAIL. `./session` cannot be resolved, and `formatCliError(new PromptCancelledError())` still becomes `Unexpected internal error`.

- [ ] **Step 3: Write the session**

Create `packages/cli/src/ui/session.ts`:

```ts
import { cancel, confirm, intro, isCancel, multiselect, note, outro, password, select, spinner, text, updateSettings } from '@clack/prompts';
import { m } from '@aio-proxy/i18n';

import { canPrompt, type PromptIo } from './mode';
import {
  createClackPrompts,
  PromptCancelledError,
  type ClackPromptFns,
  type ClackStreams,
  type ConfirmAsk,
  type PluginFormPrompts,
  type PromptContext,
  type SelectAsk,
} from './prompts';

export type SessionIo = PromptIo & ClackStreams;
export type SessionCopy = { readonly cancelled: string; readonly error: string };

type SpinnerUi = {
  start: (message?: string) => void;
  clear: () => void;
  readonly isCancelled: boolean;
};

export type SessionChrome = {
  intro: (title?: string, options?: { output?: NodeJS.WritableStream }) => void;
  outro: (message?: string, options?: { output?: NodeJS.WritableStream }) => void;
  cancel: (message?: string, options?: { output?: NodeJS.WritableStream }) => void;
  note: (message?: string, title?: string, options?: { output?: NodeJS.WritableStream }) => void;
  updateSettings: (settings: { messages?: { cancel?: string; error?: string } }) => void;
  spinner: (options?: {
    output?: NodeJS.WritableStream;
    onCancel?: () => void;
    signal?: AbortSignal;
    cancelMessage?: string;
  }) => SpinnerUi;
  prompts: ClackPromptFns;
};

export type CommandSession = {
  readonly prompts: PluginFormPrompts;
  confirm(ask: ConfirmAsk, context?: PromptContext): Promise<boolean>;
  select<T>(ask: SelectAsk<T>, context?: PromptContext): Promise<T>;
  multiselect<T>(ask: SelectAsk<T> & { readonly initialValues?: readonly T[] }, context?: PromptContext): Promise<readonly T[]>;
  spin<T>(message: string, task: (signal: AbortSignal) => Promise<T>, context?: PromptContext): Promise<T>;
  note(message: string): void;
  progress(message: string): void;
  finish(success: string): boolean;
  close(error?: unknown): void;
};

function blocksCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function shouldAnimateSpinner(io: PromptIo): boolean {
  return io.stderrIsTTY && !blocksCi(io.env);
}

function defaultChrome(): SessionChrome {
  return {
    intro: (value, options) => intro(value, options),
    outro: (value, options) => outro(value, options),
    cancel: (value, options) => cancel(value, options),
    note: (value, noteTitle, options) => note(value, noteTitle, options),
    updateSettings: (settings) => updateSettings(settings),
    spinner: (options) => {
      const ui = spinner(options);
      return {
        start: (message) => ui.start(message),
        clear: () => ui.clear(),
        get isCancelled() {
          return ui.isCancelled;
        },
      };
    },
    prompts: {
      text: (options) => text(options as never),
      password: (options) => password(options as never),
      confirm: (options) => confirm(options as never),
      select: (options) => select(options as never),
      multiselect: (options) => multiselect(options as never),
      isCancel: (value) => isCancel(value),
    },
  };
}

export function createCommandSession(
  title: string,
  io: SessionIo,
  copy: SessionCopy,
  chrome: SessionChrome = defaultChrome(),
): CommandSession {
  if (!canPrompt(io)) throw new Error('Refusing to open a prompt session without a TTY');
  chrome.updateSettings({ messages: { cancel: copy.cancelled, error: copy.error } });
  const raw = createClackPrompts(io, chrome.prompts);
  let introduced = false;
  let settled = false;
  let spinnerCancelLine = false;
  let activeSpinner: SpinnerUi | undefined;
  const ensureIntro = (): void => {
    if (introduced) return;
    introduced = true;
    chrome.intro(title, { output: io.output });
  };
  const prompts: PluginFormPrompts = {
    input: async (ask, context) => {
      ensureIntro();
      return raw.input(ask, context);
    },
    password: async (ask, context) => {
      ensureIntro();
      return raw.password(ask, context);
    },
    confirm: async (ask, context) => {
      ensureIntro();
      return raw.confirm(ask, context);
    },
    select: async (ask, context) => {
      ensureIntro();
      return raw.select(ask, context);
    },
  };
  return {
    prompts,
    confirm: prompts.confirm,
    select: prompts.select,
    multiselect: async (ask, context) => {
      ensureIntro();
      return raw.multiselect(ask, context);
    },
    note(message) {
      ensureIntro();
      chrome.note(message, undefined, { output: io.output });
    },
    progress(message) {
      io.output.write(`${message}\n`);
    },
    async spin<T>(message: string, task: (signal: AbortSignal) => Promise<T>, context?: PromptContext): Promise<T> {
      const external = context?.signal;
      if (external?.aborted) throw external.reason;
      if (!shouldAnimateSpinner(io)) {
        try {
          const result = await task(external ?? new AbortController().signal);
          if (external?.aborted) throw external.reason;
          return result;
        } catch (error) {
          if (external?.aborted) throw external.reason;
          throw error;
        }
      }
      const controller = new AbortController();
      const onExternal = (): void => {
        if (!controller.signal.aborted) controller.abort(external?.reason);
      };
      external?.addEventListener('abort', onExternal, { once: true });
      let userCancelled = false;
      const ui = chrome.spinner({
        output: io.output,
        signal: external,
        cancelMessage: copy.cancelled,
        onCancel: () => {
          spinnerCancelLine = true;
          userCancelled = true;
          if (controller.signal.aborted) return;
          controller.abort(external?.aborted ? external.reason : new PromptCancelledError());
        },
      });
      activeSpinner = ui;
      ui.start(message);
      try {
        const result = await task(controller.signal);
        if (external?.aborted) throw external.reason;
        if (userCancelled || ui.isCancelled) throw new PromptCancelledError();
        return result;
      } catch (error) {
        if (external?.aborted) throw external.reason;
        if (userCancelled || ui.isCancelled) throw new PromptCancelledError();
        throw error;
      } finally {
        external?.removeEventListener('abort', onExternal);
        ui.clear();
        if (activeSpinner === ui) activeSpinner = undefined;
      }
    },
    finish(success) {
      if (!introduced || settled) return false;
      chrome.outro(success, { output: io.output });
      settled = true;
      return true;
    },
    close(error) {
      activeSpinner?.clear();
      activeSpinner = undefined;
      if (settled || !introduced) return;
      settled = true;
      if (error instanceof PromptCancelledError && !spinnerCancelLine) {
        chrome.cancel(copy.cancelled, { output: io.output });
      }
    },
  };
}

export function openProductionSession(title: string): CommandSession {
  return createCommandSession(
    title,
    {
      stdinIsTTY: process.stdin.isTTY === true,
      stderrIsTTY: process.stderr.isTTY === true,
      env: process.env,
      input: process.stdin,
      output: process.stderr,
    },
    { cancelled: m['cli.ui.cancelled'](), error: m['cli.ui.error']() },
  );
}
```

Do not import `@clack/core`. Do not call `process.exit`. Do not `Promise.race` the task. `onCancel` aborts the task signal and records that the library already printed the cancel line. `ui.clear()` in `finally` does not erase that line: `@clack/prompts` 1.8.1 writes it before `onCancel`, then `clear()` returns because the spinner is already stopped. A non-animated spin still passes `context.signal`, or a fresh non-aborted signal when the caller omitted one.

In `packages/cli/src/main.ts`, import `PromptCancelledError` from `./ui` and make it the first branch of `formatCliError`:

```ts
export function formatCliError(err: unknown, locale: Parameters<typeof formatUserError>[1]) {
  if (err instanceof PromptCancelledError) return { message: '' };
  // every existing branch stays after this return
}
```

Do not add `PromptCancelledError` to `isKnownCliUserError`. Do not change `toExitCode`.

Create `packages/cli/src/ui/index.ts`:

```ts
export { canPrompt, useColor, type PromptIo } from './mode';
export {
  createClackPrompts,
  PromptCancelledError,
  type ConfirmAsk,
  type PasswordAsk,
  type PluginFormPrompts,
  type PromptContext,
  type SelectAsk,
  type SelectChoice,
  type TextAsk,
} from './prompts';
export { createCommandSession, openProductionSession, type CommandSession, type SessionCopy, type SessionIo } from './session';
```

Do not export `shouldAnimateSpinner` or `SessionChrome` from the barrel. Tests import them from `./session`. Do not re-export `ClackPromptFns`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/session.test.ts src/ui/mode.test.ts src/ui/prompts.test.ts src/main.rendering.test.ts`

Expected: PASS. The secret string is absent from session output. `PromptCancelledError` formats to `''` and `toExitCode` is `2`.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/ui/session.ts packages/cli/src/ui/session.test.ts packages/cli/src/ui/index.ts packages/cli/src/main.ts packages/cli/src/main.rendering.test.ts
git commit -m "feat(cli): add command display sessions"
```

---

### Task 5: Human summary lines

**Files:**
- Create: `packages/cli/src/ui/summary.ts`
- Test: `packages/cli/src/ui/summary.test.ts`
- Modify: `packages/cli/src/ui/index.ts` to export the summary functions

**Interfaces:**
- Consumes: `useColor` is not called inside summary. Callers pass `color: boolean`. Consumes `DashboardProviderSummary`, `DashboardProvidersResponseSchema`, and `dashboardProviderSuggestedCommand` from `@aio-proxy/types`, plus `m` from `@aio-proxy/i18n`. `DashboardProviderListResponseSchema` is private to `provider-commands.ts`. Inside `summary.ts` write `const ProviderListSchema = DashboardProvidersResponseSchema.pick({ providers: true })`.
- Produces:

```ts
export function formatProviderLines(providers: readonly DashboardProviderSummary[], probe: boolean, color: boolean): readonly string[];
export function formatDeepProviderLines(data: unknown, color: boolean): readonly string[] | undefined;
export function formatPluginLines(plugin: {
  readonly label?: string;
  readonly packageName: string;
  readonly state: string;
  readonly description?: string;
}, columns: number | undefined): readonly string[];
export function formatInstalledLines(item: {
  readonly packageName: string;
  readonly version: string;
  readonly directory: string;
}, columns: number | undefined): readonly string[];
export function formatDoctorLines(doctor: {
  readonly configPath: string;
  readonly url: string;
  readonly version?: string;
  readonly reachable: boolean;
  readonly pluginCount: number;
}, columns: number | undefined): readonly string[];
export function formatStatusLine(status: {
  readonly running: boolean;
  readonly url: string;
  readonly version?: string;
}): string;
export function formatRunSummary(apiUrl: string, dashboardUrl: string): string;
```

Provider rows are always one field per line, in this order, using the existing `cli.provider.list.header_*` strings as labels: id, kind, enabled, passthrough, last_status, last_latency (`null` becomes `-`), state, catalog (`ready` uses `state.catalog ?? '-'`, otherwise `-`), plugin, capability, account, expires_at (ISO or `-`), catalog_last_success_at, diagnostic (`state.diagnostic?.summary ?? '-'`), suggested_command (`dashboardProviderSuggestedCommand(provider) ?? '-'`). When `probe` is true, append probe (`provider.probe ?? 'FAIL'`). A blank line separates providers. No blank line after the last provider. Zero providers returns one line, `m['cli.ui.provider_list_empty']()`, and no labels.

`formatDeepProviderLines` runs `ProviderListSchema.safeParse`. On failure it returns `undefined`. On success it returns `formatProviderLines(parsed.data.providers, true, color)` because `status --deep` is a probe view.

Width rule for plugin, installed, and doctor: let `wide` be the single line defined below. If `columns !== undefined && columns >= 80 && Bun.stringWidth(wide) <= columns`, return `[wide]`. Otherwise return one field per line. Unknown `columns` does not fit. Never slice a value.

- Plugin `wide` stays today's sentence: `` `${label === undefined ? packageName : `${label} (${packageName})`} ${state}${description === undefined ? '' : ` — ${description}`}` ``. Narrow fields are label (only when present), packageName, state, description (only when present).
- Installed `wide` stays `` `${packageName} ${version} ${directory}` ``. Narrow fields are those three strings.
- Doctor fields are the existing sentences. The server sentence is prefixed with `● ` when `reachable` and `○ ` when not. Config and plugin-count sentences have no mark. `wide` joins the three sentences with two spaces.
- Status is one existing sentence plus a mark, both when the terminal is wide and when it is narrow. Running: `` `● ${m['cli.status.running']({ url, version: version ?? 'unknown' })}` ``. Not running: `` `○ ${m['cli.status.not_running']({ url })}` ``. Do not split it and do not truncate it. The locale string already contains status, address, and version.
- `formatRunSummary` returns `` `● ${m['cli.run.started']({ apiUrl, dashboardUrl })}` ``. No ANSI.

Color: provider labels use `\u001b[2m${label}\u001b[0m: ${value}` only when `color` is true. Otherwise `${label}: ${value}`. No other formatter emits `\u001b`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/ui/summary.test.ts`. Use one ready provider object that `DashboardProviderSummary` accepts:

```ts
const provider = {
  id: 'openai',
  kind: 'api',
  enabled: true,
  passthrough: false,
  last_status: 'ok',
  last_latency: 0,
  protocols: [],
  hasQuota: false,
  canRefreshCredential: false,
  clientModels: [],
  state: { status: 'ready', catalog: 'fresh' },
} as const;
```

Assert:

- `formatProviderLines([provider], false, false).join('\n')` contains `id: openai`, `last_latency: 0`, `catalog: fresh`, does not contain `|`, and does not contain `\u001b`.
- `formatProviderLines([provider], false, true).join('\n')` contains `\u001b[2mid\u001b[0m: openai`.
- Two providers produce a line that is exactly `''` between the last field of the first and `id:` of the second.
- `formatProviderLines([], false, false)` equals `[m['cli.ui.provider_list_empty']()]`.
- A provider id of 200 `x` characters is present in full.
- `formatDeepProviderLines({ providers: [provider] }, false)` joins to a string containing `id: openai`. `formatDeepProviderLines({ providers: 'nope' }, false)` is `undefined`.
- `formatPluginLines({ label: 'Name', packageName: 'pkg', state: 'configured', description: 'desc' }, 120)` equals the single legacy line `Name (pkg) configured — desc`.
- The same plugin with `columns: undefined` returns four lines: `Name`, `pkg`, `configured`, `desc`.
- Fifty CJK ideographs as the description, `columns: 80`, returns more than one line, and the joined text still contains every ideograph.
- `formatInstalledLines({ packageName: 'pkg', version: '1.0.0', directory: '/tmp/pkg' }, 120)` equals `['pkg 1.0.0 /tmp/pkg']`. With `columns: 20` it returns three lines.
- `formatDoctorLines({ configPath: '/cfg', url: 'http://127.0.0.1:9317', version: '1.2.3', reachable: true, pluginCount: 2 }, 200)` returns one line containing `● ` and `1.2.3`. With `columns: undefined` it returns three lines, and only the server line starts with `● `.
- Unreachable doctor server line starts with `○ `.
- `formatStatusLine({ running: true, url: 'http://127.0.0.1:9317', version: '1.2.3' })` starts with `● ` and contains `1.2.3` and `9317`. Not running starts with `○ `.
- `formatRunSummary('http://127.0.0.1:9317', 'http://127.0.0.1:9317/dashboard')` starts with `● ` and contains both URLs and no `\u001b`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary.test.ts`

Expected: FAIL because `./summary` cannot be resolved.

- [ ] **Step 3: Implement the formatters and export them from `index.ts`**

Create `packages/cli/src/ui/summary.ts`:

```ts
import { m } from '@aio-proxy/i18n';
import {
  type DashboardProviderSummary,
  DashboardProvidersResponseSchema,
  dashboardProviderSuggestedCommand,
} from '@aio-proxy/types';

const ProviderListSchema = DashboardProvidersResponseSchema.pick({ providers: true });

function labelValue(label: string, value: string, color: boolean): string {
  const shown = color ? `\u001b[2m${label}\u001b[0m` : label;
  return `${shown}: ${value}`;
}

function fits(wide: string, columns: number | undefined): boolean {
  return columns !== undefined && columns >= 80 && Bun.stringWidth(wide) <= columns;
}

function providerFields(provider: DashboardProviderSummary, probe: boolean, color: boolean): string[] {
  const catalog = provider.state.status === 'ready' ? (provider.state.catalog ?? '-') : '-';
  const rows: readonly (readonly [string, string])[] = [
    [m['cli.provider.list.header_id'](), provider.id],
    [m['cli.provider.list.header_kind'](), provider.kind],
    [m['cli.provider.list.header_enabled'](), String(provider.enabled)],
    [m['cli.provider.list.header_passthrough'](), String(provider.passthrough)],
    [m['cli.provider.list.header_last_status'](), provider.last_status],
    [m['cli.provider.list.header_last_latency'](), provider.last_latency === null ? '-' : String(provider.last_latency)],
    [m['cli.provider.list.header_state'](), provider.state.status],
    [m['cli.provider.list.header_catalog'](), catalog],
    [m['cli.provider.list.header_plugin'](), provider.plugin ?? '-'],
    [m['cli.provider.list.header_capability'](), provider.capability ?? '-'],
    [m['cli.provider.list.header_account'](), provider.accountLabel ?? '-'],
    [m['cli.provider.list.header_expires_at'](), provider.expiresAt === undefined ? '-' : new Date(provider.expiresAt).toISOString()],
    [m['cli.provider.list.header_catalog_last_success_at'](), provider.catalogLastSuccessAt ?? '-'],
    [m['cli.provider.list.header_diagnostic'](), provider.state.diagnostic?.summary ?? '-'],
    [m['cli.provider.list.header_suggested_command'](), dashboardProviderSuggestedCommand(provider) ?? '-'],
  ];
  const withProbe = probe ? [...rows, [m['cli.provider.list.header_probe'](), provider.probe ?? 'FAIL'] as const] : rows;
  return withProbe.map(([label, value]) => labelValue(label, value, color));
}

export function formatProviderLines(
  providers: readonly DashboardProviderSummary[],
  probe: boolean,
  color: boolean,
): readonly string[] {
  if (providers.length === 0) return [m['cli.ui.provider_list_empty']()];
  const lines: string[] = [];
  for (const provider of providers) {
    if (lines.length > 0) lines.push('');
    lines.push(...providerFields(provider, probe, color));
  }
  return lines;
}

export function formatDeepProviderLines(data: unknown, color: boolean): readonly string[] | undefined {
  const parsed = ProviderListSchema.safeParse(data);
  if (!parsed.success) return undefined;
  return formatProviderLines(parsed.data.providers, true, color);
}

export function formatPluginLines(
  plugin: { readonly label?: string; readonly packageName: string; readonly state: string; readonly description?: string },
  columns: number | undefined,
): readonly string[] {
  const identity = plugin.label === undefined ? plugin.packageName : `${plugin.label} (${plugin.packageName})`;
  const wide = `${identity} ${plugin.state}${plugin.description === undefined ? '' : ` — ${plugin.description}`}`;
  if (fits(wide, columns)) return [wide];
  return [
    ...(plugin.label === undefined ? [] : [plugin.label]),
    plugin.packageName,
    plugin.state,
    ...(plugin.description === undefined ? [] : [plugin.description]),
  ];
}

export function formatInstalledLines(
  item: { readonly packageName: string; readonly version: string; readonly directory: string },
  columns: number | undefined,
): readonly string[] {
  const wide = `${item.packageName} ${item.version} ${item.directory}`;
  if (fits(wide, columns)) return [wide];
  return [item.packageName, item.version, item.directory];
}

export function formatDoctorLines(
  report: {
    readonly configPath: string;
    readonly url: string;
    readonly version?: string;
    readonly reachable: boolean;
    readonly pluginCount: number;
  },
  columns: number | undefined,
): readonly string[] {
  const configLine = m['cli.doctor.config_path']({ path: report.configPath });
  const serverLine = report.reachable
    ? `● ${m['cli.doctor.server_reachable']({ url: report.url, version: report.version ?? 'unknown' })}`
    : `○ ${m['cli.doctor.server_unreachable']({ url: report.url })}`;
  const pluginsLine = m['cli.doctor.plugin_count']({ count: report.pluginCount });
  const wide = `${configLine}  ${serverLine}  ${pluginsLine}`;
  if (fits(wide, columns)) return [wide];
  return [configLine, serverLine, pluginsLine];
}

export function formatStatusLine(status: { readonly running: boolean; readonly url: string; readonly version?: string }): string {
  return status.running
    ? `● ${m['cli.status.running']({ url: status.url, version: status.version ?? 'unknown' })}`
    : `○ ${m['cli.status.not_running']({ url: status.url })}`;
}

export function formatRunSummary(apiUrl: string, dashboardUrl: string): string {
  return `● ${m['cli.run.started']({ apiUrl, dashboardUrl })}`;
}
```

Append this export to `packages/cli/src/ui/index.ts`:

```ts
export {
  formatDeepProviderLines,
  formatDoctorLines,
  formatInstalledLines,
  formatPluginLines,
  formatProviderLines,
  formatRunSummary,
  formatStatusLine,
} from './summary';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/ui/summary.ts packages/cli/src/ui/summary.test.ts packages/cli/src/ui/index.ts
git commit -m "feat(cli): format human CLI summaries"
```

If you added `provider-lines.ts`, include it in `git add`.

---

### Task 6: Plugin form asks

**Files:**
- Modify: `packages/cli/src/plugin-commands/form/render.ts`
- Modify: `packages/cli/src/plugin-commands/form/index.ts`
- Modify: `packages/cli/src/plugin-commands/form/secrets.test.ts` lines 16–17 and 116
- Modify: `packages/cli/src/plugin-commands/form/render.test.ts` lines 88–92
- Test: existing `packages/cli/src/plugin-commands/form/*.test.ts`

**Interfaces:**
- Consumes: `PluginFormPrompts` and `createClackPrompts` from `../../ui` (`packages/cli/src/plugin-commands/form/render.ts` resolves that to `packages/cli/src/ui`).
- Produces: `renderConfigSpec` still returns `{ publicValues, secrets }`. `form/index.ts` still exports `PluginFormPrompts`, now as `export type { PluginFormPrompts } from '../../ui'`.

Do not change `visible`, `compatibleDefault`, schema validation, or the secret `""` / `clearSecrets` branches.

- [ ] **Step 1: Update the assertions that read Inquirer's `default`**

In `secrets.test.ts`, replace `.default` expectations with `.defaultValue`:

```ts
expect((calls[0]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBe('https://old.test');
expect((calls[2]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBe('2');
```

and the same for the `'https://old.example/path'` assertion.

In `render.test.ts`, replace the five `default` assertions with:

```ts
expect((calls[0]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBeUndefined();
expect((calls[1]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBeUndefined();
expect((calls[2]?.config as { initialValue?: unknown } | undefined)?.initialValue).toBe(true);
expect((calls[3]?.config as { initialValue?: unknown } | undefined)?.initialValue).toBeUndefined();
expect((calls[4]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBe('{"safe":true}');
```

- [ ] **Step 2: Run the form tests to verify they fail**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/plugin-commands/form`

Expected: FAIL on the assertions above because `render.ts` still sends `default`.

- [ ] **Step 3: Switch the ask shape**

In `render.ts`, delete the `@inquirer/prompts` import and the local `PromptContext` / `PluginFormPrompts` declarations. Import `createClackPrompts` and `type PluginFormPrompts` from `../../ui`.

```ts
const defaultPrompts: PluginFormPrompts = createClackPrompts({
  input: process.stdin,
  output: process.stderr,
});
```

Map fields like this:

- `text`, `number`, and `json` pass `defaultValue` only when `promptDefault !== undefined`. Number uses `String(promptDefault)`. JSON uses `JSON.stringify(promptDefault)`. Placeholder stays a `placeholder` property. Do not set `initialValue` on the ask; the adapter copies `defaultValue` onto Clack's `initialValue`.
- `boolean` passes `initialValue: (promptDefault as boolean | undefined) ?? false`.
- `select` choices are `{ label, value, hint? }` from `option.label` / `option.value` / `option.description`. Pass `initialValue: promptDefault` only when it is not `undefined`. The select call's generic value is `unknown` today; keep the return type of `prompts.select` as the `PluginFormPrompts` contract (`Promise<T>`). Cast the prompt default only at the `initialValue` property: `initialValue: promptDefault as never` is not allowed. Pass `promptDefault` through as `SelectAsk<unknown>['initialValue']` by calling `prompts.select<unknown>`.
- `secret` stays `{ message, mask: '*' }`. Empty string and `clearSecrets` stay in `promptFieldValue`, not in the adapter.

`form/index.ts`:

```ts
export type { PluginFormPrompts } from '../../ui';
```

Remove `PluginFormPrompts` from the `render.ts` re-export list. Keep the other render exports.

- [ ] **Step 4: Run the form tests to verify they pass**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/plugin-commands/form`

Expected: PASS, including secret blank retention, `--clear-secret`, `0`, `false`, bad number/JSON, and the abort test that throws `controller.signal.reason`.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/plugin-commands/form/render.ts packages/cli/src/plugin-commands/form/index.ts packages/cli/src/plugin-commands/form/secrets.test.ts packages/cli/src/plugin-commands/form/render.test.ts
git commit -m "feat(cli): render plugin forms with Clack"
```

---

### Task 7: Plugin command session

**Files:**
- Modify: `packages/cli/src/plugin-commands/plugin/deps.ts`
- Modify: `packages/cli/src/plugin-commands/plugin/add.ts`
- Modify: `packages/cli/src/plugin-commands/plugin/configure.ts`
- Modify: `packages/cli/src/plugin-commands/plugin/remove.ts`
- Modify: `packages/cli/src/plugin-commands/plugin/add.test.ts` around the trust-default assertion
- Modify: `packages/cli/src/plugin-commands/plugin/remove.purge.test.ts`
- Test: existing plugin command tests, plus one new purge test

**Interfaces:**
- Consumes: `CommandSession`, `canPrompt`, `createClackPrompts`, `openProductionSession`, and `type PluginFormPrompts` from `../../ui`. That is the import path from `packages/cli/src/plugin-commands/plugin/deps.ts`.
- Produces on `PluginLifecycleDeps`:

```ts
readonly openSession?: (title: string) => CommandSession;
```

`requireConfirmation(message, options, deps, packageName?)` stays. Add an optional last argument `session?: CommandSession`. When `options.yes === true`, return. When `!deps.isTTY`, throw `PluginConfirmationRequiredError`. When `session` is defined, `await session.confirm({ message })`. Otherwise `await deps.confirm(message)`. A `false` result throws `PluginTrustRejectedError`.

`createPluginConfirmation` accepts `PluginFormPrompts['confirm']` and calls `prompt({ message, initialValue: false }, signal === undefined ? undefined : { signal })`.

Helper in `deps.ts`:

```ts
export function beginPluginSession(deps: PluginLifecycleDeps, title: string): CommandSession | undefined {
  if (!deps.isTTY || deps.openSession === undefined) return undefined;
  return deps.openSession(title);
}

export function reportLine(deps: PluginLifecycleDeps, session: CommandSession | undefined, message: string): void {
  if (session?.finish(message) === true) return;
  deps.print(message);
}
```

- [ ] **Step 1: Write the failing purge test and update the trust assertion**

In `add.test.ts`, change the observed type and expectation:

```ts
let observed: { readonly message: string; readonly initialValue?: boolean } | undefined;
const confirm = createPluginConfirmation(async (ask) => {
  observed = ask;
  return false;
});
await expect(confirm('Trust this plugin?')).resolves.toBe(false);
expect(observed).toEqual({ message: 'Trust this plugin?', initialValue: false });
```

In `remove.purge.test.ts`, keep the existing "declining the post-remove purge keeps secrets and reports retention" test unchanged. It has no `openSession`, so `state.lines` still contains `retained`.

Add this test beside it:

```ts
test('a prompt session moves the retained sentence onto finish', async () => {
  const state = scope.harness({ providers: {}, plugins: ['third-party-plugin'] });
  state.values.set('third-party-plugin', { revision: 1, value: { token: 'keep' } });
  const finished: string[] = [];
  let confirmations = 0;
  const session = {
    prompts: state.deps.prompts,
    confirm: async () => {
      confirmations += 1;
      return confirmations !== 2;
    },
    select: async () => {
      throw new Error('no select');
    },
    multiselect: async () => {
      throw new Error('no multiselect');
    },
    spin: async <T>(_message: string, task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    note() {},
    progress() {},
    finish(message: string) {
      finished.push(message);
      return true;
    },
    close() {},
  };
  await pluginRemove('third-party-plugin', { purgeSecrets: true }, {
    ...state.deps,
    openSession: () => session,
  });
  expect(state.values.get('third-party-plugin')?.value).toEqual({ token: 'keep' });
  expect(finished.join('\n')).toContain('retained');
  expect(state.lines.join('\n')).not.toContain('retained');
});
```

The harness sets `isTTY: true`. `beginPluginSession` therefore opens this fake session. The second `session.confirm` returns false, `requireConfirmation` throws `PluginTrustRejectedError`, and `pluginRemove` catches that and reports the retained sentence.

- [ ] **Step 2: Run the plugin tests to verify the new assertions fail**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/plugin-commands/plugin/add.test.ts src/plugin-commands/plugin/remove.purge.test.ts`

Expected: FAIL. The trust test still sees `default: false`. The new session test does not see `finish` called.

- [ ] **Step 3: Wire the session**

`createDefaultPluginLifecycleDeps` computes:

```ts
const interactive = canPrompt({
  stdinIsTTY: process.stdin.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  env: process.env,
});
```

Set `isTTY: interactive`. Set `prompts` to `createClackPrompts({ input: process.stdin, output: process.stderr })` when interactive, otherwise four async functions that throw `new Error('Refusing to prompt without a TTY')` and never read stdin. Set `confirm: createPluginConfirmation()`. Set `openSession: interactive ? openProductionSession : undefined`. Delete the `@inquirer/prompts` import from this file.

`pluginAdd`, `pluginConfig`, `pluginRemove`, and `pluginPrune`:

```ts
const session = beginPluginSession(deps, m['cli.ui.title_plugin_add']());
let failure: unknown;
try {
  // existing body, with requireConfirmation(..., session)
  // renderConfigSpec({ prompts: session?.prompts ?? deps.prompts, ...existing options })
  reportLine(deps, session, successSentence);
} catch (error) {
  failure = error;
  throw error;
} finally {
  session?.close(failure);
  if (injected === undefined) deps.close?.();
}
```

Use `title_plugin_config`, `title_plugin_remove`, and `title_plugin_prune` for the other commands. Built-in add still `deps.print`s `cli.plugin.already_builtin` and returns before `reportLine`. That path has no prompt, so do not call `finish`. Opening the session is harmless because `close(undefined)` prints nothing when intro never ran. Built-in add can return before `beginPluginSession` so it does not open a session at all.

`pluginRemove` purge decline stays a success return, not a failure:

```ts
} catch (error) {
  if (!(error instanceof PluginTrustRejectedError)) throw error;
  reportLine(deps, session, m['cli.plugin.removed_secrets_retained']({ plugin: packageName }));
  return;
}
```

Do not put that error into `failure`, or `close` would also print it. `pluginList` does not open a session in this task.

- [ ] **Step 4: Run the plugin tests to verify they pass**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/plugin-commands/plugin`

Expected: PASS. Harness tests without `openSession` still find success sentences in `lines`.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/plugin-commands/plugin
git commit -m "feat(cli): session chrome for plugin commands"
```

---

### Task 8: Provider login session

**Files:**
- Modify: `packages/cli/src/plugin-commands/provider-login/capability.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/deps.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/index.ts`
- Modify: `packages/cli/src/plugin-commands/provider-login/capability.test.ts`
- Test: existing `packages/cli/src/plugin-commands/provider-login/*.test.ts`

**Interfaces:**
- Consumes: `CommandSession`, `canPrompt`, `createClackPrompts`, `openProductionSession`, `type PluginFormPrompts` from `../../ui`.
- Produces:
  - `CapabilitySelectPrompt` becomes `(ask: SelectAsk<string>, context?: PromptContext) => Promise<string>` with choices `{ label, value, hint? }`.
  - `createManualOnlyConfirmation(signal, prompt?)` calls `prompt({ message: redirectUri, initialValue: false }, { signal })`.
  - `ProviderLoginDeps.openSession?: (title: string) => CommandSession`.
  - `applyProviderLoginSession(base: ProviderLoginDeps, session: CommandSession): ProviderLoginDeps` in `deps.ts`.

`applyProviderLoginSession` returns a deps object whose:

- `selectCapability` is `createCapabilitySelector(session.prompts.select)`
- `renderAccountOptions` calls `renderConfigSpec(spec, { prompts: session.prompts, currentPublicValues, currentSecrets, signal })`
- `createAuthorization` uses the same `createCliAuthorizationPort` arguments as `createProviderLoginDefaultDeps`, except `readManualCallbackUrl` is `(authorizationUrl, promptSignal) => session.prompts.input({ message: authorizationUrl }, { signal: promptSignal })` and `confirmManualOnly` is `(redirectUri) => session.confirm({ message: redirectUri, initialValue: false }, { signal })`

Do not change `packages/cli/src/plugin-commands/loopback/run.ts`. The URL remains the prompt message.

- [ ] **Step 1: Update capability assertions**

In `capability.test.ts`:

```ts
let choices: readonly { readonly label: string; readonly value: string }[] = [];
```

Expect `[{ label: '本地化功能名称', value: '@a/one#default' }]`.

```ts
let observedConfig: { readonly message: string; readonly initialValue?: boolean } | undefined;
expect(observedConfig).toEqual({ message: 'http://127.0.0.1/callback', initialValue: false });
```

The signal assertion stays `observedSignal` equals `controller.signal`.

- [ ] **Step 2: Run the capability test to verify it fails**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/plugin-commands/provider-login/capability.test.ts`

Expected: FAIL because choices still use `name` and confirm still uses `default`.

- [ ] **Step 3: Switch the prompts and the login session**

`createCapabilitySelector` default prompt is `createClackPrompts({ input: process.stdin, output: process.stderr }).select`. Map `displayName` through `resolveLocalizedText` into `label`. Delete the `@inquirer/prompts` import.

`createProviderLoginDefaultDeps` uses the same `interactive` / `canPrompt` split as plugin deps. `isTTY` is `interactive`. `openSession` is `interactive ? openProductionSession : undefined`. Account prompts and the authorization port still close over `createClackPrompts` when interactive, so a caller that does not bind a session still has a prompt implementation. Non-interactive prompt functions throw `new Error('Refusing to prompt without a TTY')`.

`providerLogin`:

```ts
const session = deps.isTTY && deps.openSession !== undefined
  ? deps.openSession(m['cli.ui.title_provider_login']())
  : undefined;
const live = session === undefined ? deps : applyProviderLoginSession(deps, session);
let failure: unknown;
try {
  // existing body, using `live` wherever the old code used `deps` for selection,
  // render, and authorization
  deps.print(result.providerId);
  session?.finish(m['cli.ui.outro_provider_login']());
} catch (error) {
  failure = presentProviderLoginUserError(error) ?? error;
  throw failure;
} finally {
  session?.close(failure);
  if (injected === undefined) deps.close?.();
}
```

Progress messages stay `deps.print` on stdout. Do not move them into the session.

- [ ] **Step 4: Run the provider-login tests to verify they pass**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/plugin-commands/provider-login`

Expected: PASS. The progress test still expects `['等待中', 'created']` because that harness has no `openSession`.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/plugin-commands/provider-login
git commit -m "feat(cli): session chrome for provider login"
```

---

### Task 9: Codex configure session

**Files:**
- Modify: `packages/cli/src/agent/codex/codex.ts`
- Modify: `packages/cli/src/agent/codex/wizard/wizard.ts`
- Modify: `packages/cli/src/agent/codex/sessions/sessions.ts`
- Test: existing `packages/cli/src/agent/codex/codex.test.ts`, `wizard/wizard.test.ts`, and `sessions/sessions.test.ts`

**Interfaces:**
- Consumes: `canPrompt`, `openProductionSession`, `PromptCancelledError`, `type CommandSession` from `../../ui` (`codex.ts` is `packages/cli/src/agent/codex/codex.ts`, so the import path is `../../ui`). `wizard.ts` imports `PromptCancelledError` from `../../../ui`.
- Produces: `configureCodexAgent` still returns `CodexConfigureResult`. `CodexPrompts` is unchanged. `runCodexWizard` still receives prompt callbacks.

Cancellation helper used by both files:

```ts
export function isCodexCancellation(error: unknown): boolean {
  return error instanceof PromptCancelledError || (error instanceof Error && error.name === 'AbortError');
}
```

Put it in `codex.ts` and use it from `wizard.ts` only if that import does not cycle. `codex.ts` already imports `wizard.ts`, so `wizard.ts` must not import `codex.ts`. Duplicate the two-line helper in `wizard.ts` as a private `cancelledError`, or move the helper to `packages/cli/src/agent/codex/cancellation.ts` and import it from both. Prefer the new three-line file so the predicate stays one function. Export it from that file only. Do not add it to a barrel that `wizard.ts` and `codex.ts` would cycle through.

`AbortError` stays a Codex cancellation because `wizard.test.ts` rejects `commitSetup` with `new DOMException('The operation was aborted', 'AbortError')` and expects `authorization_incomplete`. Do not keep the old substring regex. `Error('cancelled')` is not a cancellation.

`inspectCodexSessions` gains an optional third argument `signal?: AbortSignal`. Throw `signal.reason` before reading the state index, after that read returns, and at the top of the session loop. In the existing `catch`, rethrow when `signal?.aborted` or the error is a `PromptCancelledError`. Every other error still becomes the blocked preview. Do not wrap the read in `Promise.race`.

Add a test in `sessions.test.ts` that aborts before the call and expects the same reason object, not a blocked preview:

```ts
const controller = new AbortController();
const reason = new Error('stop-scan');
controller.abort(reason);
await expect(inspectCodexSessions(location, undefined, controller.signal)).rejects.toBe(reason);
```

Use the location fixture already built by the nearest existing `inspectCodexSessions` test. A scan that is not aborted still returns a blocked preview for an unreadable index.

Add a wizard test whose `providerId` prompt throws `new PromptCancelledError()`. `runCodexWizard` resolves a `{ status: 'cancelled' }` result and does not reject. Keep the existing `commitSetup` `AbortError` test as the separate `authorization_incomplete` path. `Error('cancelled')` still rejects or is otherwise not treated as cancellation.

- [ ] **Step 1: Run the existing Codex tests so the baseline is green**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/agent/codex/codex.test.ts src/agent/codex/wizard/wizard.test.ts`

Expected: PASS before the edit. The non-interactive test expects `{ status: 'cancelled', reason: 'non_interactive' }`.

- [ ] **Step 2: Replace the prompt implementation**

Delete `styleText`, `withSpinner`, `isPromptCancellation`, and the `@inquirer/prompts` import.

Gate:

```ts
const interactive = canPrompt({
  stdinIsTTY: process.stdin.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  env: process.env,
});
if (!interactive) return cancelledCodexResult(location, 'non_interactive');
```

Run `checkCodexInstalled` and endpoint resolution before opening a session, so a missing Codex binary never prints intro. Then:

```ts
const session = openProductionSession(m['cli.ui.title_codex_configure']());
let failure: unknown;
try {
  const confirmRecovery = () =>
    session.confirm({ message: m['cli.agent.codex.pending_recovery'](), initialValue: false });
  // existing recoverPendingCodexOperations call
  const result = await runCodexWizard({
    // existing fields
    isTTY: true,
    prompts: createPrompts(session),
    inspectKeys: async () => {
      const keys = await inspectProxyKeys(createCredentialDeps(endpoint));
      if (keys.choices.length === 0) session.note(m['cli.agent.codex.key_none']());
      return keys;
    },
    inspectSessions: (providerId) =>
      session.spin(m['cli.agent.codex.sessions_loading'](), (signal) =>
        inspectCodexSessions(location, providerId, signal),
      ),
  });
  if (result.status === 'cancelled') return result;
  session.finish(m['cli.ui.outro_codex_configure']());
  return { ...result, version, versionCompatibility: 'unverified' as const };
} catch (error) {
  if (isCodexCancellation(error)) return cancelledCodexResult(location);
  failure = error;
  throw error;
} finally {
  session.close(failure);
}
```

Returning a cancelled result leaves `failure` unset, so `close()` prints neither `cancel` nor `outro`. A spinner cancel is different: `@clack/prompts` already wrote that line before `onCancel`, and `clear()` cannot remove it, so Codex's stdout result lines remain underneath that one library line. Do not call `cancel()` again to replace it. `renderAgentConfigure` in `packages/cli/src/agent/output.ts` still prints the result lines on stdout. Do not call it from `configureCodexAgent`.

`createPrompts(session)`:

- `providerId`: loop `session.prompts.input({ message, defaultValue: defaultId })`. Validate with `validateCodexProviderId`. On failure, set `message` to the original prompt plus a newline plus `cli.agent.codex.provider_id_invalid`. On an occupied id, append `cli.agent.codex.provider_conflict`. Do not add a `validate` field to `TextAsk`.
- `authMode`: `session.select` with the two existing choices. `label` is the old `name`. `hint` is the old `description`. `initialValue` is `defaultMode`.
- `key`: `session.select` with `{ label: choice.label, value: choice.id }`. Return `{ kind: 'existing', id: value }`.
- `sources`: loop `session.multiselect` with `initialValues: [previous]` when `previous` is not empty. If the array length is 0, set `message` to the original sources prompt plus a newline plus `m['cli.agent.codex.sources_required']()` and ask again. Do not call `note` for that rejection.
- `migrate`: `session.confirm` with the existing two-line message and `initialValue: false`.

`pendingRecovery` no longer calls Clack itself. `configureCodexAgent` passes `confirmRecovery` as shown above. Delete the module-level `pendingRecovery` helper if nothing else calls it.

In `wizard.ts`, replace the regex `cancelledError` with `isCodexCancellation`.

- [ ] **Step 3: Run the Codex tests to verify they pass**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/agent/codex/codex.test.ts src/agent/codex/wizard/wizard.test.ts src/agent/codex/sessions/sessions.test.ts src/agent/output.test.ts`

Expected: PASS. The provider-id `PromptCancelledError` resolves to a cancelled result. The pre-aborted scan rejects `stop-scan` instead of a blocked preview. `rg -n "styleText|withSpinner|@inquirer/prompts" packages/cli/src/agent/codex` prints no matches.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/agent/codex
git commit -m "feat(cli): session chrome for Codex configure"
```

---

### Task 10: Status, doctor, lists, and run

**Files:**
- Modify: `packages/cli/src/status/status.ts`
- Modify: `packages/cli/src/status/status.test.ts`
- Modify: `packages/cli/src/doctor/doctor.ts`
- Modify: `packages/cli/src/provider-commands.ts`
- Modify: `packages/cli/src/plugin-commands/plugin/remove.ts` (`pluginList` only)
- Modify: `packages/cli/src/run/run.ts` around the `console.error(m['cli.run.started']...)` call

**Interfaces:**
- Consumes: `formatDeepProviderLines`, `formatDoctorLines`, `formatInstalledLines`, `formatPluginLines`, `formatProviderLines`, `formatRunSummary`, `formatStatusLine`, `useColor` from the ui barrel.
- Produces: no new exports. `--json` bytes stay the current object.

- [ ] **Step 1: Write the failing status tests**

Append to `status.test.ts`:

```ts
test('--deep human output prints provider rows and does not dump JSON', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok', uptime: 1, version: '1.2.3' });
      return Response.json({
        providers: [{
          id: 'openai',
          kind: 'api',
          enabled: true,
          passthrough: false,
          last_status: 'ok',
          last_latency: 0,
          protocols: [],
          hasQuota: false,
          canRefreshCredential: false,
          clientModels: [],
          state: { status: 'ready', catalog: 'fresh' },
        }],
      });
    },
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port), deep: true }, (line) => lines.push(line));
    const out = lines.join('\n');
    expect(out).toContain('id: openai');
    expect(out).not.toContain('"protocols"');
  } finally {
    server.stop(true);
  }
});

test('--deep human output explains an unexpected payload without throwing', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok', uptime: 1, version: '1.2.3' });
      return Response.json({ providers: 'nope' });
    },
  });
  try {
    const lines: string[] = [];
    await statusCommand({ port: String(server.port), deep: true }, (line) => lines.push(line));
    expect(lines.join('\n')).toContain('could not be displayed');
  } finally {
    server.stop(true);
  }
});
```

The existing `--deep --json` auth test must stay as written.

- [ ] **Step 2: Run the status test to verify it fails**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/status/status.test.ts`

Expected: FAIL. Human `--deep` still prints `JSON.stringify`.

- [ ] **Step 3: Call the formatters**

`statusCommand` human running/not-running line becomes `print(formatStatusLine(...))`. Keep the `StatusNotRunningError` throw after the print. JSON mode stays the current `JSON.stringify` and still throws when health is null.

Human `--deep`: auth and probe-failed keep `cli.status.deep_unavailable` and `cli.status.deep_probe_failed`. Success uses `formatDeepProviderLines(providers, useColor(process.stdout.isTTY === true, process.env))`. `undefined` prints `m['cli.ui.status_deep_unexpected']()` and does not throw. Print each returned line through `print`.

`doctorCommand` replaces the three `print` calls with `formatDoctorLines(..., process.stdout.columns)` and prints each returned line. It still does not throw when the server is down.

`printProviderTable` becomes `formatProviderLines(providers, probe, useColor(process.stdout.isTTY === true, process.env))` printed with `console.log`. `providerInstalledList` prints `formatInstalledLines` for each package and prints nothing when the list is empty. `directory` is `dirname(item.entrypoint)`.

`pluginList` builds the same state string it builds today (not installed, then configured when installed, then builtin, then failed diagnostic summary). Pass that string to `formatPluginLines` with `process.stdout.columns`. Print every returned line through `deps.print`. Do not open a session.

`run` replaces the started `console.error` argument with `formatRunSummary(apiUrl, dashboardUrl)`. Leave the bootstrap hint and the SIGINT handlers unchanged. Do not start a spinner.

- [ ] **Step 4: Run the affected tests**

Run: `cd /agent/repos/aio-proxy/packages/cli && bun test --preload=./__tests__/setup.ts src/status/status.test.ts src/plugin-commands/plugin/remove.test.ts src/ui/summary.test.ts`

Expected: PASS. Status lines still contain the version and port because the marked sentence includes them. Plugin list output still contains `configured` on a wide test process; if `stdout.columns` is unknown in the test runner, the narrow lines still include the state word.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/src/status/status.ts packages/cli/src/status/status.test.ts packages/cli/src/doctor/doctor.ts packages/cli/src/provider-commands.ts packages/cli/src/plugin-commands/plugin/remove.ts packages/cli/src/run/run.ts
git commit -m "feat(cli): restyle status, doctor, and lists"
```

---

### Task 11: Remove Inquirer, changeset, and smoke

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `bun.lock`
- Create: `.changeset/cli-clack-display.md`
- Verify: no remaining `@inquirer/prompts` import under `packages/cli`

**Interfaces:**
- Consumes: every previous task.
- Produces: a patch changeset whose frontmatter lists `aio-proxy`, `@aio-proxy/cli`, and `@aio-proxy/i18n`.

- [ ] **Step 1: Confirm the import is gone**

Run: `cd /agent/repos/aio-proxy && rg -n "@inquirer/prompts" packages/cli`

Expected: no matches. If a match remains, move that call site onto `createClackPrompts` or `openProductionSession` before deleting the dependency. Do not delete the dependency while an import remains.

- [ ] **Step 2: Remove the dependency and add the note**

Delete `"@inquirer/prompts"` from `packages/cli/package.json`. Run `bun install` from the repo root.

Create `.changeset/cli-clack-display.md`:

```md
---
'aio-proxy': patch
'@aio-proxy/cli': patch
'@aio-proxy/i18n': patch
---

Human prompts and the named result views now share one terminal style. `--json`, shell completion, version, and auth protocol output are unchanged.
```

- [ ] **Step 3: Run preflight and the smoke commands**

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /agent/repos/aio-proxy
bun run preflight
```

Expected: exit 0.

```bash
export PATH="$HOME/.bun/bin:$PATH"
export AIO_PROXY_HOME="$(mktemp -d)"
cd /agent/repos/aio-proxy
bun packages/cli/src/main.ts --version
bun packages/cli/src/main.ts completion bash
```

Expected: `--version` stdout is only the version line. `completion bash` contains no `\u001b` and no `┌`.

Build one Linux binary:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /agent/repos/aio-proxy
bun packages/cli/scripts/build-binary.ts linux-x64 /tmp/aio-proxy-clack-smoke
AIO_PROXY_HOME="$(mktemp -d)" /tmp/aio-proxy-clack-smoke --version
```

Expected: stdout is only the version line.

Prompt smoke, source and binary. The CLI is the direct child. Do not wrap it in a shell: a following `printf` or `stty` would make `proc.returncode` the shell's status. `@clack/core` 1.5.1 `ConfirmPrompt` submits immediately on `y`/`Y` (yes) and `n`/`N` (no). Arrow keys and `h`/`l` only toggle the active choice. Enter submits whichever choice is active. The adapter's omitted `initialValue` is `false`, so Enter would decline; the script sends `y` or `n` so the result does not depend on the active choice.

`plugin prune` is the success flow. It asks `Remove unused plugin package cache entries?` and then reads the local package cache. It does not contact a registry. Yes exits 0 and the transcript contains `Pruned`. `plugin add example-plugin` is the decline and Ctrl+C flow. Decline is `PluginTrustRejectedError`: `cli_exit=1` and `Plugin operation cancelled` appears once. Ctrl+C is `PromptCancelledError`: `cli_exit=2`, `Cancelled` appears once, and `Unexpected internal error` does not appear. Remove `CI` from the child environment so `canPrompt` stays true.

Save this as `/tmp/clack-pty-smoke.py`. A hang past 20 seconds is a failure. This smoke does not replace the unit tests.

```python
import errno, fcntl, os, pty, select, struct, subprocess, sys, termios, time

mode = sys.argv[1]
command = sys.argv[2:]
if mode not in ('decline', 'ctrl-c', 'accept'):
    raise SystemExit('usage: clack-pty-smoke.py decline|ctrl-c|accept <command...>')
home = os.environ.get('AIO_PROXY_HOME', '/tmp/aio-proxy-clack-pty')
os.makedirs(home, exist_ok=True)
master, slave = pty.openpty()
winsize = struct.pack('HHHH', 24, 80, 0, 0)
fcntl.ioctl(master, termios.TIOCSWINSZ, winsize)
fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)
kept = os.dup(slave)
before = termios.tcgetattr(kept)
env = os.environ.copy()
env['AIO_PROXY_HOME'] = home
env.pop('CI', None)
proc = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env, cwd='/agent/repos/aio-proxy', close_fds=True)
os.close(slave)

def read_chunk():
    try:
        return os.read(master, 4096)
    except OSError as exc:
        if exc.errno == errno.EIO:
            return b''
        raise

def drain():
    data = b''
    while True:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            return data
        chunk = read_chunk()
        if chunk == b'':
            return data
        data += chunk

needle = b'Remove unused' if mode == 'accept' else b'Trust'
key = b'y' if mode == 'accept' else b'n' if mode == 'decline' else b'\x03'
sent = False
deadline = time.time() + 20
buffer = b''
while time.time() < deadline and proc.poll() is None:
    ready, _, _ = select.select([master], [], [], 0.2)
    if not ready:
        continue
    chunk = read_chunk()
    if chunk == b'':
        break
    buffer += chunk
    if not sent and needle in buffer:
        os.write(master, key)
        sent = True
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait(timeout=2)
    raise SystemExit('process hung')
buffer += drain()
after = termios.tcgetattr(kept)
os.close(kept)
os.close(master)
mask = termios.ECHO | termios.ICANON | termios.ISIG
if (before[3] & mask) != mask or (after[3] & mask) != (before[3] & mask):
    raise SystemExit(f'terminal flags changed before={before[3] & mask:#x} after={after[3] & mask:#x}')
text = buffer.decode('utf-8', 'replace')
if not sent:
    sys.stderr.write(text)
    raise SystemExit('prompt never appeared')
hide = '\x1b[?25l'
show = '\x1b[?25h'
if hide not in text or show not in text or text.rfind(hide) > text.rfind(show):
    raise SystemExit('cursor was not restored')
if mode == 'accept':
    if proc.returncode != 0 or 'Pruned' not in text:
        sys.stderr.write(text)
        raise SystemExit(f'accept failed cli_exit={proc.returncode}')
elif mode == 'decline':
    if proc.returncode != 1 or text.count('Plugin operation cancelled') != 1 or 'Unexpected internal error' in text:
        sys.stderr.write(text)
        raise SystemExit(f'decline failed cli_exit={proc.returncode}')
elif proc.returncode != 2 or text.count('Cancelled') != 1 or 'Unexpected internal error' in text:
    sys.stderr.write(text)
    raise SystemExit(f'ctrl-c failed cli_exit={proc.returncode}')
print(f'cli_exit={proc.returncode} sent={mode} bytes={len(buffer)}')
```

```bash
export PATH="$HOME/.bun/bin:$PATH"
export AIO_PROXY_HOME="$(mktemp -d)"
python3 /tmp/clack-pty-smoke.py decline bun /agent/repos/aio-proxy/packages/cli/src/main.ts plugin add example-plugin
python3 /tmp/clack-pty-smoke.py ctrl-c bun /agent/repos/aio-proxy/packages/cli/src/main.ts plugin add example-plugin
python3 /tmp/clack-pty-smoke.py accept bun /agent/repos/aio-proxy/packages/cli/src/main.ts plugin prune
python3 /tmp/clack-pty-smoke.py decline /tmp/aio-proxy-clack-smoke plugin add example-plugin
python3 /tmp/clack-pty-smoke.py ctrl-c /tmp/aio-proxy-clack-smoke plugin add example-plugin
python3 /tmp/clack-pty-smoke.py accept /tmp/aio-proxy-clack-smoke plugin prune
```

Expected: each command prints `cli_exit=` within 20 seconds. Accept prints `cli_exit=0`. Decline prints `cli_exit=1`. Ctrl+C prints `cli_exit=2`. None print `prompt never appeared`, `process hung`, `terminal flags changed`, `cursor was not restored`, or `Unexpected internal error`.

- [ ] **Step 4: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add packages/cli/package.json bun.lock .changeset/cli-clack-display.md
git commit -m "feat(cli): drop Inquirer from the CLI"
```

---

## Self-review

Spec coverage:

- Display module, Clack-only dependency, and component allow-list: Tasks 3 and 4.
- One lazy intro and one outro: Task 4, used by Tasks 7–9.
- Stderr chrome vs stdout data, plugin sentence move, provider id, Codex result lines: Tasks 7–9.
- Query commands and `run` summary: Task 10.
- `canPrompt` / `useColor` / machine output left untouched: Tasks 1 and 10. `--json` is not routed through summary.
- Ask semantics, placeholder, `0`, `false`, secret `""`, confirm default no: Tasks 3 and 6.
- Codex `multiselect` and localized empty rejection: Tasks 3 and 9.
- Cancel, `formatCliError` empty message for `PromptCancelledError`, exit code stays `2`, no mutation of unknown errors: Tasks 3 and 4.
- Spinner `AbortSignal`, mid-task cancel, external `signal.reason`, and the real Clack cancel line: Task 4. Codex passes that signal into `inspectCodexSessions` and does not turn abort into a blocked preview: Task 9.
- Codex's own cancelled result suppresses a second `cancel` / `outro`, while `AbortError` during commit stays `authorization_incomplete`: Task 9.
- PTY smoke treats `EIO` as EOF, asserts the CLI exit code, compares `ECHO` / `ICANON` / `ISIG`, checks cursor restore, and accepts `plugin prune`: Task 11.
- Five locales: Task 2.
- Inquirer removed last: Task 11.
- Non-goals stay out of every task: no Help rewrite, no LogTape change, no plugin-sdk import, no new `--json`, no exit-code edit, no rollback.

Placeholder scan: no step says TBD, TODO, "implement later", or "similar to Task N".

Type names used above are the names later tasks import: `canPrompt`, `useColor`, `PromptIo`, `createClackPrompts`, `PromptCancelledError`, `PluginFormPrompts`, `createCommandSession`, `openProductionSession`, `CommandSession`, `beginPluginSession`, `reportLine`, `applyProviderLoginSession`, `isCodexCancellation`, `formatProviderLines`, `formatDeepProviderLines`, `formatPluginLines`, `formatInstalledLines`, `formatDoctorLines`, `formatStatusLine`, `formatRunSummary`.
