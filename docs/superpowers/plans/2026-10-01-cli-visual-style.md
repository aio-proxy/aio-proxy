# CLI Visual Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every human-readable `aio-proxy` CLI output one visual language: monochrome layout, Dashboard-token teal for headings and success, one symbol set, aligned tables and detail blocks.

**Architecture:** A `ui/style` module is the only place that writes ANSI; it maps six roles to Dashboard token colors at the stream's color depth. A `ui/layout` module turns rows and labeled fields into aligned lines without knowing any domain. Help, summaries, provider / plugin / agent lists, errors and the update banner render through those two modules.

**Tech Stack:** Bun (`Bun.color`, `Bun.stringWidth`), Commander 15 (`configureHelp`, `helpGroup`, `commandsGroup`, `helpCommand`), Paraglide i18n, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-01-cli-visual-style-design.md`

## Global Constraints

- Machine output is byte-for-byte unchanged: `--json`, `completion`, `config show`, `config path`, `--version`, `agent auth` stdout, hidden commands.
- No escape codes when the target stream is not a TTY or `NO_COLOR` is set; layout and symbols stay identical without color.
- Color depth: `COLORTERM` `truecolor` / `24bit` → token hex; `TERM` containing `256color` → `Bun.color(hex, 'ansi-256')`; otherwise the hand-written 16-color map. Never `Bun.color(..., 'ansi-16')`.
- Token hex: teal-600 `#009689` (heading, success), olive-500 `#7c7c67` (muted), amber-600 `#e17100` (warning), red-500 `#fb2c36` (danger). 16-color: heading / success 36, muted 90, warning 33, danger 31. Heading and strong are bold.
- Symbols: `●` ok (success), `▲` warn (warning), `✗` fail (danger), `○` off (muted), `→` hint (muted).
- Every new message key goes into all five locales: `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, with identical placeholders. After editing `packages/i18n/messages/*.json` run `cd packages/i18n && bunx paraglide-js compile --emit-ts-declarations` before running CLI tests.
- Never truncate IDs, package names or paths.
- No new dependencies. Tests live next to their source (`foo/foo.ts` + `foo/foo.test.ts` + export-only `foo/index.ts`).
- CLI tests: `cd packages/cli && bun test --preload=./__tests__/setup.ts <path>`.
- Handwritten non-test files stay under 500 lines; split at 400.
- Commits follow Conventional Commits and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- Piped help (`aio-proxy -h | cat`) must contain no escape codes and still show the grouped layout — Task 4 CLI test.
- A 16-color terminal (no `COLORTERM`, `TERM=xterm`) must render warnings yellow, not red — Task 1 test.
- Chinese / Japanese headers or values must not break column alignment — Task 2 tests.
- A provider ID longer than any terminal must appear whole in both the table and the detail view — Task 6 test.
- Subcommand help (`provider -h`) must not show the root-only version header or the `Setup` group — Task 4 test.

---

### Task 1: Style module

**Files:**
- Create: `packages/cli/src/ui/style/style.ts`
- Create: `packages/cli/src/ui/style/index.ts`
- Test: `packages/cli/src/ui/style/style.test.ts`
- Modify: `packages/cli/src/ui/index.ts`

**Interfaces:**
- Consumes: `useColor(streamIsTTY: boolean, env: NodeJS.ProcessEnv): boolean` from `packages/cli/src/ui/mode`.
- Produces:
  - `type ColorDepth = 'none' | '16' | '256' | 'truecolor'`
  - `type Role = 'heading' | 'strong' | 'muted' | 'success' | 'warning' | 'danger'`
  - `type Mark = 'ok' | 'warn' | 'fail' | 'off' | 'hint'`
  - `type Style = Readonly<Record<Role, (text: string) => string>> & { readonly mark: (kind: Mark) => string }`
  - `colorDepth(isTTY: boolean, env: NodeJS.ProcessEnv): ColorDepth`
  - `styleFor(depth: ColorDepth): Style`
  - `createStyle(stream: { readonly isTTY?: boolean }, env?: NodeJS.ProcessEnv): Style`
  - `plainStyle: Style`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/ui/style/style.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { colorDepth, createStyle, plainStyle, styleFor } from './style';

const ESC = '\u001B';

describe('colorDepth', () => {
  test('is none without a TTY or with NO_COLOR', () => {
    expect(colorDepth(false, { COLORTERM: 'truecolor' })).toBe('none');
    expect(colorDepth(true, { NO_COLOR: '', COLORTERM: 'truecolor' })).toBe('none');
  });

  test('reads COLORTERM, then TERM, then falls back to 16 colors', () => {
    expect(colorDepth(true, { COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(colorDepth(true, { COLORTERM: '24bit' })).toBe('truecolor');
    expect(colorDepth(true, { TERM: 'xterm-256color' })).toBe('256');
    expect(colorDepth(true, { TERM: 'xterm' })).toBe('16');
  });
});

describe('styleFor', () => {
  test('plain style leaves text and symbols untouched', () => {
    expect(plainStyle.heading('Server')).toBe('Server');
    expect(plainStyle.mark('ok')).toBe('●');
    expect(plainStyle.mark('warn')).toBe('▲');
    expect(plainStyle.mark('fail')).toBe('✗');
    expect(plainStyle.mark('off')).toBe('○');
    expect(plainStyle.mark('hint')).toBe('→');
    expect(createStyle({ isTTY: false }, {}).danger('x')).toBe('x');
  });

  test('16-color warnings are yellow, never red', () => {
    const warning = styleFor('16').warning('stale');
    expect(warning).toContain(`${ESC}[33m`);
    expect(warning).not.toContain(`${ESC}[31m`);
    expect(warning).not.toContain(`${ESC}[91m`);
  });

  test('truecolor headings are bold Dashboard teal', () => {
    expect(styleFor('truecolor').heading('Server')).toBe(`${ESC}[1m${ESC}[38;2;0;150;137mServer${ESC}[0m`);
  });

  test('256-color success uses the nearest palette index for teal', () => {
    expect(styleFor('256').success('ready')).toBe(`${ESC}[38;5;30mready${ESC}[0m`);
  });

  test('strong is bold without a color', () => {
    expect(styleFor('16').strong('run')).toBe(`${ESC}[1mrun${ESC}[0m`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/style/style.test.ts`
Expected: FAIL with `Cannot find module './style'`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/ui/style/style.ts`:

```ts
import { useColor } from '../mode';

export type ColorDepth = 'none' | '16' | '256' | 'truecolor';
export type Role = 'heading' | 'strong' | 'muted' | 'success' | 'warning' | 'danger';
export type Mark = 'ok' | 'warn' | 'fail' | 'off' | 'hint';
export type Style = Readonly<Record<Role, (text: string) => string>> & { readonly mark: (kind: Mark) => string };

// Dashboard design tokens from packages/ui/src/styles.css, as sRGB hex. The CLI cannot import CSS,
// so these are kept in sync by hand. teal-600 and red-500 pass contrast on light and dark backgrounds.
const TEAL_600 = '#009689';
const OLIVE_500 = '#7c7c67';
const AMBER_600 = '#e17100';
const RED_500 = '#fb2c36';

// Hand-picked 16-color fallback: Bun.color(..., 'ansi-16') maps amber to bright red,
// which would make a warning read as a failure.
const COLORS: Readonly<Record<Exclude<Role, 'strong'>, { readonly hex: string; readonly ansi16: number }>> = {
  heading: { hex: TEAL_600, ansi16: 36 },
  success: { hex: TEAL_600, ansi16: 36 },
  muted: { hex: OLIVE_500, ansi16: 90 },
  warning: { hex: AMBER_600, ansi16: 33 },
  danger: { hex: RED_500, ansi16: 31 },
};

const GLYPHS: Readonly<Record<Mark, readonly [string, Role]>> = {
  ok: ['●', 'success'],
  warn: ['▲', 'warning'],
  fail: ['✗', 'danger'],
  off: ['○', 'muted'],
  hint: ['→', 'muted'],
};

const BOLD = '\u001B[1m';
const RESET = '\u001B[0m';

export function colorDepth(isTTY: boolean, env: NodeJS.ProcessEnv): ColorDepth {
  if (!useColor(isTTY, env)) return 'none';
  const colorterm = env['COLORTERM'];
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  if (env['TERM']?.includes('256color') === true) return '256';
  return '16';
}

function foreground(hex: string, ansi16: number, depth: Exclude<ColorDepth, 'none'>): string {
  const sixteen = `\u001B[${ansi16}m`;
  if (depth === '16') return sixteen;
  return Bun.color(hex, depth === 'truecolor' ? 'ansi-16m' : 'ansi-256') ?? sixteen;
}

export function styleFor(depth: ColorDepth): Style {
  const paint = (role: Role): ((text: string) => string) => {
    if (depth === 'none') return (text) => text;
    if (role === 'strong') return (text) => `${BOLD}${text}${RESET}`;
    const { hex, ansi16 } = COLORS[role];
    const open = `${role === 'heading' ? BOLD : ''}${foreground(hex, ansi16, depth)}`;
    return (text) => `${open}${text}${RESET}`;
  };
  const roles: Readonly<Record<Role, (text: string) => string>> = {
    heading: paint('heading'),
    strong: paint('strong'),
    muted: paint('muted'),
    success: paint('success'),
    warning: paint('warning'),
    danger: paint('danger'),
  };
  return {
    ...roles,
    mark: (kind) => {
      const [glyph, role] = GLYPHS[kind];
      return roles[role](glyph);
    },
  };
}

export function createStyle(stream: { readonly isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): Style {
  return styleFor(colorDepth(stream.isTTY === true, env));
}

export const plainStyle: Style = styleFor('none');
```

`packages/cli/src/ui/style/index.ts`:

```ts
export { colorDepth, createStyle, plainStyle, styleFor, type ColorDepth, type Mark, type Role, type Style } from './style';
```

In `packages/cli/src/ui/index.ts`, add after the `./mode` export line:

```ts
export { createStyle, plainStyle, styleFor, type Style } from './style';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/style/style.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/style packages/cli/src/ui/index.ts
git commit -m "feat(cli): add a style module built on Dashboard tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Layout module

**Files:**
- Create: `packages/cli/src/ui/layout/layout.ts`
- Create: `packages/cli/src/ui/layout/index.ts`
- Test: `packages/cli/src/ui/layout/layout.test.ts`
- Modify: `packages/cli/src/ui/index.ts`

**Interfaces:**
- Consumes: `Style`, `plainStyle` from Task 1.
- Produces:
  - `type TableRow = { readonly mark?: string; readonly cells: readonly string[]; readonly notes?: readonly string[] }`
  - `type Field = readonly [label: string, value: string]`
  - `type Block = { readonly mark: string; readonly title: string; readonly fields: readonly Field[]; readonly notes?: readonly string[] }`
  - `formatTable(style: Style, rows: readonly TableRow[], headers?: readonly string[]): string[]` — headers are upper-cased and muted; when any row has a mark, every line gets a one-column mark gutter; notes are indented four spaces.
  - `formatBlock(style: Style, block: Block): string[]` — `"<mark> <title>"`, then each field as four spaces + muted label padded to the widest label + two spaces + value, then notes indented four spaces.
  - `formatBlocks(style: Style, blocks: readonly Block[]): string[]` — blocks separated by one blank line.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/ui/layout/layout.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { plainStyle, styleFor } from '../style';
import { formatBlock, formatBlocks, formatTable } from './layout';

const columnOf = (line: string, text: string): number => Bun.stringWidth(line.slice(0, line.indexOf(text)));

describe('formatTable', () => {
  test('aligns columns by display width across CJK and ASCII', () => {
    const lines = formatTable(plainStyle, [{ cells: ['字字字', 'x'] }, { cells: ['ab', 'y'] }], ['名称', 'v']);
    expect(columnOf(lines[0]!, 'V')).toBe(columnOf(lines[1]!, 'x'));
    expect(columnOf(lines[1]!, 'x')).toBe(columnOf(lines[2]!, 'y'));
  });

  test('upper-cases headers and does not pad the last column', () => {
    const lines = formatTable(plainStyle, [{ cells: ['a', 'b'] }], ['id', 'kind']);
    expect(lines).toEqual(['ID  KIND', 'a   b']);
  });

  test('adds a mark gutter and indents notes past it', () => {
    const lines = formatTable(plainStyle, [{ mark: '●', cells: ['a', 'b'], notes: ['→ fix'] }], ['id', 'kind']);
    expect(lines).toEqual(['  ID  KIND', '● a   b', '    → fix']);
  });

  test('aligns cells that already carry color', () => {
    const style = styleFor('16');
    const lines = formatTable(style, [{ cells: [style.success('ready'), 'x'] }, { cells: ['unavailable', 'y'] }]);
    expect(columnOf(lines[0]!, 'x')).toBe(columnOf(lines[1]!, 'y'));
  });

  test('keeps a 200-character cell whole', () => {
    const id = 'x'.repeat(200);
    expect(formatTable(plainStyle, [{ cells: [id, 'b'] }]).join('\n')).toContain(id);
  });
});

describe('formatBlock', () => {
  test('aligns values after the widest label, including CJK labels', () => {
    const lines = formatBlock(plainStyle, {
      mark: '●',
      title: 'pi  managed',
      fields: [
        ['主机', '0.99.2'],
        ['endpoint', 'http://127.0.0.1:9317'],
      ],
      notes: ['▲ drifted'],
    });
    expect(lines[0]).toBe('● pi  managed');
    expect(columnOf(lines[1]!, '0.99.2')).toBe(columnOf(lines[2]!, 'http'));
    expect(lines[1]!.startsWith('    ')).toBe(true);
    expect(lines[3]).toBe('    ▲ drifted');
  });

  test('separates blocks with exactly one blank line', () => {
    const block = { mark: '●', title: 't', fields: [] };
    expect(formatBlocks(plainStyle, [block, block])).toEqual(['● t', '', '● t']);
  });
});
```

`Bun.stringWidth` ignores ANSI escapes, so `columnOf` measures visible columns.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/layout/layout.test.ts`
Expected: FAIL with `Cannot find module './layout'`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/ui/layout/layout.ts`:

```ts
import type { Style } from '../style';

export type TableRow = { readonly mark?: string; readonly cells: readonly string[]; readonly notes?: readonly string[] };
export type Field = readonly [label: string, value: string];
export type Block = {
  readonly mark: string;
  readonly title: string;
  readonly fields: readonly Field[];
  readonly notes?: readonly string[];
};

const GAP = '  ';
const INDENT = '    ';

// Bun.stringWidth ignores ANSI escapes, so cells may arrive already styled.
const pad = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - Bun.stringWidth(text)));

function align(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, Bun.stringWidth(cell));
    });
  }
  return rows.map((row) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : pad(cell, widths[index]!))).join(GAP),
  );
}

export function formatTable(style: Style, rows: readonly TableRow[], headers?: readonly string[]): string[] {
  const gutter = rows.some((row) => row.mark !== undefined);
  const lead = (mark: string | undefined): string => (gutter ? `${mark ?? ' '} ` : '');
  const head = headers === undefined ? [] : [headers.map((header) => header.toLocaleUpperCase())];
  const lines = align([...head, ...rows.map((row) => row.cells)]);
  const out = head.length === 0 ? [] : [lead(undefined) + style.muted(lines[0]!)];
  rows.forEach((row, index) => {
    out.push(lead(row.mark) + lines[index + head.length]!);
    for (const note of row.notes ?? []) out.push(INDENT + note);
  });
  return out;
}

export function formatBlock(style: Style, block: Block): string[] {
  const width = Math.max(0, ...block.fields.map(([label]) => Bun.stringWidth(label)));
  return [
    `${block.mark} ${block.title}`,
    ...block.fields.map(([label, value]) => `${INDENT}${style.muted(pad(label, width))}${GAP}${value}`),
    ...(block.notes ?? []).map((note) => INDENT + note),
  ];
}

export function formatBlocks(style: Style, blocks: readonly Block[]): string[] {
  return blocks.flatMap((block, index) => [...(index === 0 ? [] : ['']), ...formatBlock(style, block)]);
}
```

`packages/cli/src/ui/layout/index.ts`:

```ts
export { formatBlock, formatBlocks, formatTable, type Block, type Field, type TableRow } from './layout';
```

In `packages/cli/src/ui/index.ts` add:

```ts
export { formatBlock, formatBlocks, formatTable, type Block, type Field, type TableRow } from './layout';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/layout/layout.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/layout packages/cli/src/ui/index.ts
git commit -m "feat(cli): add table and detail block layout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Message catalog additions

All new copy in one place, so later tasks only consume keys. Removals happen in Task 10, after the last caller is gone.

**Files:**
- Modify: `packages/i18n/messages/en.json`, `zh-Hans.json`, `zh-Hant.json`, `ja.json`, `ko.json`

**Interfaces:**
- Produces these keys (namespaces are nested JSON objects under `cli`; existing objects are extended, not replaced):
  - `cli.help.{usage,options,commands,arguments,group_server,group_providers,group_agents,group_setup,option_description,command_description}`
  - `cli.status.{state_running,state_not_running}`
  - `cli.doctor.{label_config,label_server,label_plugins,server_not_reachable,plugins_none,plugins_installed}` (`plugins_installed` has `{count}`)
  - `cli.run.{running,label_api,label_dashboard}`
  - `cli.ui.{header_name,header_package,header_version,header_directory}`
  - `cli.plugin.state_failed`
  - `cli.update.banner` (`{current}`, `{latest}`)
  - `cli.agent.list.{label_host,label_installation,label_adapter,label_endpoint,label_catalog,label_authorization,label_schema,label_reason,label_target,label_local,label_config,label_provider,label_active_provider,label_base_url,label_connection,label_changed_paths,label_auth_mode,label_lifecycle,label_credential,host_value,catalog_value,section_control_plane,section_authorizations}` (`host_value` has `{version}`, `{minimum}`, `{support}`; `catalog_value` has `{catalog}`, `{lastSuccessfulAt}`)

- [ ] **Step 1: Write the merge script**

Write this throwaway script to your scratch directory as `merge-messages.ts` (do not commit it):

```ts
import { join } from 'node:path';

type Tree = { [key: string]: string | Tree };
const dir = join(process.cwd(), 'packages/i18n/messages');

const patch: Record<string, Tree> = {
  en: {
    help: {
      usage: 'Usage', options: 'Options', commands: 'Commands', arguments: 'Arguments',
      group_server: 'Server', group_providers: 'Providers', group_agents: 'Agents', group_setup: 'Setup',
      option_description: 'Show help', command_description: 'Show help for a command',
    },
    status: { state_running: 'Running', state_not_running: 'Not running' },
    doctor: {
      label_config: 'Config file', label_server: 'Server', label_plugins: 'Plugins',
      server_not_reachable: 'not reachable', plugins_none: 'none installed', plugins_installed: '{count} installed',
    },
    run: { running: 'AIO Proxy is running', label_api: 'API', label_dashboard: 'Dashboard' },
    ui: { header_name: 'name', header_package: 'package', header_version: 'version', header_directory: 'directory' },
    plugin: { state_failed: 'failed' },
    update: { banner: 'Update available {current} → {latest}' },
    agent: {
      list: {
        label_host: 'host', label_installation: 'installation', label_adapter: 'adapter', label_endpoint: 'endpoint',
        label_catalog: 'catalog', label_authorization: 'authorization', label_schema: 'schema', label_reason: 'reason',
        label_target: 'target', label_local: 'local', label_config: 'config', label_provider: 'provider',
        label_active_provider: 'active provider', label_base_url: 'base URL', label_connection: 'connection',
        label_changed_paths: 'changed paths', label_auth_mode: 'auth mode', label_lifecycle: 'lifecycle',
        label_credential: 'credential',
        host_value: '{version} (minimum {minimum}, {support})',
        catalog_value: '{catalog} (last success {lastSuccessfulAt})',
        section_control_plane: 'Control plane', section_authorizations: 'Authorizations',
      },
    },
  },
  'zh-Hans': {
    help: {
      usage: '用法', options: '选项', commands: '命令', arguments: '参数',
      group_server: '服务', group_providers: 'Provider', group_agents: 'Agent', group_setup: '设置',
      option_description: '显示帮助', command_description: '显示命令的帮助',
    },
    status: { state_running: '运行中', state_not_running: '未运行' },
    doctor: {
      label_config: '配置文件', label_server: '服务器', label_plugins: '插件',
      server_not_reachable: '无法访问', plugins_none: '未安装', plugins_installed: '已安装 {count} 个',
    },
    run: { running: 'AIO Proxy 正在运行', label_api: 'API', label_dashboard: 'Dashboard' },
    ui: { header_name: '名称', header_package: '包', header_version: '版本', header_directory: '目录' },
    plugin: { state_failed: '加载失败' },
    update: { banner: '有可用更新 {current} → {latest}' },
    agent: {
      list: {
        label_host: '主机', label_installation: '安装', label_adapter: '适配器', label_endpoint: '端点',
        label_catalog: '目录', label_authorization: '授权', label_schema: 'schema', label_reason: '原因',
        label_target: '目标', label_local: '本地', label_config: '配置', label_provider: 'Provider',
        label_active_provider: '当前 Provider', label_base_url: '基础 URL', label_connection: '连接',
        label_changed_paths: '已修改路径', label_auth_mode: '认证模式', label_lifecycle: '生命周期',
        label_credential: '凭据',
        host_value: '{version}（最低 {minimum}，{support}）',
        catalog_value: '{catalog}（上次成功 {lastSuccessfulAt}）',
        section_control_plane: '控制面', section_authorizations: '授权',
      },
    },
  },
  'zh-Hant': {
    help: {
      usage: '用法', options: '選項', commands: '命令', arguments: '引數',
      group_server: '服務', group_providers: 'Provider', group_agents: 'Agent', group_setup: '設定',
      option_description: '顯示說明', command_description: '顯示命令的說明',
    },
    status: { state_running: '執行中', state_not_running: '未執行' },
    doctor: {
      label_config: '設定檔', label_server: '伺服器', label_plugins: '外掛',
      server_not_reachable: '無法連線', plugins_none: '未安裝', plugins_installed: '已安裝 {count} 個',
    },
    run: { running: 'AIO Proxy 正在執行', label_api: 'API', label_dashboard: 'Dashboard' },
    ui: { header_name: '名稱', header_package: '套件', header_version: '版本', header_directory: '目錄' },
    plugin: { state_failed: '載入失敗' },
    update: { banner: '有可用更新 {current} → {latest}' },
    agent: {
      list: {
        label_host: '主機', label_installation: '安裝', label_adapter: '轉接器', label_endpoint: '端點',
        label_catalog: '目錄', label_authorization: '授權', label_schema: 'schema', label_reason: '原因',
        label_target: '目標', label_local: '本機', label_config: '設定', label_provider: 'Provider',
        label_active_provider: '目前 Provider', label_base_url: '基礎 URL', label_connection: '連線',
        label_changed_paths: '已修改路徑', label_auth_mode: '驗證模式', label_lifecycle: '生命週期',
        label_credential: '憑證',
        host_value: '{version}（最低 {minimum}，{support}）',
        catalog_value: '{catalog}（上次成功 {lastSuccessfulAt}）',
        section_control_plane: '控制面', section_authorizations: '授權',
      },
    },
  },
  ja: {
    help: {
      usage: '使い方', options: 'オプション', commands: 'コマンド', arguments: '引数',
      group_server: 'サーバー', group_providers: 'Provider', group_agents: 'Agent', group_setup: 'セットアップ',
      option_description: 'ヘルプを表示', command_description: 'コマンドのヘルプを表示',
    },
    status: { state_running: '実行中', state_not_running: '停止中' },
    doctor: {
      label_config: '設定ファイル', label_server: 'サーバー', label_plugins: 'プラグイン',
      server_not_reachable: '到達できません', plugins_none: 'インストールなし', plugins_installed: '{count} 個インストール済み',
    },
    run: { running: 'AIO Proxy は実行中です', label_api: 'API', label_dashboard: 'Dashboard' },
    ui: { header_name: '名前', header_package: 'パッケージ', header_version: 'バージョン', header_directory: 'ディレクトリ' },
    plugin: { state_failed: '読み込み失敗' },
    update: { banner: 'アップデートがあります {current} → {latest}' },
    agent: {
      list: {
        label_host: 'ホスト', label_installation: 'インストール', label_adapter: 'アダプター', label_endpoint: 'エンドポイント',
        label_catalog: 'カタログ', label_authorization: '認可', label_schema: 'スキーマ', label_reason: '理由',
        label_target: '対象', label_local: 'ローカル', label_config: '設定', label_provider: 'Provider',
        label_active_provider: '使用中の Provider', label_base_url: 'ベース URL', label_connection: '接続',
        label_changed_paths: '変更されたパス', label_auth_mode: '認証モード', label_lifecycle: 'ライフサイクル',
        label_credential: '認証情報',
        host_value: '{version}（最低 {minimum}、{support}）',
        catalog_value: '{catalog}（最終成功 {lastSuccessfulAt}）',
        section_control_plane: 'コントロールプレーン', section_authorizations: '認可',
      },
    },
  },
  ko: {
    help: {
      usage: '사용법', options: '옵션', commands: '명령', arguments: '인수',
      group_server: '서버', group_providers: 'Provider', group_agents: 'Agent', group_setup: '설정',
      option_description: '도움말 표시', command_description: '명령 도움말 표시',
    },
    status: { state_running: '실행 중', state_not_running: '실행 중 아님' },
    doctor: {
      label_config: '구성 파일', label_server: '서버', label_plugins: '플러그인',
      server_not_reachable: '연결할 수 없음', plugins_none: '설치된 항목 없음', plugins_installed: '{count}개 설치됨',
    },
    run: { running: 'AIO Proxy 실행 중', label_api: 'API', label_dashboard: 'Dashboard' },
    ui: { header_name: '이름', header_package: '패키지', header_version: '버전', header_directory: '디렉터리' },
    plugin: { state_failed: '로드 실패' },
    update: { banner: '업데이트 가능 {current} → {latest}' },
    agent: {
      list: {
        label_host: '호스트', label_installation: '설치', label_adapter: '어댑터', label_endpoint: '엔드포인트',
        label_catalog: '카탈로그', label_authorization: '권한', label_schema: '스키마', label_reason: '이유',
        label_target: '대상', label_local: '로컬', label_config: '구성', label_provider: 'Provider',
        label_active_provider: '활성 Provider', label_base_url: '기본 URL', label_connection: '연결',
        label_changed_paths: '변경된 경로', label_auth_mode: '인증 모드', label_lifecycle: '수명 주기',
        label_credential: '자격 증명',
        host_value: '{version} (최소 {minimum}, {support})',
        catalog_value: '{catalog} (마지막 성공 {lastSuccessfulAt})',
        section_control_plane: '컨트롤 플레인', section_authorizations: '권한 부여',
      },
    },
  },
};

const merge = (target: Tree, source: Tree): void => {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      if (target[key] !== undefined) throw new Error(`refusing to overwrite ${key}`);
      target[key] = value;
    } else {
      const child = target[key];
      if (typeof child === 'string') throw new Error(`${key} is a message, not a namespace`);
      target[key] = child ?? {};
      merge(target[key] as Tree, value);
    }
  }
};

for (const [locale, tree] of Object.entries(patch)) {
  const path = join(dir, `${locale}.json`);
  const data = (await Bun.file(path).json()) as Tree;
  merge(data['cli'] as Tree, tree);
  await Bun.write(path, `${JSON.stringify(data, undefined, 2)}\n`);
}
```

- [ ] **Step 2: Run the script, format, and compile**

Run from the repo root:

```bash
bun <scratch>/merge-messages.ts
bunx oxfmt packages/i18n/messages
cd packages/i18n && bunx paraglide-js compile --emit-ts-declarations
```

Expected: no `refusing to overwrite` error; `git diff --stat packages/i18n/messages` shows only additions in all five files.

- [ ] **Step 3: Run the locale parity test**

Run: `cd packages/i18n && bun run test:unit`
Expected: PASS, including `all five locales share one key set and one placeholder set per key`.

- [ ] **Step 4: Commit**

```bash
git add packages/i18n/messages
git commit -m "feat(i18n): add copy for the CLI visual style

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Help

**Files:**
- Create: `packages/cli/src/ui/help/help.ts`
- Create: `packages/cli/src/ui/help/index.ts`
- Test: `packages/cli/src/ui/help/help.test.ts`
- Modify: `packages/cli/src/ui/index.ts`
- Modify: `packages/cli/src/main.ts` (command order, `helpGroup`, call `applyHelpStyle`)
- Modify: `packages/cli/src/agent/output.ts:163` (`agent` command `helpGroup`)
- Test: `packages/cli/src/main.rendering.test.ts` (piped help)

**Interfaces:**
- Consumes: `Style`, `styleFor`, `createStyle` (Task 1); `cli.help.*` keys (Task 3).
- Produces: `applyHelpStyle(program: Command, style: Style): void` — must be called after every command is registered (Commander copies help settings into a subcommand only when it is created, so this walks the tree itself).

- [ ] **Step 1: Write the failing unit test**

`packages/cli/src/ui/help/help.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { Command } from 'commander';

import { plainStyle, styleFor } from '../style';
import { applyHelpStyle } from './help';

const ESC = '\u001B';

function build(): Command {
  const program = new Command().name('aio-proxy').description('AIO Proxy').version('1.2.3');
  program.command('run').helpGroup('Server').description('Start');
  const provider = program.command('provider').helpGroup('Providers').description('Providers');
  provider.command('list').description('List providers');
  program.command('doctor').helpGroup('Setup').description('Diagnose');
  return program;
}

describe('applyHelpStyle', () => {
  test('root help leads with name, version and description, then usage', () => {
    const program = build();
    applyHelpStyle(program, plainStyle);
    const text = program.helpInformation();
    expect(text.startsWith('aio-proxy 1.2.3 · AIO Proxy\n\nUsage aio-proxy [options] [command]\n')).toBe(true);
    expect(text.match(/AIO Proxy/g)).toHaveLength(1);
  });

  test('groups commands and files help under Setup', () => {
    const program = build();
    applyHelpStyle(program, plainStyle);
    const text = program.helpInformation();
    const server = text.indexOf('\nServer\n');
    const providers = text.indexOf('\nProviders\n');
    const setup = text.indexOf('\nSetup\n');
    expect(server).toBeGreaterThan(-1);
    expect(providers).toBeGreaterThan(server);
    expect(setup).toBeGreaterThan(providers);
    expect(text.indexOf('help [command]')).toBeGreaterThan(setup);
    expect(text).toContain('Show help for a command');
    expect(text).toContain('Show help');
    expect(text).not.toContain('display help');
    expect(text).not.toContain(':\n');
  });

  test('subcommand help has no version header and no Setup group', () => {
    const program = build();
    applyHelpStyle(program, plainStyle);
    const provider = program.commands.find((command) => command.name() === 'provider')!;
    const text = provider.helpInformation();
    expect(text.startsWith('Usage aio-proxy provider')).toBe(true);
    expect(text).toContain('\nCommands\n');
    expect(text).not.toContain('Setup');
    expect(text).not.toContain('1.2.3');
  });

  test('colors titles as headings, names as strong, placeholders as muted', () => {
    const program = build();
    applyHelpStyle(program, styleFor('16'));
    const text = program.helpInformation();
    expect(text).toContain(`${ESC}[1m${ESC}[36mServer${ESC}[0m`);
    expect(text).toContain(`${ESC}[1mrun${ESC}[0m`);
    expect(text).toContain(`${ESC}[90m[options]${ESC}[0m`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/help/help.test.ts`
Expected: FAIL with `Cannot find module './help'`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/ui/help/help.ts`:

```ts
import { m } from '@aio-proxy/i18n';
import { type Command, Help } from 'commander';

import type { Style } from '../style';

// Commander hard-codes these titles; everything else is a group heading we authored.
const TITLES: Readonly<Record<string, () => string>> = {
  'Usage:': () => m['cli.help.usage'](),
  'Options:': () => m['cli.help.options'](),
  'Commands:': () => m['cli.help.commands'](),
  'Arguments:': () => m['cli.help.arguments'](),
};

export function applyHelpStyle(program: Command, style: Style): void {
  // `run [options]`, `--lang <locale>`: names strong, placeholders muted.
  const term = (text: string): string =>
    text
      .split(' ')
      .map((word) => (word.startsWith('[') || word.startsWith('<') ? style.muted(word) : style.strong(word)))
      .join(' ');
  const configuration = {
    styleTitle: (title: string) => style.heading(TITLES[title]?.() ?? title.replace(/:$/, '')),
    styleUsage: term,
    styleSubcommandTerm: term,
    styleOptionTerm: term,
    styleArgumentTerm: (text: string) => style.muted(text),
    styleDescriptionText: (text: string) => style.muted(text),
    // The root description moves into the header line.
    commandDescription: (cmd: Command) => (cmd.parent === null ? '' : cmd.description()),
    formatHelp: (cmd: Command, helper: Help) => {
      const body = Help.prototype.formatHelp.call(helper, cmd, helper);
      if (cmd.parent !== null) return body;
      return `${style.strong(cmd.name())} ${style.muted(`${cmd.version() ?? ''} · ${cmd.description()}`)}\n\n${body}`;
    },
  };
  const visit = (cmd: Command): void => {
    cmd.configureHelp(configuration);
    cmd.helpOption('-h, --help', m['cli.help.option_description']());
    if (cmd.commands.length > 0) {
      if (cmd.parent === null) cmd.commandsGroup(m['cli.help.group_setup']());
      cmd.helpCommand('help [command]', m['cli.help.command_description']());
    }
    for (const sub of cmd.commands) visit(sub);
  };
  visit(program);
}
```

`packages/cli/src/ui/help/index.ts`:

```ts
export { applyHelpStyle } from './help';
```

In `packages/cli/src/ui/index.ts` add:

```ts
export { applyHelpStyle } from './help';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/help/help.test.ts`
Expected: PASS (4 tests). Commander prints a subcommand's usage with its parent names (`aio-proxy provider [options] [command]`), so the subcommand header reads `Usage aio-proxy provider …`.

- [ ] **Step 5: Write the failing CLI test for real help**

Add to `packages/cli/src/main.rendering.test.ts`, inside `describe('cli rendering', …)`:

```ts
  test('root help is grouped and plain when piped', () => {
    const help = runCli(['--help']).stdout.toString();
    expect(help).not.toContain('\u001b');
    const order = ['\nServer\n', '\nProviders\n', '\nAgents\n', '\nSetup\n'].map((heading) => help.indexOf(heading));
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const server = help.slice(order[0], order[1]);
    for (const name of ['run', 'reload', 'status', 'dashboard', 'service']) expect(server).toContain(`  ${name}`);
    const setup = help.slice(order[3]);
    for (const name of ['config', 'doctor', 'completion', 'upgrade', 'help']) expect(setup).toContain(`  ${name}`);
  }, 60_000);
```

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/main.rendering.test.ts -t 'root help is grouped'`
Expected: FAIL (no `Server` heading yet).

- [ ] **Step 6: Group and reorder commands in `main.ts`**

Commander orders groups by the first command registered in each, so registration order becomes Server → Providers → Agents → Setup.

1. Import: change `import { PromptCancelledError } from './ui';` to `import { applyHelpStyle, createStyle, PromptCancelledError } from './ui';`.
2. In `registerServiceCommands`, change the first line to:

```ts
  const service = program
    .command('service')
    .helpGroup(m['cli.help.group_server']())
    .description(m['cli.service.description']());
```

3. Add `.helpGroup(m['cli.help.group_server']())` directly after `.command('run')`, `.command('reload')`, `.command('status')`, `.command('dashboard')`.
4. Add `.helpGroup(m['cli.help.group_providers']())` after `program.command('provider')` and `program.command('plugin')`.
5. Add `.helpGroup(m['cli.help.group_setup']())` after `program.command('config')`, `.command('doctor')`, `.command('completion <shell>')`, `.command('upgrade')`.
6. Reorder the body of `buildProgram` after the `preAction` hook to exactly: `run`, `reload`, `status`, `dashboard`, `registerServiceCommands(program)`, the `provider` block, the `plugin` block, `bindAgentCommands(program, deps)`, the `config` block, `doctor`, `completion`, `upgrade`, `registerHiddenPostUpgrade(program, deps)`, `registerHiddenDesktopConnect(program)`. Move blocks verbatim; change nothing else inside them.
7. Directly before `return program;` add:

```ts
  applyHelpStyle(program, createStyle(process.stdout));
```

In `packages/cli/src/agent/output.ts`, change `const agent = program.command('agent').description(m['cli.agent.description']());` to:

```ts
  const agent = program
    .command('agent')
    .helpGroup(m['cli.help.group_agents']())
    .description(m['cli.agent.description']());
```

- [ ] **Step 7: Run CLI help tests**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/main.rendering.test.ts src/main.test.ts src/ui/help/help.test.ts`
Expected: PASS. `localizes help when --lang overrides environment` still passes because the root description is now in the header line.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/ui/help packages/cli/src/ui/index.ts packages/cli/src/main.ts packages/cli/src/agent/output.ts packages/cli/src/main.rendering.test.ts
git commit -m "feat(cli): group and style help

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `status`, `doctor`, `run`

**Files:**
- Modify: `packages/cli/src/ui/summary/summary.ts` (replace `formatStatusLine`, `formatDoctorLines`, `formatRunSummary`; drop `fits` users here)
- Test: `packages/cli/src/ui/summary/summary.test.ts` (replace the `formatDoctorLines`, `formatStatusLine`, `formatRunSummary` describes)
- Modify: `packages/cli/src/status/status.ts:5,57,90`
- Modify: `packages/cli/src/doctor/doctor.ts`
- Modify: `packages/cli/src/run/run.ts:18,284`

**Interfaces:**
- Consumes: `Style`, `createStyle` (Task 1); `formatTable`, `formatBlock` (Task 2); `cli.status.state_*`, `cli.doctor.label_*`, `cli.doctor.server_not_reachable`, `cli.doctor.plugins_*`, `cli.run.*` (Task 3).
- Produces:
  - `formatStatusLine(style: Style, status: { readonly running: boolean; readonly url: string; readonly version?: string }): string`
  - `formatDoctorLines(style: Style, report: { readonly configPath: string; readonly url: string; readonly version?: string; readonly reachable: boolean; readonly pluginCount: number }): readonly string[]`
  - `formatRunSummary(style: Style, apiUrl: string, dashboardUrl: string): readonly string[]`

- [ ] **Step 1: Write the failing tests**

In `packages/cli/src/ui/summary/summary.test.ts`, add `import { plainStyle } from '../style';` and replace the `formatDoctorLines`, `formatStatusLine` and `formatRunSummary` describe blocks with:

```ts
describe('formatDoctorLines', () => {
  const doctor = { configPath: '/cfg', url: 'http://127.0.0.1:9317', version: '1.2.3', reachable: true, pluginCount: 2 };
  const valueColumn = (line: string, value: string): number => Bun.stringWidth(line.slice(0, line.indexOf(value)));

  test('prints one marked, aligned line per check', () => {
    const lines = formatDoctorLines(plainStyle, doctor);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith('● '))).toBe(true);
    expect(lines[1]).toContain('http://127.0.0.1:9317 · v1.2.3');
    expect(valueColumn(lines[0]!, '/cfg')).toBe(valueColumn(lines[1]!, 'http'));
  });

  test('marks an unreachable server as failed and no plugins as a warning', () => {
    const lines = formatDoctorLines(plainStyle, { ...doctor, reachable: false, pluginCount: 0 });
    expect(lines[1]!.startsWith('✗ ')).toBe(true);
    expect(lines[1]).toContain(m['cli.doctor.server_not_reachable']());
    expect(lines[2]!.startsWith('▲ ')).toBe(true);
    expect(lines[2]).toContain(m['cli.doctor.plugins_none']());
  });
});

describe('formatStatusLine', () => {
  test('marks a running proxy and shows address and version', () => {
    const line = formatStatusLine(plainStyle, { running: true, url: 'http://127.0.0.1:9317', version: '1.2.3' });
    expect(line).toBe(`● ${m['cli.status.state_running']()}  http://127.0.0.1:9317 · v1.2.3`);
  });

  test('omits the version instead of printing vunknown', () => {
    const line = formatStatusLine(plainStyle, { running: true, url: 'http://127.0.0.1:9317' });
    expect(line).not.toContain('unknown');
    expect(line.endsWith('http://127.0.0.1:9317')).toBe(true);
  });

  test('marks a stopped proxy with an open circle', () => {
    const line = formatStatusLine(plainStyle, { running: false, url: 'http://127.0.0.1:9317' });
    expect(line).toBe(`○ ${m['cli.status.state_not_running']()}  http://127.0.0.1:9317`);
  });
});

describe('formatRunSummary', () => {
  test('prints a block with aligned API and Dashboard addresses and no color', () => {
    const lines = formatRunSummary(plainStyle, 'http://127.0.0.1:9317', 'http://127.0.0.1:9317/dashboard');
    expect(lines[0]).toBe(`● ${m['cli.run.running']()}`);
    expect(lines[1]).toContain('http://127.0.0.1:9317');
    expect(lines[2]).toContain('http://127.0.0.1:9317/dashboard');
    expect(lines.join('\n')).not.toContain('\u001b');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary/summary.test.ts`
Expected: FAIL (old signatures take no style).

- [ ] **Step 3: Implement**

In `packages/cli/src/ui/summary/summary.ts` add imports:

```ts
import { formatBlock, formatTable } from '../layout';
import type { Style } from '../style';
```

Replace `formatDoctorLines`, `formatStatusLine`, `formatRunSummary` with:

```ts
const withVersion = (url: string, version: string | undefined): string =>
  version === undefined ? url : `${url} · v${version}`;

export function formatDoctorLines(
  style: Style,
  report: {
    readonly configPath: string;
    readonly url: string;
    readonly version?: string;
    readonly reachable: boolean;
    readonly pluginCount: number;
  },
): readonly string[] {
  const server = report.reachable
    ? { mark: style.mark('ok'), value: withVersion(report.url, report.version) }
    : { mark: style.mark('fail'), value: `${report.url} · ${m['cli.doctor.server_not_reachable']()}` };
  const plugins =
    report.pluginCount === 0
      ? { mark: style.mark('warn'), value: m['cli.doctor.plugins_none']() }
      : { mark: style.mark('ok'), value: m['cli.doctor.plugins_installed']({ count: report.pluginCount }) };
  return formatTable(style, [
    { mark: style.mark('ok'), cells: [m['cli.doctor.label_config'](), style.muted(report.configPath)] },
    { mark: server.mark, cells: [m['cli.doctor.label_server'](), style.muted(server.value)] },
    { mark: plugins.mark, cells: [m['cli.doctor.label_plugins'](), style.muted(plugins.value)] },
  ]);
}

export function formatStatusLine(
  style: Style,
  status: { readonly running: boolean; readonly url: string; readonly version?: string },
): string {
  return status.running
    ? `${style.mark('ok')} ${m['cli.status.state_running']()}  ${style.muted(withVersion(status.url, status.version))}`
    : `${style.mark('off')} ${m['cli.status.state_not_running']()}  ${style.muted(status.url)}`;
}

export function formatRunSummary(style: Style, apiUrl: string, dashboardUrl: string): readonly string[] {
  return formatBlock(style, {
    mark: style.mark('ok'),
    title: style.strong(m['cli.run.running']()),
    fields: [
      [m['cli.run.label_api'](), apiUrl],
      [m['cli.run.label_dashboard'](), dashboardUrl],
    ],
  });
}
```

If `m['cli.doctor.plugins_installed']` is typed to take `count` as a string, pass `String(report.pluginCount)`.

Callers:

- `packages/cli/src/status/status.ts`: change the import to `import { createStyle, formatDeepProviderLines, formatStatusLine, useColor } from '../ui';`. At the top of `statusCommand` add `const style = createStyle(process.stdout);`. Replace both `formatStatusLine({ … })` calls with `formatStatusLine(style, { … })`. Leave the `--deep` branch for Task 6.
- `packages/cli/src/doctor/doctor.ts`: change the import to `import { createStyle, formatDoctorLines } from '../ui';` and the loop to:

```ts
  for (const line of formatDoctorLines(createStyle(process.stdout), {
    configPath: configPath(),
    url,
    ...(health?.version === undefined ? {} : { version: health.version }),
    reachable: health !== null,
    pluginCount: installed.length,
  })) {
    print(line);
  }
```

- `packages/cli/src/run/run.ts`: change the import to `import { createStyle, formatRunSummary } from '../ui';` and line 284 to:

```ts
  for (const line of formatRunSummary(
    createStyle(process.stderr),
    controlBaseUrl(server.hostname ?? host, String(server.port)),
    dashboardUrl,
  )) {
    console.error(line);
  }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary src/status src/doctor src/run`
Expected: PASS. If a `status` / `doctor` / `run` test compares the old sentence (`cli.status.running`, `cli.doctor.config_path`, `cli.run.started`), change it to the new line shape asserted above; keep `status --json` assertions untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/summary packages/cli/src/status packages/cli/src/doctor packages/cli/src/run
git commit -m "feat(cli): restyle status, doctor and run summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Provider list, test, deep status, installed packages

**Files:**
- Create: `packages/cli/src/ui/summary/provider.ts` (provider formatting moves here from `summary.ts`)
- Test: `packages/cli/src/ui/summary/provider.test.ts` (provider describes move here from `summary.test.ts`)
- Modify: `packages/cli/src/ui/summary/summary.ts` (delete provider code, `labelValue`, `formatInstalledLines` → table)
- Modify: `packages/cli/src/ui/summary/index.ts`, `packages/cli/src/ui/index.ts`
- Modify: `packages/cli/src/provider-commands.ts:15,70-89`
- Modify: `packages/cli/src/status/status.ts` (`--deep` branch)

**Interfaces:**
- Consumes: Tasks 1–3; `dashboardProviderSuggestedCommand` from `@aio-proxy/types`.
- Produces:
  - `formatProviderLines(style: Style, providers: readonly DashboardProviderSummary[], probe: boolean): readonly string[]` — empty → the empty copy; exactly one → detail block; otherwise table.
  - `formatDeepProviderLines(style: Style, data: unknown): readonly string[] | undefined`
  - `formatInstalledLines(style: Style, items: readonly { readonly packageName: string; readonly version: string; readonly directory: string }[]): readonly string[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/ui/summary/provider.test.ts` and delete the `formatProviderLines` and `formatDeepProviderLines` describes (and the `provider` fixture) from `summary.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';

import { plainStyle } from '../style';
import { formatDeepProviderLines, formatProviderLines } from './provider';

const provider: DashboardProviderSummary = {
  id: 'openai',
  kind: 'api',
  enabled: true,
  passthrough: false,
  last_status: 'ok',
  last_latency: 212,
  protocols: [],
  hasQuota: false,
  canRefreshCredential: false,
  clientModels: [],
  state: { status: 'ready', catalog: 'fresh' },
};
const diagnostic = {
  code: 'CATALOG_UNAVAILABLE',
  summary: 'catalog fetch failed',
  retryable: true,
  occurredAt: '2026-10-01T00:00:00.000Z',
  suggestedCommand: 'aio-proxy provider test copilot',
} as const;

const rowFor = (lines: readonly string[], id: string): string => lines.find((line) => line.includes(` ${id} `))!;

describe('formatProviderLines table', () => {
  test('marks each provider by state', () => {
    const lines = formatProviderLines(
      plainStyle,
      [
        provider,
        { ...provider, id: 'off', enabled: false },
        { ...provider, id: 'down', state: { status: 'unavailable', diagnostic } },
        { ...provider, id: 'stale', state: { status: 'ready', catalog: 'stale' } },
      ],
      false,
    );
    expect(rowFor(lines, 'openai').startsWith('● ')).toBe(true);
    expect(rowFor(lines, 'off').startsWith('○ ')).toBe(true);
    expect(rowFor(lines, 'down').startsWith('✗ ')).toBe(true);
    expect(rowFor(lines, 'stale').startsWith('▲ ')).toBe(true);
  });

  test('prints a header and latency in milliseconds', () => {
    const lines = formatProviderLines(plainStyle, [provider, { ...provider, id: 'b', last_latency: null }], false);
    expect(lines[0]).toContain(m['cli.provider.list.header_id']().toLocaleUpperCase());
    expect(rowFor(lines, 'openai')).toContain('212ms');
    expect(lines.join('\n')).not.toContain('passthrough');
  });

  test('puts the diagnostic and suggested command under the row', () => {
    const lines = formatProviderLines(
      plainStyle,
      [provider, { ...provider, id: 'copilot', state: { status: 'ready', catalog: 'fresh', diagnostic } }],
      false,
    );
    const row = lines.indexOf(rowFor(lines, 'copilot'));
    expect(lines[row + 1]).toBe('    catalog fetch failed');
    expect(lines[row + 2]).toBe('    → aio-proxy provider test copilot');
  });

  test('adds a probe column with --probe', () => {
    const lines = formatProviderLines(plainStyle, [provider, { ...provider, id: 'b', probe: 'OK' }], true);
    expect(lines[0]).toContain(m['cli.provider.list.header_probe']().toLocaleUpperCase());
    expect(rowFor(lines, 'openai')).toContain('FAIL');
    expect(rowFor(lines, 'b')).toContain('OK');
  });

  test('keeps a 200-character provider id intact', () => {
    const id = 'x'.repeat(200);
    const text = formatProviderLines(plainStyle, [provider, { ...provider, id }], false).join('\n');
    expect(text).toContain(id);
  });
});

describe('formatProviderLines detail', () => {
  test('shows every field for exactly one provider', () => {
    const lines = formatProviderLines(plainStyle, [provider], true);
    expect(lines[0]).toBe('● openai');
    expect(lines).toHaveLength(1 + 16);
    for (const key of ['header_passthrough', 'header_account', 'header_suggested_command', 'header_probe'] as const) {
      expect(lines.join('\n')).toContain(m[`cli.provider.list.${key}`]());
    }
  });

  test('keeps a 200-character provider id intact', () => {
    const id = 'x'.repeat(200);
    expect(formatProviderLines(plainStyle, [{ ...provider, id }], false)[0]).toBe(`● ${id}`);
  });
});

test('returns the empty copy when there are no providers', () => {
  expect(formatProviderLines(plainStyle, [], false)).toEqual([m['cli.ui.provider_list_empty']()]);
});

test('formatDeepProviderLines formats a probe view and rejects unexpected payloads', () => {
  expect(formatDeepProviderLines(plainStyle, { providers: [provider] })?.join('\n')).toContain('FAIL');
  expect(formatDeepProviderLines(plainStyle, { providers: 'nope' })).toBeUndefined();
});
```

In `summary.test.ts`, replace the `formatInstalledLines` describe with:

```ts
describe('formatInstalledLines', () => {
  test('prints an aligned table with a header', () => {
    const lines = formatInstalledLines(plainStyle, [
      { packageName: 'pkg', version: '1.0.0', directory: '/tmp/pkg' },
      { packageName: '@scope/longer', version: '10.0.0', directory: '/tmp/l' },
    ]);
    expect(lines[0]).toContain(m['cli.ui.header_package']().toLocaleUpperCase());
    expect(Bun.stringWidth(lines[1]!.slice(0, lines[1]!.indexOf('1.0.0')))).toBe(
      Bun.stringWidth(lines[2]!.slice(0, lines[2]!.indexOf('10.0.0'))),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary`
Expected: FAIL with `Cannot find module './provider'`.

- [ ] **Step 3: Implement**

`packages/cli/src/ui/summary/provider.ts`:

```ts
import { m } from '@aio-proxy/i18n';
import {
  type DashboardProviderSummary,
  DashboardProvidersResponseSchema,
  dashboardProviderSuggestedCommand,
} from '@aio-proxy/types';

import { type Block, type Field, formatBlock, formatTable, type TableRow } from '../layout';
import type { Style } from '../style';

const ProviderListSchema = DashboardProvidersResponseSchema.pick({ providers: true });

function providerMark(style: Style, provider: DashboardProviderSummary): string {
  if (!provider.enabled) return style.mark('off');
  if (provider.state.status === 'unavailable') return style.mark('fail');
  if (provider.state.catalog === 'stale' || provider.state.diagnostic !== undefined) return style.mark('warn');
  return style.mark('ok');
}

const stateCell = (style: Style, provider: DashboardProviderSummary): string =>
  provider.state.status === 'ready' ? style.success('ready') : style.danger(provider.state.status);

function catalogCell(style: Style, provider: DashboardProviderSummary): string {
  const catalog = provider.state.status === 'ready' ? provider.state.catalog : undefined;
  if (catalog === undefined) return style.muted('-');
  return catalog === 'stale' ? style.warning(catalog) : catalog;
}

const probeCell = (style: Style, provider: DashboardProviderSummary): string =>
  provider.probe === 'OK' ? style.success('OK') : style.danger('FAIL');

function providerRow(style: Style, provider: DashboardProviderSummary, probe: boolean): TableRow {
  const suggested = dashboardProviderSuggestedCommand(provider);
  const summary = provider.state.diagnostic?.summary;
  return {
    mark: providerMark(style, provider),
    cells: [
      style.strong(provider.id),
      provider.kind,
      stateCell(style, provider),
      catalogCell(style, provider),
      provider.last_latency === null ? style.muted('-') : `${provider.last_latency}ms`,
      ...(probe ? [probeCell(style, provider)] : []),
    ],
    notes: [
      ...(summary === undefined ? [] : [style.muted(summary)]),
      ...(suggested === undefined ? [] : [`${style.mark('hint')} ${style.muted(suggested)}`]),
    ],
  };
}

function providerBlock(style: Style, provider: DashboardProviderSummary, probe: boolean): Block {
  const catalog = provider.state.status === 'ready' ? (provider.state.catalog ?? '-') : '-';
  const fields: Field[] = [
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
    [
      m['cli.provider.list.header_expires_at'](),
      provider.expiresAt === undefined ? '-' : new Date(provider.expiresAt).toISOString(),
    ],
    [m['cli.provider.list.header_catalog_last_success_at'](), provider.catalogLastSuccessAt ?? '-'],
    [m['cli.provider.list.header_diagnostic'](), provider.state.diagnostic?.summary ?? '-'],
    [m['cli.provider.list.header_suggested_command'](), dashboardProviderSuggestedCommand(provider) ?? '-'],
  ];
  if (probe) fields.push([m['cli.provider.list.header_probe'](), provider.probe ?? 'FAIL']);
  return { mark: providerMark(style, provider), title: style.strong(provider.id), fields };
}

export function formatProviderLines(
  style: Style,
  providers: readonly DashboardProviderSummary[],
  probe: boolean,
): readonly string[] {
  if (providers.length === 0) return [m['cli.ui.provider_list_empty']()];
  if (providers.length === 1) return formatBlock(style, providerBlock(style, providers[0]!, probe));
  const headers = [
    m['cli.provider.list.header_id'](),
    m['cli.provider.list.header_kind'](),
    m['cli.provider.list.header_state'](),
    m['cli.provider.list.header_catalog'](),
    m['cli.provider.list.header_last_latency'](),
    ...(probe ? [m['cli.provider.list.header_probe']()] : []),
  ];
  return formatTable(
    style,
    providers.map((provider) => providerRow(style, provider, probe)),
    headers,
  );
}

export function formatDeepProviderLines(style: Style, data: unknown): readonly string[] | undefined {
  const parsed = ProviderListSchema.safeParse(data);
  if (!parsed.success) return undefined;
  return formatProviderLines(style, parsed.data.providers, true);
}
```

The detail view has the id twice (title and the `id` field): that keeps the field count identical to today (16, or 17 with probe — the test counts `1 + 16` for one title plus fifteen fields plus probe).

In `summary.ts`: delete `ProviderListSchema`, `labelValue`, `fits`, `providerFields`, `formatProviderLines`, `formatDeepProviderLines` and their now-unused imports (`DashboardProviderSummary`, `DashboardProvidersResponseSchema`, `dashboardProviderSuggestedCommand`). Replace `formatInstalledLines` with:

```ts
export function formatInstalledLines(
  style: Style,
  items: readonly { readonly packageName: string; readonly version: string; readonly directory: string }[],
): readonly string[] {
  return formatTable(
    style,
    items.map((item) => ({ cells: [style.strong(item.packageName), item.version, style.muted(item.directory)] })),
    [m['cli.ui.header_package'](), m['cli.ui.header_version'](), m['cli.ui.header_directory']()],
  );
}
```

`formatPluginLines` stays until Task 7; it still uses `fits`, so move `fits` down next to it instead of deleting it if it is still referenced.

`packages/cli/src/ui/summary/index.ts`: export `formatDeepProviderLines` and `formatProviderLines` from `./provider` and the rest from `./summary` (keep the existing names).

`packages/cli/src/provider-commands.ts`:

```ts
import { createStyle, formatInstalledLines, formatProviderLines } from './ui';
```

```ts
async function providerInstalledList(): Promise<void> {
  const installed = await listInstalledNpmPackages();
  if (installed.length === 0) return;
  const items = installed.map((item) => ({
    packageName: item.packageName,
    version: item.version,
    directory: dirname(item.entrypoint),
  }));
  for (const line of formatInstalledLines(createStyle(process.stdout), items)) console.log(line);
}

function printProviderTable(providers: readonly DashboardProviderSummary[], probe: boolean): void {
  for (const line of formatProviderLines(createStyle(process.stdout), providers, probe)) console.log(line);
}
```

`packages/cli/src/status/status.ts`: in the `--deep` branch replace

```ts
      const color = useColor(process.stdout.isTTY === true, process.env);
      const lines = formatDeepProviderLines(providers, color);
```

with

```ts
      const lines = formatDeepProviderLines(style, providers);
```

and drop `useColor` from the import.

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary src/status src/provider-commands`
Expected: PASS. Any test that asserted `id: openai` style lines now asserts the table or detail layout as above.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui/summary packages/cli/src/ui/index.ts packages/cli/src/provider-commands.ts packages/cli/src/status
git commit -m "feat(cli): print providers as a table with a detail view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Plugin list

**Files:**
- Modify: `packages/cli/src/ui/summary/summary.ts` (replace `formatPluginLines` with `formatPluginTable`; delete `fits`)
- Test: `packages/cli/src/ui/summary/summary.test.ts` (replace the `formatPluginLines` describe)
- Modify: `packages/cli/src/ui/summary/index.ts`, `packages/cli/src/ui/index.ts`
- Modify: `packages/cli/src/plugin-commands/plugin/remove.ts:6,41-61`

**Interfaces:**
- Consumes: Tasks 1–3 (`cli.ui.header_name`, `cli.ui.header_package`, `cli.provider.list.header_state`, `cli.plugin.state_failed`).
- Produces:
  - `type PluginListItem = { readonly label?: string; readonly packageName: string; readonly status: 'configured' | 'builtin' | 'not_installed' | 'failed'; readonly state: string; readonly description?: string }`
  - `formatPluginTable(style: Style, plugins: readonly PluginListItem[]): readonly string[]`

- [ ] **Step 1: Write the failing test**

Replace the `formatPluginLines` describe in `summary.test.ts`:

```ts
describe('formatPluginTable', () => {
  const base = { label: 'Name', packageName: 'pkg', status: 'configured', state: 'configured', description: 'desc' } as const;
  const rowFor = (lines: readonly string[], pkg: string): number => lines.findIndex((line) => line.includes(` ${pkg} `) || line.endsWith(` ${pkg}`));

  test('marks plugins by status and puts the description underneath', () => {
    const lines = formatPluginTable(plainStyle, [
      base,
      { ...base, packageName: 'built', status: 'builtin', state: 'built-in' },
      { ...base, packageName: 'missing', status: 'not_installed', state: 'not-installed' },
      { ...base, packageName: 'broken', status: 'failed', state: 'load failed: x' },
    ]);
    expect(lines[0]).toContain(m['cli.ui.header_package']().toLocaleUpperCase());
    expect(lines[rowFor(lines, 'pkg')]!.startsWith('● ')).toBe(true);
    expect(lines[rowFor(lines, 'built')]!.startsWith('● ')).toBe(true);
    expect(lines[rowFor(lines, 'missing')]!.startsWith('○ ')).toBe(true);
    const broken = rowFor(lines, 'broken');
    expect(lines[broken]!.startsWith('✗ ')).toBe(true);
    expect(lines[broken]).toContain(m['cli.plugin.state_failed']());
    expect(lines[broken + 1]).toBe('    load failed: x');
    expect(lines[rowFor(lines, 'pkg') + 1]).toBe('    desc');
  });

  test('keeps a CJK description whole on its own line', () => {
    const description = '字'.repeat(50);
    expect(formatPluginTable(plainStyle, [{ ...base, description }])).toContain(`    ${description}`);
  });

  test('shows a dash when a plugin has no display name', () => {
    const { label: _label, ...unnamed } = base;
    expect(formatPluginTable(plainStyle, [unnamed])[1]!.startsWith('● -  ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary/summary.test.ts -t formatPluginTable`
Expected: FAIL (`formatPluginTable` is not exported).

- [ ] **Step 3: Implement**

In `summary.ts`, replace `formatPluginLines` and delete `fits`:

```ts
export type PluginListItem = {
  readonly label?: string;
  readonly packageName: string;
  readonly status: 'configured' | 'builtin' | 'not_installed' | 'failed';
  readonly state: string;
  readonly description?: string;
};

const PLUGIN_MARKS = { configured: 'ok', builtin: 'ok', not_installed: 'off', failed: 'fail' } as const;

export function formatPluginTable(style: Style, plugins: readonly PluginListItem[]): readonly string[] {
  return formatTable(
    style,
    plugins.map((plugin) => ({
      mark: style.mark(PLUGIN_MARKS[plugin.status]),
      cells: [
        plugin.label ?? '-',
        style.strong(plugin.packageName),
        plugin.status === 'failed' ? style.danger(m['cli.plugin.state_failed']()) : plugin.state,
      ],
      notes: [
        ...(plugin.status === 'failed' ? [style.muted(plugin.state)] : []),
        ...(plugin.description === undefined ? [] : [style.muted(plugin.description)]),
      ],
    })),
    [m['cli.ui.header_name'](), m['cli.ui.header_package'](), m['cli.provider.list.header_state']()],
  );
}
```

Update `ui/summary/index.ts` and `ui/index.ts`: replace `formatPluginLines` with `formatPluginTable, type PluginListItem`.

In `packages/cli/src/plugin-commands/plugin/remove.ts`, change the import to `import { createStyle, formatPluginTable, type PluginListItem } from '../../ui';` and replace the `for (const packageName of names) { … }` loop with:

```ts
    const items: PluginListItem[] = names.map((packageName) => {
      const loaded = snapshot.plugins.get(packageName);
      let status: PluginListItem['status'] = 'not_installed';
      let state: string = m['cli.plugin.state_not_installed']();
      if (installed.has(packageName)) {
        status = 'configured';
        state = m['cli.plugin.state_configured']();
      }
      if (deps.builtInNames.has(packageName)) {
        status = 'builtin';
        state = m['cli.plugin.state_builtin']();
      }
      if (loaded?.state.status === 'failed') {
        status = 'failed';
        state = loaded.state.diagnostic.summary;
      }
      const label =
        loaded?.displayName === undefined ? undefined : resolveLocalizedText(loaded.displayName, getLocale());
      const description =
        loaded?.description === undefined ? undefined : resolveLocalizedText(loaded.description, getLocale());
      return {
        ...(label === undefined ? {} : { label }),
        packageName,
        status,
        state,
        ...(description === undefined ? {} : { description }),
      };
    });
    for (const line of formatPluginTable(createStyle(process.stdout), items)) deps.print(line);
```

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary src/plugin-commands`
Expected: PASS. A `pluginList` test that compared `formatPluginLines` output now finds the same package names and states inside table rows; update `toEqual` comparisons to `toContain` on the row that holds the package name.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ui packages/cli/src/plugin-commands/plugin/remove.ts packages/cli/src/plugin-commands
git commit -m "feat(cli): print plugins as a table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Agent list blocks

**Files:**
- Modify: `packages/cli/src/agent/output.ts` (list rendering; `registerAgentCommands` passes a style)
- Test: `packages/cli/src/agent/output.test.ts`

**Interfaces:**
- Consumes: `Style`, `plainStyle`, `createStyle` (Task 1); `Block`, `Field`, `formatBlocks`, `formatTable` (Task 2); `cli.agent.list.label_*`, `host_value`, `catalog_value`, `section_*` (Task 3).
- Produces: `renderAgentList(result: AgentListResult, json: boolean, style?: Style): string[]` (default `plainStyle`; JSON path unchanged).

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/src/agent/output.test.ts`:

```ts
test('text list prints one block per agent with aligned labels', () => {
  const lines = renderAgentList(completeListResult, false);
  expect(lines[0]).toBe('● opencode  managed');
  const columnOf = (text: string): number => {
    const line = lines.find((candidate) => candidate.includes(text))!;
    return Bun.stringWidth(line.slice(0, line.indexOf(text)));
  };
  expect(columnOf('1.17.10 (')).toBe(columnOf(OUTPUT_INSTALLATION));
  expect(lines).toContain('');
  expect(lines.some((line) => line.startsWith('○ codex  absent'))).toBe(true);
  expect(lines).toContain(m['cli.agent.list.section_control_plane']());
  expect(lines).toContain(m['cli.agent.list.section_authorizations']());
});

test('text list marks absent and unresolved agents', () => {
  const absent: AgentListResult = {
    ...completeListResult,
    targets: [{ ...completeListResult.targets[0]!, integration: 'absent' } as AgentListResult['targets'][number]],
  };
  expect(renderAgentList(absent, false)[0]!.startsWith('○ opencode')).toBe(true);
  const unresolved: AgentListResult = {
    ...completeListResult,
    targets: [
      {
        target: 'pi',
        host: { target: 'pi', detected: false, minimumVersion: '0.84.2', support: 'unknown' },
        integration: 'unresolved',
        reason: 'host_missing',
        authorization: 'not_checked',
        schemaCompatibility: 'not_checked',
      },
    ],
  };
  const lines = renderAgentList(unresolved, false);
  expect(lines[0]).toBe('▲ pi  unresolved');
  expect(lines.join('\n')).toContain('host_missing');
});
```

Keep `JSON list rendering is exactly one parseable line`, `text list rendering exposes every diagnostic field promised by list --check` and the Grok list test unchanged: they must still pass. In the `AGENT_KEYS` array delete every key that Task 10 removes and that appears there (`cli.agent.codex.list`, `cli.agent.codex.list_auth`, `cli.agent.list.target`, `cli.agent.list.unresolved`, `cli.agent.list.authorization`), and add `cli.agent.list.label_host`, `cli.agent.list.host_value` and `cli.agent.list.catalog_value` so the new copy is covered by the same five-locale check.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/agent/output.test.ts`
Expected: FAIL on the two new tests (old one-line rendering).

- [ ] **Step 3: Implement**

In `packages/cli/src/agent/output.ts`:

1. Imports: add

```ts
import { type Block, createStyle, type Field, formatBlocks, formatTable, plainStyle, type Style } from '../ui';
```

and add `AgentListTargetResult` to the type import from `./agent`.

2. Delete `renderCodexList` and `grokListLines`. Add:

```ts
const endpointMatch = (matches: boolean | undefined): string =>
  matches === undefined ? 'unknown' : matches ? 'match' : 'mismatch';

const hostField = (host: AgentListTargetResult['host']): Field => [
  m['cli.agent.list.label_host'](),
  m['cli.agent.list.host_value']({
    version: host.version ?? 'unknown',
    minimum: host.minimumVersion,
    support: host.support,
  }),
];

const accessFields = (target: AgentListTargetResult): Field[] => [
  [m['cli.agent.list.label_authorization'](), target.authorization],
  [m['cli.agent.list.label_schema'](), target.schemaCompatibility],
];

function targetMark(style: Style, target: AgentListTargetResult): string {
  if (target.integration === 'absent') return style.mark('off');
  const drifted =
    target.integration === 'unresolved' ||
    target.integration === 'conflict' ||
    target.host.support === 'unsupported' ||
    ('endpointMatches' in target && target.endpointMatches === false) ||
    (target.target === 'grok' && target.configuration !== 'current');
  return style.mark(drifted ? 'warn' : 'ok');
}

function grokNotes(style: Style, target: Extract<AgentListTargetResult, { target: 'grok' }>): string[] {
  if (target.integration === 'absent' || target.integration === 'unresolved') return [];
  const fields = target.fields.join(', ');
  if (target.configuration === 'modified')
    return [`${style.mark('warn')} ${m['cli.agent.configuration_modified']({ fields })}`];
  if (target.configuration === 'missing') return [`${style.mark('warn')} ${m['cli.agent.configuration_missing']()}`];
  if (target.configuration === 'recovery_required')
    return [`${style.mark('warn')} ${m['cli.agent.recovery_required']({ fields })}`];
  return [];
}

function targetBlock(style: Style, target: AgentListTargetResult): Block {
  const mark = targetMark(style, target);
  const title = `${style.strong(target.target)}  ${target.integration}`;
  if (target.target !== 'grok' && target.integration === 'unresolved') {
    return {
      mark,
      title,
      fields: [[m['cli.agent.list.label_reason'](), target.reason], hostField(target.host), ...accessFields(target)],
    };
  }
  const catalog = target.target === 'grok' ? m['cli.agent.host_managed_catalog']() : target.catalog;
  const lastSuccessfulAt = target.target === 'grok' ? '-' : (target.lastSuccessfulAt ?? '-');
  return {
    mark,
    title,
    fields: [
      hostField(target.host),
      [m['cli.agent.list.label_installation'](), target.marker?.installationId ?? '-'],
      [m['cli.agent.list.label_adapter'](), target.marker?.adapterVersion ?? '-'],
      [m['cli.agent.list.label_endpoint'](), `${target.marker?.endpoint ?? '-'} (${endpointMatch(target.endpointMatches)})`],
      [m['cli.agent.list.label_catalog'](), m['cli.agent.list.catalog_value']({ catalog, lastSuccessfulAt })],
      ...accessFields(target),
    ],
    notes: target.target === 'grok' ? grokNotes(style, target) : [],
  };
}

function codexBlock(style: Style, codex: CodexListResult): Block {
  const attention =
    codex.status === 'modified' ||
    codex.status === 'conflict' ||
    codex.connection === 'offline' ||
    codex.connection === 'unauthorized' ||
    codex.connection === 'invalid_response';
  const changedPaths = codex.changedPaths.length === 0 ? '-' : codex.changedPaths.map((path) => path.join('.')).join(', ');
  const fields: Field[] = [
    [m['cli.agent.list.label_config'](), codex.configPath],
    [m['cli.agent.list.label_provider'](), codex.providerId ?? '-'],
    [m['cli.agent.list.label_active_provider'](), codex.activeProviderId || '-'],
    [m['cli.agent.list.label_base_url'](), codex.baseUrl ?? '-'],
    [m['cli.agent.list.label_connection'](), codex.connection],
    [m['cli.agent.list.label_changed_paths'](), changedPaths],
  ];
  if (codex.authMode !== undefined) {
    fields.push(
      [m['cli.agent.list.label_auth_mode'](), codex.authMode],
      [m['cli.agent.list.label_installation'](), codex.installationId ?? '-'],
      [m['cli.agent.list.label_lifecycle'](), codex.lifecycle ?? '-'],
      [m['cli.agent.list.label_authorization'](), codex.authorization ?? 'not_checked'],
      [m['cli.agent.list.label_credential'](), codex.credentialStatus ?? '-'],
    );
  }
  return {
    mark: codex.status === 'absent' ? style.mark('off') : style.mark(attention ? 'warn' : 'ok'),
    title: `${style.strong('codex')}  ${codex.status}`,
    fields,
  };
}
```

TypeScript check for `targetBlock`: after the unresolved early return, `target` is either Grok (any integration) or a resolved plugin target, both of which have optional `marker` and `endpointMatches`; plugin targets have `catalog` and `lastSuccessfulAt`. If the compiler cannot narrow the union, split into `pluginBlock` / `grokBlock` with the same fields rather than adding casts.

3. Replace `renderAgentList` with:

```ts
export function renderAgentList(result: AgentListResult, json: boolean, style: Style = plainStyle): string[] {
  if (json) return [JSON.stringify(result)];
  const lines = formatBlocks(style, [
    ...result.targets.map((target) => targetBlock(style, target)),
    codexBlock(style, result.codex),
  ]);
  const control = [
    ...(result.server === 'not_checked' ? [] : [m['cli.agent.list.server']({ status: result.server })]),
    ...(result.deviceAuthorization === undefined || result.catalogSchemaVersions === undefined
      ? []
      : [
          m['cli.agent.list.capabilities']({
            deviceAuthorization: result.deviceAuthorization,
            catalogSchemaVersions:
              result.catalogSchemaVersions.length === 0 ? 'none' : result.catalogSchemaVersions.join(','),
          }),
        ]),
  ];
  if (control.length > 0) lines.push('', style.heading(m['cli.agent.list.section_control_plane']()), ...control);
  const authorizations = result.authorizations ?? [];
  if (authorizations.length > 0) {
    lines.push(
      '',
      style.heading(m['cli.agent.list.section_authorizations']()),
      ...formatTable(
        style,
        authorizations.map((item) => ({ cells: [item.installationId, item.target, item.authorization, item.local] })),
        [
          m['cli.agent.list.label_installation'](),
          m['cli.agent.list.label_target'](),
          m['cli.agent.list.label_authorization'](),
          m['cli.agent.list.label_local'](),
        ],
      ),
    );
  }
  return lines;
}
```

4. In `registerAgentCommands`, change the `list` action's emit to:

```ts
      emit(renderAgentList(await input.actions.list(normalized), normalized.json, createStyle(process.stdout)));
```

`output.ts` imports `../ui`, which does not import `agent/`, so there is no cycle. If the file passes 400 lines, move the list rendering (everything added in step 2 plus `renderAgentList`) into `packages/cli/src/agent/output/list.ts` with `output/index.ts` re-exporting, per the repo's splitting rule.

- [ ] **Step 4: Run tests**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/agent`
Expected: PASS, including the unchanged "exposes every diagnostic field" and JSON tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/agent
git commit -m "feat(cli): print agent list as detail blocks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Errors, update banner, completion lines

**Files:**
- Modify: `packages/cli/src/ui/summary/summary.ts` (add `formatErrorLines`), `ui/summary/index.ts`, `ui/index.ts`
- Test: `packages/cli/src/ui/summary/summary.test.ts`
- Modify: `packages/cli/src/main.ts:334` (error print)
- Modify: `packages/cli/src/update-notify/update-notify.ts` (banner) and its test
- Modify: `packages/cli/src/service/service.ts:245,255,262`, `upgrade/upgrade.ts:175,195,203`, `config-cmd/config-cmd.ts:40`, `dashboard/dashboard.ts:34,44`, `plugin-commands/plugin/deps.ts:93`, `agent/output.ts` (`renderAgentConfigure`, `renderCodexConfigure`, `renderAgentRemove`, `renderCodexRemove`, `renderAgentRevoke`)

**Interfaces:**
- Consumes: Tasks 1, 3 (`cli.update.banner`).
- Produces: `formatErrorLines(style: Style, message: string): readonly string[]` — first line `"✗ <line>"`, later lines indented two spaces.

- [ ] **Step 1: Write the failing tests**

Add to `summary.test.ts` (import `formatErrorLines`):

```ts
describe('formatErrorLines', () => {
  test('marks the first line and indents the rest', () => {
    expect(formatErrorLines(plainStyle, 'Server is not running\nStart it first')).toEqual([
      '✗ Server is not running',
      '  Start it first',
    ]);
  });
});
```

In `packages/cli/src/update-notify/update-notify.test.ts`, add `import { m } from '@aio-proxy/i18n';` and, in `prints a banner only when the persisted latest is newer`, replace `expect(lines.join('\n')).toContain('2.0.0');` with:

```ts
    expect(lines).toEqual([`▲ ${m['cli.update.banner']({ current: '1.0.0', latest: '2.0.0' })}  → aio-proxy upgrade`]);
```

(The test process has no TTY, so the banner is plain.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts src/ui/summary src/update-notify`
Expected: FAIL.

- [ ] **Step 3: Implement**

`summary.ts`:

```ts
export function formatErrorLines(style: Style, message: string): readonly string[] {
  const [first = '', ...rest] = message.split('\n');
  return [`${style.mark('fail')} ${first}`, ...rest.map((line) => `  ${line}`)];
}
```

Export it from `ui/summary/index.ts` and `ui/index.ts`.

`main.ts` (`main`'s catch block):

```ts
    if (formatted.message !== '') console.error(formatErrorLines(createStyle(process.stderr), formatted.message).join('\n'));
```

(add `formatErrorLines` to the `./ui` import).

`update-notify.ts`: add `import { createStyle } from '../ui';` and replace `print(m['cli.update.available']({ version: state.latest }));` with:

```ts
  const style = createStyle(process.stderr);
  print(
    `${style.mark('warn')} ${m['cli.update.banner']({ current, latest: state.latest })}  ${style.mark('hint')} ${style.muted('aio-proxy upgrade')}`,
  );
```

Completion lines — prefix the existing sentence, copy unchanged. In each file add `import { createStyle } from '<relative>/ui';` and use `const style = createStyle(process.stdout);` at the top of the function:

| File | Line(s) | New text |
| --- | --- | --- |
| `service/service.ts` | `cli.service.installed`, both `cli.service.uninstalled` | `` `${style.mark('ok')} ${m[...](...)}` `` |
| `upgrade/upgrade.ts` | `cli.upgrade.up_to_date` (both), `cli.upgrade.success` | same `ok` prefix |
| `config-cmd/config-cmd.ts` | `cli.config.valid` | `ok` prefix |
| `dashboard/dashboard.ts` | `cli.status.not_running` | `off` prefix |
| `dashboard/dashboard.ts` | `cli.dashboard.opened` | `ok` prefix |
| `plugin-commands/plugin/deps.ts` `reportLine` | `deps.print(message)` | `deps.print(\`${createStyle(process.stdout).mark('ok')} ${message}\`)` — only the stdout path; `session.finish(message)` stays unprefixed |

In `agent/output.ts`, add a `style: Style = plainStyle` last parameter to `renderAgentConfigure`, `renderCodexConfigure`, `renderAgentRemove`, `renderCodexRemove`, `renderAgentRevoke`, pass `createStyle(process.stdout)` from `registerAgentCommands`, and prefix only the first line:

- `renderAgentConfigure`: `newer` → `warn`, otherwise `ok`.
- `renderCodexConfigure`: `cancelled` results → `off`; `migration_blocked` → `warn`; otherwise `ok`.
- `renderAgentRemove` / `renderAgentRevoke`: `ok`.
- `renderCodexRemove`: `status === 'blocked'` → `warn`, otherwise `ok`.

- [ ] **Step 4: Run the CLI suite and fix exact-line assertions**

Run: `cd packages/cli && bun run test:unit`
Expected: failures only where a test compares one of the lines above with `toBe` / `toEqual`. Find them with:

```bash
grep -rnE "cli\.(service\.(installed|uninstalled)|upgrade\.(success|up_to_date)|config\.valid|dashboard\.opened|status\.not_running|plugin\.(added|configured|pruned|removed_secrets_(retained|purged))|agent\.(configure\.(result|newer)|remove\.success|revoke\.success|codex\.(configured|removed|cancelled|restore)))" packages/cli/src --include='*.test.ts'
```

Change each expected value to the prefixed form (e.g. `` `● ${m['cli.config.valid']({ path })}` ``). Do not weaken assertions to `toContain`. Re-run until PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src
git commit -m "feat(cli): mark errors, update banner and completion lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Remove superseded copy, changeset, full verification

**Files:**
- Modify: `packages/i18n/messages/*.json` (delete keys)
- Create: `.changeset/cli-visual-style.md`

- [ ] **Step 1: Confirm the old keys have no callers**

```bash
grep -rnE "cli\.(status\.running|run\.started|update\.available|doctor\.(config_path|server_reachable|server_unreachable|plugin_count)|agent\.list\.(target|unresolved|authorization)|agent\.codex\.list(_auth)?)['\"]" packages website desktop --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v /paraglide/
```

Expected: no output. (`cli.status.not_running` is still used by `dashboard` — it is not in this list.) If anything prints, fix that caller first.

- [ ] **Step 2: Delete the keys from all five locales**

Write this throwaway script to your scratch directory as `drop-messages.ts` and run it from the repo root with `bun <scratch>/drop-messages.ts`:

```ts
import { join } from 'node:path';

type Tree = { [key: string]: string | Tree };
const keys = [
  'cli.status.running',
  'cli.run.started',
  'cli.update.available',
  'cli.doctor.config_path',
  'cli.doctor.server_reachable',
  'cli.doctor.server_unreachable',
  'cli.doctor.plugin_count',
  'cli.agent.list.target',
  'cli.agent.list.unresolved',
  'cli.agent.list.authorization',
  'cli.agent.codex.list',
  'cli.agent.codex.list_auth',
];
for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko']) {
  const path = join(process.cwd(), 'packages/i18n/messages', `${locale}.json`);
  const data = (await Bun.file(path).json()) as Tree;
  for (const key of keys) {
    const parts = key.split('.');
    const leaf = parts.pop()!;
    const parent = parts.reduce<Tree>((node, part) => node[part] as Tree, data);
    if (typeof parent[leaf] !== 'string') throw new Error(`${locale}: ${key} missing`);
    delete parent[leaf];
  }
  await Bun.write(path, `${JSON.stringify(data, undefined, 2)}\n`);
}
```

Then:

```bash
bunx oxfmt packages/i18n/messages
cd packages/i18n && bunx paraglide-js compile --emit-ts-declarations && bun run test:unit
```

Expected: PASS.

- [ ] **Step 3: Write the changeset**

`.changeset/cli-visual-style.md`:

```md
---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/i18n': minor
---

The CLI has a new look. Help groups commands by purpose, `provider list` and `plugin list` print aligned tables, `agent list` and `provider list --filter <id>` print every field as a labeled block, and `doctor` is a checklist. Status uses one set of symbols (● ▲ ✗ ○) everywhere, with Dashboard teal for headings. Output stays plain when redirected or when `NO_COLOR` is set, and `--json` output is unchanged.
```

- [ ] **Step 4: Full verification**

Run from the repo root:

```bash
bun run preflight
```

Expected: oxlint (type-aware), oxfmt check and all unit tests PASS. Fix any lint finding in the touched files.

- [ ] **Step 5: Look at it in a real terminal**

```bash
cd packages/cli
bun src/main.ts -h
bun src/main.ts -h | cat
NO_COLOR=1 bun src/main.ts -h
bun src/main.ts provider -h
bun src/main.ts status
bun src/main.ts doctor
bun src/main.ts provider list
bun src/main.ts plugin list
bun src/main.ts agent list
TERM=xterm COLORTERM= bun src/main.ts doctor
```

Expected: colored grouped help on a TTY; no escape codes in the piped and `NO_COLOR` runs; `provider -h` without the version header or `Setup`; tables aligned; warnings yellow (not red) under `TERM=xterm`. Commands that need a running server print the not-running state with `○` / `✗` when it is down.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/messages .changeset/cli-visual-style.md
git commit -m "chore(cli): drop copy replaced by the visual style

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
