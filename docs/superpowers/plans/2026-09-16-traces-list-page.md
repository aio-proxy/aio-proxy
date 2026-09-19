# 调用链列表页改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 调用链列表页进入时不再自动轮询，表格上方加一张按时间分桶的成功/失败堆叠柱状图，图例即筛选器。

**Architecture:** 图表数据来自新增的 `GET /dashboard/api/traces/summary`，它复用 `GET /dashboard/api/traces` 的全部过滤参数，在 SQLite 里按时间桶 `group by` 聚合，绝不在 JS 里遍历行。列表和摘要共用一份 drizzle 过滤条件（本计划从 `trace-queries.ts` 抽出 `trace-filter.ts`），这样两者的过滤语义不可能漂移。前端图例点击写回 URL 上已有的 `otelStatusCode` 字段，不新开并行过滤链路。

**Tech Stack:** Bun / SQLite（drizzle + `bun:sqlite` 原生 query）· Hono + zod validator · React + TanStack Query/Router/Table · recharts + `@aio-proxy/ui/components/chart` · `@aio-proxy/i18n`（Paraglide）· 测试：core/server 用 `bun:test`，dashboard 用 `@rstest/core` + `@testing-library/react`

设计稿：`docs/superpowers/specs/2026-09-16-traces-page-redesign-design.md` 第一章。
静态 demo：`docs/superpowers/demos/traces-redesign/index.html`。

**范围**：只做设计稿第一章（列表页）。第二章（详情页的瀑布刻度尺、分位对比条、hop 选择器、抓包接口）是另一份计划 —— 它依赖日志文件扫描和新的两个接口，和列表页没有共享代码，硬塞进来会让这份计划无法单独验收。

## Global Constraints

- 所有命令在 worktree 根目录 `/Users/bytedance/Documents/self/aio-proxy/.claude/worktrees/sleepy-gauss-9a27fd` 下跑，不要 `cd` 到主仓库。
- 禁止裸 `git stash` / `git stash pop`（stash 栈跨 worktree 共享）。要暂存就打临时 WIP commit。
- 用户可见文案一律走 `packages/i18n/messages/*.json`，改完跑 `bun run i18n:compile`。`HTTP`、`Token`、`Provider`、模型 ID、协议名保持不翻译。五个 locale 文件全都要加：`en.json` `ja.json` `ko.json` `zh-Hans.json` `zh-Hant.json`。
- 组件用箭头函数 + `React.FC<XxxProps>`，props 用 `interface <ComponentName>Props`，一个 `.tsx` 一个组件，文件名 kebab-case。
- 模块目录只允许 `services` / `hooks` / `components` / `stores` / `templates` / `lib` 六个子目录，根下不放散文件。有 colocated 测试的模块用同名目录：`foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts`。
- 手写非测试实现文件上限 500 行，400 行就该考虑拆。
- 通用集合/对象工具优先 `es-toolkit`（窄导入 `es-toolkit/array` 等），不要手写。
- 状态色固定：成功 `var(--chart-success)`、失败 `var(--chart-error)`。失败永远是红色，不参与分类色轮转。这两个 token 需要在本计划里加进 `packages/ui/src/styles.css` 的 `:root`；明暗两模同值（`validate_palette.js` 对 light/dark 两个 surface 都过了六项检查），所以 `.dark` 不需要覆写。
- 服务端分页的既有约束不变：不加客户端排序、列显隐、当前页过滤。
- 完工判定：`bun run preflight`（oxlint + oxfmt check + 全部单测）通过。
- 本计划需要一个 changeset，frontmatter 同时列内部包和 `aio-proxy`（见 Task 8）。

---

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `packages/core/src/db/trace-store/trace-filters.ts` | 从 `trace-queries.ts` 抽出的 drizzle 过滤条件构造器，列表和摘要共用 |
| `packages/core/src/db/trace-store/trace-summary.ts` | 桶粒度推导 + SQL `group by` 聚合，返回桶数组与总计。与 `trace-queries.ts` 平级（理由见 Task 4 开头） |
| `packages/dashboard/src/modules/traces/components/traces-toolbar/index.ts` | 只有 export |
| `packages/dashboard/src/modules/traces/components/traces-toolbar/traces-toolbar.tsx` | 工具栏：筛选 / 时间范围 / 实时 |
| `packages/dashboard/src/modules/traces/components/traces-toolbar/traces-toolbar.test.tsx` | 三个控件的行为测试 |
| `packages/dashboard/src/modules/traces/components/traces-events/index.ts` | 只有 export |
| `packages/dashboard/src/modules/traces/components/traces-events/traces-events.tsx` | Events 卡片：折叠壳 + 图例 + 图表 |
| `packages/dashboard/src/modules/traces/components/traces-events/traces-events.test.tsx` | 图例即筛选、折叠持久化、桶点击收窄时间范围 |
| `packages/dashboard/src/modules/traces/components/traces-events-chart/index.ts` | 只有 export |
| `packages/dashboard/src/modules/traces/components/traces-events-chart/traces-events-chart.tsx` | recharts 堆叠柱状图本体 |
| `packages/dashboard/src/modules/traces/hooks/use-trace-summary-query.ts` | 摘要的 React Query hook |
| `packages/dashboard/src/modules/traces/stores/traces-events-collapsed.ts` | 折叠偏好读写 localStorage |

**移动**（`git mv`，内容不改）

| 从 | 到 | 原因 |
|---|---|---|
| `packages/dashboard/src/modules/traces/components/traces-filters/date-range/` | `packages/dashboard/src/modules/traces/lib/trace-date-range/` | 时间范围控件从抽屉移到工具栏后，`traces-toolbar` 也要用这几个函数。`traces-filters/date-range/` 是 `traces-filters` 的私有子模块，不允许跨目录 import，所以整个目录（5 个文件）提到模块级 `lib/` 下 |

**修改**

| 文件 | 改动 |
|---|---|
| `packages/types/src/trace.ts` | 加 `DashboardTraceSummaryBucketSchema` / `DashboardTraceSummaryResponseSchema` 及其类型 |
| `packages/core/src/db/trace-store/trace-queries.ts` | `list()` 改用 `trace-filters.ts` |
| `packages/core/src/db/trace-store/types.ts` | 加 `TracesSummaryQuery` 与 `TraceStore.summary` |
| `packages/core/src/db/trace-store/trace-store.ts` | 接线 `summary` |
| `packages/core/src/db/trace-store/index.ts` | 导出 `TracesSummaryQuery` 类型 |
| `packages/core/src/db/trace-store/trace-store.test.ts` | 加 `summary()` 的行为测试 |
| `packages/server/src/dashboard-routes/traces/traces.ts` | 抽出共享 query schema，加 `GET /summary` |
| `packages/server/src/dashboard-routes/traces/traces.test.ts` | 加 `/summary` 的路由测试 |
| `packages/ui/src/styles.css` | `:root` 加 `--chart-success` / `--chart-error`，`@theme inline` 加对应的 `--color-*` 映射 |
| `packages/dashboard/src/lib/query-keys.ts` | 加 `tracesSummary` |
| `packages/dashboard/src/modules/traces/services/traces-service/traces-service.ts` | 加 `traceSummaryQueryOptions` / `getTraceSummary` |
| `packages/dashboard/src/modules/traces/components/traces-filters/traces-filters.tsx` | 删掉 `range` 折叠段（时间范围搬去工具栏）；`Sidebar` 加 `id="traces-filters"` |
| `packages/dashboard/src/modules/traces/components/traces-filters/traces-filters.test.tsx` | 抽屉里不再有时间范围的断言 |
| `packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx` | `状态` 列移到 `HTTP` 之后 |
| `packages/dashboard/src/modules/traces/components/traces-table/traces-table.test.tsx` | 更新受列序影响的下标断言 |
| `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.tsx` | `autoRefresh` 默认 false；工具栏三控件；挂 Events 卡片 |
| `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx` | 默认不轮询、工具栏、Events 卡片的断言 |
| `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json` | 新增 `dashboard.traces.*` 文案 |

**任务边界**：Task 1–2 是不依赖新接口的纯前端小改，能单独上线；Task 3–6 是自底向上的接口链路（types → core → server → dashboard service）；Task 7 是图表 UI；Task 8 收口。

---

## Task 1: 进入不轮询 + 工具栏

抽屉底部的自动刷新开关保持原样不动 —— 那是本计划里唯一一处刻意的重复控件（工具栏是主入口，抽屉是「已经打开抽屉时顺手能改」）。两处绑同一个 `autoRefresh` state。

**Files:**
- Move: `packages/dashboard/src/modules/traces/components/traces-filters/date-range/` → `packages/dashboard/src/modules/traces/lib/trace-date-range/`
- Create: `packages/dashboard/src/modules/traces/components/traces-toolbar/index.ts`
- Create: `packages/dashboard/src/modules/traces/components/traces-toolbar/traces-toolbar.tsx`
- Create: `packages/dashboard/src/modules/traces/components/traces-toolbar/traces-toolbar.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-filters/traces-filters.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-filters/traces-filters.test.tsx:22`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.tsx:45,116-131`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx:259,269`
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`

**Interfaces:**
- Consumes: `TraceSearch` / `withTraceFilters` from `../../lib/trace-search`；`toPickerRange` / `toQueryRange` / `createTraceDateTimeRangePresets` from `../../lib/trace-date-range`；`useSidebar` / `SidebarTrigger` from `@aio-proxy/ui/components/sidebar`（`useSidebar()` 返回 `{ state, open, setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar }`）。
- Produces: `TracesToolbar: React.FC<TracesToolbarProps>`，`TracesToolbarProps = { search: TraceSearch; autoRefresh: boolean; onChange: (search: TraceSearch) => void; onAutoRefresh: (value: boolean) => void }`。Task 7 会在 `traces-page.tsx` 里把 Events 卡片挂在这个工具栏下面，不改工具栏本身。

- [ ] **Step 1: 移动 date-range 目录**

`traces-filters/date-range/` 是 `traces-filters` 的私有子模块。工具栏要用它，就必须先提到模块级 `lib/` 下（CLAUDE.md：私有模块不得从 `foo/` 外部 import）。目录里 5 个文件整体搬，内容一个字不改：

```bash
git mv packages/dashboard/src/modules/traces/components/traces-filters/date-range packages/dashboard/src/modules/traces/lib/trace-date-range
```

搬完只有一处 import 需要改 —— `traces-filters.tsx` 最后一行 import：

```ts
// 删掉
import { createTraceDateTimeRangePresets, toPickerRange, toQueryRange } from './date-range';
// 换成（Step 3 会把这行连同时间范围一起删干净，这里先让它编译过）
import { createTraceDateTimeRangePresets, toPickerRange, toQueryRange } from '../../lib/trace-date-range';
```

- [ ] **Step 2: 加 i18n 文案**

`packages/i18n/messages/*.json` 是嵌套 JSON，键挂在 `dashboard.traces` 对象下。五个 locale 各加两个键（`events` 留给 Task 7，这里只加工具栏要的）：

| 文件 | `live` | `live_off` |
|---|---|---|
| `en.json` | `"Live"` | `"Live updates paused"` |
| `ja.json` | `"リアルタイム"` | `"リアルタイム更新は停止中"` |
| `ko.json` | `"실시간"` | `"실시간 업데이트 일시 중지됨"` |
| `zh-Hans.json` | `"实时"` | `"实时刷新已暂停"` |
| `zh-Hant.json` | `"即時"` | `"即時重新整理已暫停"` |

`live` 是按钮上的可见文案，`live_off` 只做关闭态的 `title`，让「为什么没在动」有解释。加完跑：

```bash
bun run i18n:compile
```

- [ ] **Step 3: 从抽屉里删掉时间范围段**

改 `packages/dashboard/src/modules/traces/components/traces-filters/traces-filters.tsx`：

1. 删掉整个 `<AccordionItem value="range">…</AccordionItem>` 块（现 83–105 行）。
2. `<Accordion multiple defaultValue={['range']} …>` → `defaultValue={['request']}`。
3. 删掉现 54–55 行的 `const now` / `const retentionStart`（只有时间范围用）。
4. 删掉 `schema` 里的 `dateRange: z.object({ from: z.date(), to: z.date() }),`、`defaultValues` 里的 `dateRange: toPickerRange(search),`、`useEffect` 里的 `form.setFieldValue('dateRange', …)` 那行，以及随之失效的 `const { startedAfter, startedBefore, … } = search;` 里的 `startedAfter, startedBefore` 两项和 `useEffect` 依赖数组里的同名两项。
5. 删掉 Step 1 刚改的 `../../lib/trace-date-range` import 和 `import { DateTimeRangePicker } from '@/components/date-time-range-picker';`、`import { endOfDay, startOfDay } from 'date-fns';`、`import { Field, FieldLabel }` 里的 `Field`（`FieldLabel` 还在用，`Field` 也还在别处用 —— 删之前用 `grep -c` 确认，只删真的没人用的）。
6. `<Sidebar className="absolute! inset-y-0! h-full! border-r" …>` 加 `id="traces-filters"`。桌面端 `Sidebar` 把 `...props` 摊在 `data-slot="sidebar-container"` 的 div 上，所以这个 id 会真的落进 DOM，工具栏的 `aria-controls` 才指得到。

- [ ] **Step 4: 改抽屉的测试**

`traces-filters.test.tsx:22` 现在断言时间范围有两个按钮（Accordion trigger + picker trigger，两者共用 `dashboard.date_time_range_picker.title` = "Time range" 这个名字）。抽屉里不该再有任何一个：

```ts
// 删掉
expect(screen.getAllByRole('button', { name: /Time range|时间范围/u })).toHaveLength(2);
// 换成
expect(screen.queryByRole('button', { name: /Time range|时间范围/u })).toBeNull();
```

- [ ] **Step 5: 跑抽屉测试，确认通过**

dashboard 的单测用 rstest，从 `packages/dashboard` 目录下跑，位置参数就是路径过滤：

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/components/traces-filters
```

Expected: PASS（时间范围已经不在抽屉里了）

- [ ] **Step 6: 写工具栏的失败测试**

`packages/dashboard/src/modules/traces/components/traces-toolbar/traces-toolbar.test.tsx`：

```tsx
import { SidebarProvider } from '@aio-proxy/ui/components/sidebar';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { TracesToolbar } from './traces-toolbar';

const renderToolbar = (overrides: Partial<React.ComponentProps<typeof TracesToolbar>> = {}) => {
  const props = {
    search: createDefaultTraceSearch(),
    autoRefresh: false,
    onChange: rs.fn(),
    onAutoRefresh: rs.fn(),
    ...overrides,
  };
  render(
    <SidebarProvider>
      <TracesToolbar {...props} />
    </SidebarProvider>,
  );
  return props;
};

describe('TracesToolbar', () => {
  test('points the filters trigger at the filter drawer', () => {
    renderToolbar();

    const trigger = screen.getByRole('button', { name: /Filters|筛选/u });
    expect(trigger).toHaveAttribute('data-sidebar', 'trigger');
    expect(trigger).toHaveAttribute('aria-controls', 'traces-filters');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('exposes the time range next to the filters trigger', () => {
    renderToolbar();

    expect(screen.getByRole('button', { name: /Time range|时间范围/u })).toBeTruthy();
  });

  test('toggles live updates and reports the pressed state', () => {
    const { onAutoRefresh } = renderToolbar({ autoRefresh: false });

    const live = screen.getByRole('button', { name: /Live|实时/u });
    expect(live).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(live);

    expect(onAutoRefresh).toHaveBeenCalledWith(true);
  });

  test('hides live updates on a paginated page', () => {
    renderToolbar({ search: { ...createDefaultTraceSearch(), pageToken: 'older-token' } });

    expect(screen.queryByRole('button', { name: /Live|实时/u })).toBeNull();
  });
});
```

最后一个用例不是凑数：`tracesQueryOptions` 里 `refetchInterval` 已经被 `search.pageToken === undefined` 门住了，翻到第二页时轮询本来就不生效。留一个开着但没用的按钮比没有按钮更糟。抽屉底部的开关是同样的门（`traces-filters.tsx` 现 198 行），语义一致。

- [ ] **Step 7: 跑测试，确认失败**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/components/traces-toolbar
```

Expected: FAIL，`Failed to resolve import "./traces-toolbar"`

- [ ] **Step 8: 写工具栏组件**

`packages/dashboard/src/modules/traces/components/traces-toolbar/traces-toolbar.tsx`：

```tsx
import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { SidebarTrigger, useSidebar } from '@aio-proxy/ui/components/sidebar';
import { cn } from '@aio-proxy/ui/lib/utils';
import { endOfDay, startOfDay } from 'date-fns';

import { DateTimeRangePicker } from '@/components/date-time-range-picker';

import { createTraceDateTimeRangePresets, toPickerRange, toQueryRange } from '../../lib/trace-date-range';
import { type TraceSearch, withTraceFilters } from '../../lib/trace-search';

interface TracesToolbarProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly onChange: (search: TraceSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
}

// 调用链保留 45 天，选到更早的时间只会得到空表。
const RETENTION_DAYS = 45;

export const TracesToolbar: React.FC<TracesToolbarProps> = ({ search, autoRefresh, onChange, onAutoRefresh }) => {
  const { open, isMobile, openMobile } = useSidebar();
  const now = new Date();
  const retentionStart = startOfDay(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger
        aria-label={m['dashboard.traces.filters']()}
        aria-controls="traces-filters"
        aria-expanded={isMobile ? openMobile : open}
      />
      <DateTimeRangePicker
        value={toPickerRange(search)}
        presets={createTraceDateTimeRangePresets()}
        min={retentionStart}
        max={endOfDay(now)}
        onChange={(value) => onChange(withTraceFilters(search, toQueryRange(value)))}
      />
      <div className="flex-1" />
      {search.pageToken === undefined && (
        <Button
          type="button"
          size="sm"
          variant={autoRefresh ? 'secondary' : 'outline'}
          aria-pressed={autoRefresh}
          title={autoRefresh ? undefined : m['dashboard.traces.live_off']()}
          onClick={() => onAutoRefresh(!autoRefresh)}
        >
          <span className={cn('size-1.5 rounded-full bg-current', autoRefresh && 'animate-pulse')} />
          {m['dashboard.traces.live']()}
        </Button>
      )}
    </div>
  );
};
```

`aria-expanded` 要看端：桌面用 `open`，移动端 `Sidebar` 走 Sheet，状态在 `openMobile` 上。

`packages/dashboard/src/modules/traces/components/traces-toolbar/index.ts`：

```ts
export * from './traces-toolbar';
```

- [ ] **Step 9: 跑测试，确认通过**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/components/traces-toolbar
```

Expected: PASS（4 个用例）

- [ ] **Step 10: 改页面的测试断言**

`traces-page.test.tsx` 现在有两处断言 `useTracesQuery` 收到 `autoRefresh === true`（259、269 行）：

```ts
// 259 行
expect(mocks.querySearch).toHaveBeenLastCalledWith(initialSearch, true);
// 换成
expect(mocks.querySearch).toHaveBeenLastCalledWith(initialSearch, false);

// 269 行
expect(mocks.querySearch).toHaveBeenLastCalledWith(expect.objectContaining({ traceId }), true);
// 换成
expect(mocks.querySearch).toHaveBeenLastCalledWith(expect.objectContaining({ traceId }), false);
```

再加一个用例，把「进入不轮询、点了实时才轮询」钉住。放在 `describe('traces page')` 里：

```tsx
test('does not poll until live updates are switched on', () => {
  const search = { ...createDefaultTraceSearch(), pageSize: 20 as const };
  render(<TracesPage search={search} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);

  expect(mocks.querySearch).toHaveBeenLastCalledWith(search, false);

  fireEvent.click(screen.getByRole('button', { name: /Live|实时/u }));

  expect(mocks.querySearch).toHaveBeenLastCalledWith(search, true);
});
```

- [ ] **Step 11: 跑测试，确认失败**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/templates/traces-page
```

Expected: FAIL — 新用例报找不到 `Live|实时` 按钮，两处 `false` 断言报收到的是 `true`

- [ ] **Step 12: 改页面**

`traces-page.tsx` 两处改动。第一处，45 行：

```tsx
// 进入即轮询会让人一直盯着一张自己在动的表，看不清刚发生了什么。默认关。
const [autoRefresh, setAutoRefresh] = useState(false);
```

第二处，用 `TracesToolbar` 替掉现 116–118 行那个只装了一个 trigger 的 `h-12` div：

```tsx
// 删掉
<div className="flex h-12 shrink-0 items-center border-b px-3">
  <SidebarTrigger aria-label={m['dashboard.traces.filters']()} />
</div>
// 换成
<TracesToolbar
  search={search}
  autoRefresh={autoRefresh}
  onChange={onSearchChange}
  onAutoRefresh={setAutoRefresh}
/>
```

import 相应加减：

```tsx
// 删掉 SidebarTrigger（其余两个还在用）
import { SidebarInset, SidebarProvider } from '@aio-proxy/ui/components/sidebar';
// 加
import { TracesToolbar } from '../../components/traces-toolbar';
```

`onSearchChange` 的签名是 `(search, options?) => void`，`TracesToolbarProps.onChange` 是 `(search) => void` —— 多出来的可选参数不影响赋值，直接传。

- [ ] **Step 13: 跑测试，确认通过**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces
```

Expected: PASS。特别确认这两个既有用例还活着 —— 它们保证工具栏那个 `SidebarTrigger` 是全页唯一的筛选入口：
- `uses the shared sidebar trigger to expand desktop filters`（用 `getByRole('button', { name: /Filters|筛选/u })`，单数形式，多一个同名按钮就会抛 multiple elements）
- `opens the same filters in a mobile Sheet`

- [ ] **Step 14: 提交**

```bash
git add -A packages/dashboard/src/modules/traces packages/i18n
git commit -m "feat(dashboard): 调用链列表页默认不轮询并新增工具栏"
```

---

## Task 2: 状态列移到 HTTP 之后

十列全保留，只挪一列的位置，让「结果」相关的三列（`HTTP` / `状态` / `延迟`）挨在一起。挪列会让所有按下标取 `cell` 的断言整体左移一位，所以这一步的活基本都在改测试。

**Files:**
- Modify: `packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-table/traces-table.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx:135,141`

**Interfaces:**
- Consumes: Task 1 的产物一个都不用，这一步和 Task 1 互不依赖，谁先做都行。
- Produces: 列序变为 `startedAt` / `traceId` / `inboundProtocol` / `requestedModelId` / `finalProviderId` / `finalHttpStatus` / `requestStatus` / `latency` / `tokens` / `cost`。后续任务不依赖列序。

- [ ] **Step 1: 改列序断言（先让测试失败）**

`traces-table.test.tsx` 里有一处完整的表头顺序断言。把 `Status|状态` 那一项从第三位挪到 `HTTP status` 之后：

```ts
const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
expect(headers).toEqual([
  expect.stringMatching(/Started|开始/u),
  'Trace ID',
  expect.stringMatching(/Protocol|协议/u),
  expect.stringMatching(/Model|模型/u),
  expect.stringMatching(/Provider ID/u),
  expect.stringMatching(/HTTP status|HTTP 状态/u),
  expect.stringMatching(/Status|状态/u),
  expect.stringMatching(/Latency|延迟/u),
  expect.stringMatching(/Tokens|Token/u),
  expect.stringMatching(/cost|成本/iu),
]);
```

同一文件里三处按下标取单元格的断言各减一：`cells[3]`（协议）→ `cells[2]`（60–61 行），`cells[4]`（模型）→ `cells[3]`（68 行和 86 行）。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/components/traces-table
```

Expected: FAIL，表头数组第 3 项收到的是 `Status` 而期望 `Protocol`

- [ ] **Step 3: 挪列**

`traces-table.tsx` 里把 `requestStatus` 那个列对象整体剪下来，粘到 `finalHttpStatus` 列对象之后。列定义数组里的相对顺序就是渲染顺序，不改任何一个列对象的内容，`accessorKey` / `header` / `cell` 全都不动。

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/components/traces-table
```

Expected: PASS

- [ ] **Step 5: 改页面测试里受下标影响的断言**

`traces-page.test.tsx` 也按下标取单元格，同样各减一：

```ts
// 135 行附近：模型列
const modelCell = within(screen.getByRole('button', { name: new RegExp(terminalTrace.traceId, 'u') })).getAllByRole(
  'cell',
)[3];

// 141 行：Provider ID 列
expect(within(terminalCells[4]).getByText(longProviderId)).toHaveClass('max-w-16', 'truncate');
```

挪动只影响下标 2–6，`latency` 及其右边的列都不动 —— 142–148 行的 `terminalCells[8]`（Token）、153 行的 `[7]`（延迟）原样不动。

对照挪动前后的下标表，改的时候按这张表核：

| 列 | 挪动前 | 挪动后 |
|---|---|---|
| `startedAt` | 0 | 0 |
| `traceId` | 1 | 1 |
| `requestStatus` | 2 | 6 |
| `inboundProtocol` | 3 | 2 |
| `requestedModelId` | 4 | 3 |
| `finalProviderId` | 5 | 4 |
| `finalHttpStatus` | 6 | 5 |
| `latency` | 7 | 7 |
| `tokens` | 8 | 8 |
| `cost` | 9 | 9 |

- [ ] **Step 6: 跑整个 traces 模块的测试**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces
```

Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add packages/dashboard/src/modules/traces
git commit -m "refactor(dashboard): 调用链表格状态列移到 HTTP 之后"
```

---

## Task 3: 摘要响应的 schema

图表要的聚合结果先在 `@aio-proxy/types` 里定形，core 和 server 都对着它写。

命名上要留神：这个包里已经有一个 `DashboardTraceSummarySchema`，那是**一行调用链**的摘要（列表项）。本任务加的 `DashboardTraceSummaryResponseSchema` 是**按时间分桶的聚合**。两者同名前缀、完全不同的东西，写注释说清楚，别让下一个人在这上面栽跟头。

**Files:**
- Modify: `packages/types/src/trace.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `DashboardTraceSummaryBucketSizeSchema: z.ZodEnum<['1m', '5m', '30m', '1h', '1d']>`，类型 `DashboardTraceSummaryBucketSize`
  - `DashboardTraceSummaryBucketSchema`，输出 `{ at: string; success: number; error: number }`，类型 `DashboardTraceSummaryBucket`
  - `DashboardTraceSummaryResponseSchema`，输出 `{ bucket: DashboardTraceSummaryBucketSize; buckets: DashboardTraceSummaryBucket[]; totals: { success: number; error: number } }`，类型 `DashboardTraceSummaryResponse`
  - Task 4 用 `DashboardTraceSummaryBucketSize` 做桶粒度推导函数的返回类型，用 `DashboardTraceSummaryResponse` 做 `summary()` 的返回类型；Task 5 的路由直接返回这个对象；Task 7 的图表按 `buckets` / `totals` 取数。
  - 注意 `bucket` 是**响应字段，不是请求参数**。粒度由时间跨度在 core 里推导（见 Task 4），客户端传不了 —— 少一个参数就少一处「客户端传 1m、跨度 45 天」的组合要防。

- [ ] **Step 1: 加 schema**

在 `packages/types/src/trace.ts` 的 `DashboardTraceDetailSchema` 之后、类型导出之前插入：

```ts
export const DashboardTraceSummaryBucketSizeSchema = z.enum(['1m', '5m', '30m', '1h', '1d']);

/**
 * 一个时间桶里的成功/失败数。注意与 `DashboardTraceSummarySchema` 区分：
 * 那个是一行调用链的摘要，这个是 `GET /dashboard/api/traces/summary` 的聚合结果。
 *
 * `success` 只数 OTel `OK`，`error` 只数 `ERROR`。还在跑的调用链是 `UNSET`，
 * 两边都不计 —— 图上少掉的那一点就是「还没有结果」，不该被算成成功。
 */
export const DashboardTraceSummaryBucketSchema = z
  .object({
    at: z.iso.datetime(),
    success: z.number().int().min(0),
    error: z.number().int().min(0),
  })
  .strict();

export const DashboardTraceSummaryResponseSchema = z
  .object({
    bucket: DashboardTraceSummaryBucketSizeSchema,
    buckets: z.array(DashboardTraceSummaryBucketSchema),
    totals: z.object({ success: z.number().int().min(0), error: z.number().int().min(0) }).strict(),
  })
  .strict();
```

在文件末尾的类型导出区加：

```ts
export type DashboardTraceSummaryBucketSize = z.output<typeof DashboardTraceSummaryBucketSizeSchema>;
export type DashboardTraceSummaryBucket = z.output<typeof DashboardTraceSummaryBucketSchema>;
export type DashboardTraceSummaryResponse = z.output<typeof DashboardTraceSummaryResponseSchema>;
```

- [ ] **Step 2: 确认类型能编译**

```bash
bun run check
```

Expected: 通过。这一步不加测试 —— schema 本身是声明，没有行为可测；它的约束会在 Task 4 和 Task 5 的测试里被真实数据打到。

- [ ] **Step 3: 提交**

```bash
git add packages/types/src/trace.ts
git commit -m "feat(types): 加调用链摘要聚合的响应 schema"
```

---

## Task 4: core 里的分桶聚合

图表要的是「这段时间里每个桶成功几条、失败几条」。这个数不能靠翻页在前端累加 —— 一页只有 50 行，图上却要覆盖整个时间范围。所以在 `TraceStore` 上加一个 `summary()`，一条 `group by` 出结果。

**放哪儿**：设计稿写的是放 `trace-store/overview/`，理由是「跟 `activity.ts` 一样直接走 SQL 分组」。这里只采纳后半句。`overview/` 整个目录服务的是概览页（`daily-rows.ts` / `diagnostics.ts` / `span-rows.ts` 都是概览页的取数），把调用链页的聚合塞进去会让两个页面的取数缠在一起。本任务新建平级的 `trace-summary.ts`，和 `trace-queries.ts` 并列 —— 同一张表、同一套过滤条件，就该挨着放。

**不走 `activity.ts` 的裸 SQL 通道**（`$client.query(...)`）。那条通道是为了流式 `iterate()` 才存在的；这里要复用 `list()` 已经写好的十几个过滤条件，用 drizzle 的 `sql` 模板拼 `select` 才能把那个共享的过滤数组直接塞进 `where`。手写 SQL 就得把过滤条件再抄一遍，两份迟早对不上。

**Files:**
- Create: `packages/core/src/db/trace-store/trace-filters.ts`
- Create: `packages/core/src/db/trace-store/trace-summary.ts`
- Modify: `packages/core/src/db/trace-store/trace-queries.ts`
- Modify: `packages/core/src/db/trace-store/types.ts`
- Modify: `packages/core/src/db/trace-store/trace-store.ts`
- Modify: `packages/core/src/db/trace-store/index.ts`
- Modify: `packages/core/src/db/trace-store/trace-store.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `DashboardTraceSummaryBucketSize` / `DashboardTraceSummaryResponse`；既有的 `traceSpan` schema（`../schema`）。
- Produces:
  - `trace-filters.ts` 导出 `TraceFilters = Omit<TracesQuery, 'pageSize' | 'cursor'>` 和 `traceFilterConditions(filters: TraceFilters): (SQL | undefined)[]`
  - `types.ts` 导出 `TracesSummaryQuery`：`Omit<TraceFilters, 'startedAfter' | 'startedBefore'> & { readonly startedAfter: Date; readonly startedBefore: Date }`（时间范围在这里是必填 —— 桶要对齐到范围起点，见 Step 3）
  - `TraceStore` 多一个方法：`readonly summary: (query: TracesSummaryQuery) => DashboardTraceSummaryResponse`
  - `trace-store/index.ts` 追加导出类型 `TracesSummaryQuery`
  - Task 5 的路由拿 `traceStore.summary(query)` 的返回值直接当响应体。

- [ ] **Step 1: 抽出共享的过滤条件**

`list()` 里那一大坨 `query.xxx === undefined ? undefined : eq(...)` 要被 `summary()` 复用。原样搬到新文件 `packages/core/src/db/trace-store/trace-filters.ts`，一个条件都不改：

```ts
import { eq, gte, lte, type SQL } from 'drizzle-orm';

import { traceSpan } from '../schema';
import type { TracesQuery } from './types';

export type TraceFilters = Omit<TracesQuery, 'pageSize' | 'cursor'>;

export function traceFilterConditions(filters: TraceFilters): (SQL | undefined)[] {
  return [
    filters.startedAfter === undefined ? undefined : gte(traceSpan.startedAt, filters.startedAfter),
    filters.startedBefore === undefined ? undefined : lte(traceSpan.startedAt, filters.startedBefore),
    filters.traceId === undefined ? undefined : eq(traceSpan.traceId, filters.traceId),
    filters.requestId === undefined ? undefined : eq(traceSpan.requestId, filters.requestId),
    filters.sessionSource === undefined ? undefined : eq(traceSpan.sessionSource, filters.sessionSource),
    filters.sessionId === undefined ? undefined : eq(traceSpan.sessionId, filters.sessionId),
    filters.otelStatusCode === undefined
      ? undefined
      : eq(traceSpan.statusCode, statusCodeFromOtel(filters.otelStatusCode)),
    filters.terminationReason === undefined ? undefined : eq(traceSpan.terminationReason, filters.terminationReason),
    filters.inboundProtocol === undefined ? undefined : eq(traceSpan.inboundProtocol, filters.inboundProtocol),
    filters.requestedModelId === undefined ? undefined : eq(traceSpan.requestedModelId, filters.requestedModelId),
    filters.finalProviderId === undefined ? undefined : eq(traceSpan.finalProviderId, filters.finalProviderId),
    filters.finalModelId === undefined ? undefined : eq(traceSpan.finalModelId, filters.finalModelId),
    filters.finalHttpStatus === undefined ? undefined : eq(traceSpan.finalHttpStatus, filters.finalHttpStatus),
  ];
}

export function statusCodeFromOtel(otel: 'UNSET' | 'OK' | 'ERROR'): number {
  if (otel === 'OK') return 1;
  if (otel === 'ERROR') return 2;
  return 0;
}
```

`trace-queries.ts` 那边：删掉文件末尾的 `statusCodeFromOtel`，删掉那十三行条件，`filter` 变成

```ts
const filter = and(isNull(traceSpan.parentSpanId), cursorFilter, ...traceFilterConditions(query));
```

import 相应调整：`gte` / `lte` 不再用（`gt` / `lt` 还在给游标用），加 `import { traceFilterConditions } from './trace-filters';`。

- [ ] **Step 2: 跑既有测试，确认重构没改行为**

```bash
cd packages/core && bun test src/db/trace-store
```

Expected: PASS。这一步是纯搬家，`list()` 的所有过滤用例应该原封不动地过。

- [ ] **Step 3: 写失败测试**

聚合走 `TraceStore`，测试就跟 `list` 一样加在 `packages/core/src/db/trace-store/trace-store.test.ts` 里。在 `describe('trace store recover, list, and prune')` 之后追加一个新的 `describe`：

```ts
const seedTrace = (store: TraceStore, traceId: string, startedAt: string, statusCode: number): void => {
  const spanId = traceId.slice(0, 16);
  const at = new Date(startedAt);
  store.startRoot(rootStart({ traceId, spanId, requestId: `req-${traceId.slice(0, 4)}`, startedAt: at }));
  // statusCode 0 是 UNSET —— 只 startRoot 不 complete，就是一条还在跑的调用链
  if (statusCode === 0) return;
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt: at, endedAt: new Date(at.getTime() + 100), statusCode })],
      summary: { finalProviderId: 'provider-b', finalModelId: 'model-b', finalHttpStatus: statusCode === 2 ? 500 : 200 },
    }),
  );
};

describe('trace store summary', () => {
  test('buckets success and error counts from the range start and leaves running traces out', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      seedTrace(store, '1'.repeat(32), '2026-07-24T09:00:10.000Z', 1);
      seedTrace(store, '2'.repeat(32), '2026-07-24T09:00:40.000Z', 1);
      seedTrace(store, '3'.repeat(32), '2026-07-24T09:00:50.000Z', 2);
      seedTrace(store, '4'.repeat(32), '2026-07-24T09:30:05.000Z', 2);
      seedTrace(store, '5'.repeat(32), '2026-07-24T09:45:00.000Z', 0);

      const result = store.summary({
        startedAfter: new Date('2026-07-24T09:00:00.000Z'),
        startedBefore: new Date('2026-07-24T10:00:00.000Z'),
      });

      expect(result.bucket).toBe('1m');
      expect(result.buckets).toHaveLength(60);
      expect(result.buckets[0]).toEqual({ at: '2026-07-24T09:00:00.000Z', success: 2, error: 1 });
      expect(result.buckets[1]).toEqual({ at: '2026-07-24T09:01:00.000Z', success: 0, error: 0 });
      expect(result.buckets[30]).toEqual({ at: '2026-07-24T09:30:00.000Z', success: 0, error: 1 });
      // 那条还在跑的落在 09:45 桶里，两边都不该数它
      expect(result.buckets[45]).toEqual({ at: '2026-07-24T09:45:00.000Z', success: 0, error: 0 });
      expect(result.totals).toEqual({ success: 2, error: 2 });
    } finally {
      handle.close();
    }
  });

  test('reuses the list filters', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      seedTrace(store, '1'.repeat(32), '2026-07-24T09:00:10.000Z', 1);
      seedTrace(store, '2'.repeat(32), '2026-07-24T09:00:40.000Z', 2);
      const range = {
        startedAfter: new Date('2026-07-24T09:00:00.000Z'),
        startedBefore: new Date('2026-07-24T10:00:00.000Z'),
      };

      expect(store.summary({ ...range, otelStatusCode: 'ERROR' }).totals).toEqual({ success: 0, error: 1 });
      expect(store.summary({ ...range, finalProviderId: 'provider-nope' }).totals).toEqual({ success: 0, error: 0 });
    } finally {
      handle.close();
    }
  });

  test('coarsens the bucket as the range widens', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const startedAfter = new Date('2026-06-24T00:00:00.000Z');
      const at = (days: number) => new Date(startedAfter.getTime() + days * 86_400_000);

      expect(store.summary({ startedAfter, startedBefore: at(0.25) }).bucket).toBe('5m');
      expect(store.summary({ startedAfter, startedBefore: at(1) }).bucket).toBe('30m');
      expect(store.summary({ startedAfter, startedBefore: at(7) }).bucket).toBe('1h');
      const retention = store.summary({ startedAfter, startedBefore: at(45) });
      expect(retention.bucket).toBe('1d');
      expect(retention.buckets).toHaveLength(45);
    } finally {
      handle.close();
    }
  });
});
```

最后一个用例不是在复述常量表：它钉住的是「桶数有上界」。45 天的范围如果落到 `1m`，一次响应就是 64800 个桶 —— 图画不出来，浏览器也不该收这么多。

import 补 `import type { TraceStore } from './types';`。

- [ ] **Step 4: 跑测试，确认失败**

```bash
cd packages/core && bun test src/db/trace-store/trace-store.test.ts
```

Expected: FAIL，`store.summary is not a function`（类型上也会报 `TraceStore` 没有 `summary`）

- [ ] **Step 5: 写聚合**

`packages/core/src/db/trace-store/trace-summary.ts`：

```ts
import type { DashboardTraceSummaryBucketSize, DashboardTraceSummaryResponse } from '@aio-proxy/types';
import { and, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { traceSpan } from '../schema';
import { traceFilterConditions } from './trace-filters';
import type { TracesSummaryQuery } from './types';

const BUCKET_SIZES: readonly (readonly [DashboardTraceSummaryBucketSize, number])[] = [
  ['1m', 60_000],
  ['5m', 300_000],
  ['30m', 1_800_000],
  ['1h', 3_600_000],
  ['1d', 86_400_000],
];

// 桶数的上界。选最细的、且桶数不超过它的那一档，得到的就是设计稿要的
// 1h→1m / 24h→30m / 7d→1h / 45d→1d，同时任何离谱的时间范围都不会炸出几万个桶。
const MAX_BUCKETS = 180;

function resolveBucket(spanMs: number): readonly [DashboardTraceSummaryBucketSize, number] {
  return BUCKET_SIZES.find(([, size]) => spanMs / size <= MAX_BUCKETS) ?? BUCKET_SIZES[BUCKET_SIZES.length - 1]!;
}

export function summary(db: BunSQLiteDatabase, query: TracesSummaryQuery): DashboardTraceSummaryResponse {
  const startMs = query.startedAfter.getTime();
  const endMs = query.startedBefore.getTime();
  const [bucket, bucketMs] = resolveBucket(Math.max(0, endMs - startMs));
  const count = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));

  // 桶对齐到范围起点而不是 epoch：时间范围是用户在本地时区选的，按 epoch 取整会让
  // 1d 的桶界落在 UTC 零点上，跟图上标的起点对不齐。减去起点就没有时区这回事了。
  const index = sql<number>`(${traceSpan.startedAt} - ${startMs}) / ${bucketMs}`.as('bucket_index');
  const rows = db
    .select({
      index,
      success: sql<number>`sum(case when ${traceSpan.statusCode} = 1 then 1 else 0 end)`.as('success'),
      error: sql<number>`sum(case when ${traceSpan.statusCode} = 2 then 1 else 0 end)`.as('error'),
    })
    .from(traceSpan)
    .where(and(isNull(traceSpan.parentSpanId), ...traceFilterConditions(query)))
    .groupBy(sql`bucket_index`)
    .all();

  const buckets = Array.from({ length: count }, (_, slot) => ({
    at: new Date(startMs + slot * bucketMs).toISOString(),
    success: 0,
    error: 0,
  }));
  for (const row of rows) {
    // startedBefore 是闭区间，正好落在末端的那条会算出 count，收进最后一个桶
    const slot = buckets[Math.min(Number(row.index), count - 1)];
    if (slot === undefined) continue;
    slot.success += Number(row.success);
    slot.error += Number(row.error);
  }

  return {
    bucket,
    buckets,
    totals: buckets.reduce(
      (totals, slot) => ({ success: totals.success + slot.success, error: totals.error + slot.error }),
      { success: 0, error: 0 },
    ),
  };
}
```

`sum(case when ...)` 而不是两次 `count(*) filter (where ...)` —— SQLite 3.30 才有 `FILTER`，`sum(case)` 到处都跑得了，代价是零。

- [ ] **Step 6: 挂到 store 上**

`types.ts`：

```ts
// import 区加 DashboardTraceSummaryResponse
import type { TraceFilters } from './trace-filters';

export type TracesSummaryQuery = Omit<TraceFilters, 'startedAfter' | 'startedBefore'> & {
  readonly startedAfter: Date;
  readonly startedBefore: Date;
};
```

`TraceStore` 里 `list` 之后加一行：

```ts
readonly summary: (query: TracesSummaryQuery) => DashboardTraceSummaryResponse;
```

`trace-store.ts` 加 `import { summary } from './trace-summary';` 和 `summary: (query) => summary(db, query),`。

`index.ts` 的类型导出列表里加 `TracesSummaryQuery`。

- [ ] **Step 7: 跑测试，确认通过**

```bash
cd packages/core && bun test src/db/trace-store
```

Expected: PASS（新增 3 个用例，既有用例全绿）

- [ ] **Step 8: 提交**

```bash
git add packages/core/src/db/trace-store
git commit -m "feat(core): 调用链按时间分桶的成功/失败聚合"
```

---

## Task 5: `GET /dashboard/api/traces/summary`

把 core 的 `summary()` 挂到路由上。过滤参数和 `GET /dashboard/api/traces` 完全一致 —— 用同一份 zod schema 拆出来的公共部分，不是抄一遍。

**注册顺序有讲究**：`/summary` 必须写在 `/:traceId` 之前。Hono 按注册顺序匹配，`/summary` 要是排在后面就先撞上 `/:traceId`，被那个 32 位 hex 的 param 校验拦成 400。

**Files:**
- Modify: `packages/server/src/dashboard-routes/traces/traces.ts`
- Modify: `packages/server/src/dashboard-routes/traces/traces.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `DashboardTraceSummaryResponseSchema`（测试里解响应）；Task 4 的 `TracesSummaryQuery` 与 `state.traceStore.summary`。
- Produces: `GET /dashboard/api/traces/summary`，query 为「`GET /dashboard/api/traces` 的全部过滤参数（去掉 `pageSize` / `pageToken`）+ 必填的 `startedAfter` / `startedBefore`」，200 返回 `DashboardTraceSummaryResponse`，缺时间范围返回 400。Task 6 的 dashboard service 对着这个路由的类型写 `InferResponseType`。

- [ ] **Step 1: 写失败测试**

`traces.test.ts` 的 `describe('Dashboard trace routes')` 里追加两个用例。`seededApp()` 已经种好了正需要的两条数据：08:00:00 一条 `OK`、08:01:00 一条还在跑的 —— 不用新建 fixture。

```ts
test('summarizes traces into buckets over the requested range', async () => {
  const app = await seededApp();
  const response = await app.request(
    '/dashboard/api/traces/summary?startedAfter=2026-07-27T08:00:00.000Z&startedBefore=2026-07-27T09:00:00.000Z',
    undefined,
    loopbackServer,
  );
  const body = DashboardTraceSummaryResponseSchema.parse(await response.json());

  expect(response.status).toBe(200);
  expect(body.bucket).toBe('1m');
  expect(body.buckets).toHaveLength(60);
  expect(body.buckets[0]).toEqual({ at: '2026-07-27T08:00:00.000Z', success: 1, error: 0 });
  // 08:01 那条还在跑，成功和失败都不该算上它
  expect(body.buckets[1]).toEqual({ at: '2026-07-27T08:01:00.000Z', success: 0, error: 0 });
  expect(body.totals).toEqual({ success: 1, error: 0 });
});

test('rejects a trace summary request without a time range', async () => {
  const app = await seededApp();
  const response = await app.request('/dashboard/api/traces/summary', undefined, loopbackServer);

  expect(response.status).toBe(400);
});
```

import 里加 `DashboardTraceSummaryResponseSchema`。

第一个用例顺带钉住了注册顺序：`/summary` 要是被 `/:traceId` 抢走，拿到的就是 400 而不是 200。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd packages/server && bun test src/dashboard-routes/traces
```

Expected: FAIL，第一个用例收到 400（`/summary` 撞上 `/:traceId` 的 param 校验）

- [ ] **Step 3: 拆出公共 query schema**

`traces.ts` 里把 `TracesQuerySchema` 拆成两层。先提一个日期辅助 const，再把除 `pageSize` / `pageToken` 之外的字段整体挪进 `TraceFiltersQuerySchema`：

```ts
const isoDate = z.iso
  .datetime()
  .transform((value) => new Date(value));

const TraceFiltersQuerySchema = z.object({
  startedAfter: isoDate.optional(),
  startedBefore: isoDate.optional(),
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/u)
    .optional(),
  requestId: z.string().trim().min(1).optional(),
  sessionSource: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).max(512).optional(),
  otelStatusCode: OtelSpanStatusCodeSchema.optional(),
  terminationReason: TraceTerminationReasonSchema.optional(),
  inboundProtocol: z.string().trim().min(1).optional(),
  requestedModelId: z.string().trim().min(1).optional(),
  finalProviderId: z.string().trim().min(1).optional(),
  finalModelId: z.string().trim().min(1).optional(),
  finalHttpStatus: z.coerce.number().int().min(100).max(599).optional(),
});

const TracesQuerySchema = TraceFiltersQuerySchema.extend({
  pageSize: z.coerce.number().pipe(DashboardTracePageSizeSchema).default(50),
  pageToken: z
    .string()
    .transform((value, context) => {
      const cursor = decodeTraceCursor(value);
      if (cursor !== undefined) return cursor;
      context.addIssue({ code: 'custom', message: 'invalid page token' });
      return z.NEVER;
    })
    .optional(),
});

// 图表要画满整个时间范围，桶还要对齐到范围起点，所以这两个参数在摘要里是必填。
const TraceSummaryQuerySchema = TraceFiltersQuerySchema.extend({
  startedAfter: isoDate,
  startedBefore: isoDate,
});
```

`toTracesQuery` 同样拆成两层：

```ts
function toTraceFilters(query: z.output<typeof TraceFiltersQuerySchema>) {
  return {
    ...(query.startedAfter === undefined ? {} : { startedAfter: query.startedAfter }),
    ...(query.startedBefore === undefined ? {} : { startedBefore: query.startedBefore }),
    ...(query.traceId === undefined ? {} : { traceId: query.traceId }),
    ...(query.requestId === undefined ? {} : { requestId: query.requestId }),
    ...(query.sessionSource === undefined ? {} : { sessionSource: query.sessionSource }),
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
    ...(query.otelStatusCode === undefined ? {} : { otelStatusCode: query.otelStatusCode }),
    ...(query.terminationReason === undefined ? {} : { terminationReason: query.terminationReason }),
    ...(query.inboundProtocol === undefined ? {} : { inboundProtocol: query.inboundProtocol }),
    ...(query.requestedModelId === undefined ? {} : { requestedModelId: query.requestedModelId }),
    ...(query.finalProviderId === undefined ? {} : { finalProviderId: query.finalProviderId }),
    ...(query.finalModelId === undefined ? {} : { finalModelId: query.finalModelId }),
    ...(query.finalHttpStatus === undefined ? {} : { finalHttpStatus: query.finalHttpStatus }),
  };
}

function toTracesQuery(query: z.output<typeof TracesQuerySchema>): TracesQuery {
  return {
    pageSize: query.pageSize,
    ...(query.pageToken === undefined ? {} : { cursor: query.pageToken }),
    ...toTraceFilters(query),
  };
}

function toTraceSummaryQuery(query: z.output<typeof TraceSummaryQuerySchema>): TracesSummaryQuery {
  return { ...toTraceFilters(query), startedAfter: query.startedAfter, startedBefore: query.startedBefore };
}
```

加一个 validator，和既有那两个一个模子：

```ts
const traceSummaryQueryValidator = validator('query', (raw, context) => {
  const parsed = TraceSummaryQuerySchema.safeParse(raw);
  return parsed.success
    ? toTraceSummaryQuery(parsed.data)
    : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});
```

- [ ] **Step 4: 加路由**

`.get('/', ...)` 之后、`.get('/:traceId', ...)` **之前**插入：

```ts
    .get('/summary', traceSummaryQueryValidator, (context) =>
      context.json(state.traceStore.summary(context.req.valid('query'))),
    )
```

import 里 `TracesQuery` 旁边加 `type TracesSummaryQuery`。

- [ ] **Step 5: 跑测试，确认通过**

```bash
cd packages/server && bun test src/dashboard-routes/traces
```

Expected: PASS（新增 2 个用例，既有 5 个用例全绿 —— 特别是 `defaults trace page size to 50` 和 `rejects a malformed trace page token`，它们保证 schema 拆层没把 `pageSize` 默认值和 `pageToken` 的自定义报错弄丢）

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/dashboard-routes/traces
git commit -m "feat(server): 加调用链摘要聚合接口"
```

---

## Task 6: dashboard 侧的取数

service + query key + hook 三件套，照着既有的 `tracesQueryOptions` / `useTracesQuery` 写。

一个要点：摘要的 query key 和请求参数都**不带 `pageSize` / `pageToken`**。图覆盖的是整个时间范围，跟你翻到第几页无关 —— 带上翻页参数的话，每翻一页图都会重新请求一次，闪一下再变回一模一样的样子。

**Files:**
- Modify: `packages/dashboard/src/lib/query-keys.ts`
- Modify: `packages/dashboard/src/modules/traces/services/traces-service/traces-service.ts`
- Create: `packages/dashboard/src/modules/traces/hooks/use-trace-summary-query.ts`

**Interfaces:**
- Consumes: Task 5 的路由（经 `dashboardClient` 的类型推导）；`TraceSearch` from `../../lib/trace-search`。
- Produces:
  - `queryKeys.tracesSummary(filters: object)`
  - `traceSummaryQueryOptions(search: TraceSearch, autoRefresh: boolean)`、`getTraceSummary(search: TraceSearch)`、类型 `TraceSummaryData`
  - `useTraceSummaryQuery(search: TraceSearch, autoRefresh: boolean)`
  - Task 7 的 `TracesEvents` 用 `useTraceSummaryQuery`，测试里 mock 掉这个 hook。

- [ ] **Step 1: 加 query key**

`packages/dashboard/src/lib/query-keys.ts`，按字母序插在 `traces` 之后：

```ts
  // 摘要 key 不含分页参数：图覆盖整个时间范围，翻页不该让它重新请求。
  tracesSummary: (filters: object) => ['dashboard', 'traces', 'summary', filters],
```

- [ ] **Step 2: 加 service**

`traces-service.ts`。类型别名区加一行：

```ts
type DashboardTraceSummaryResponse = InferResponseType<
  typeof dashboardClient.dashboard.api.traces.summary.$get,
  200
>;
```

`traceQueryOptions` 之后加：

```ts
const toSummaryFilters = (search: TraceSearch) => omit(search, ['pageSize', 'pageToken']);

export const traceSummaryQueryOptions = (search: TraceSearch, autoRefresh: boolean) =>
  queryOptions({
    queryKey: queryKeys.tracesSummary(toSummaryFilters(search)),
    queryFn: () => getTraceSummary(search),
    refetchInterval: autoRefresh && search.pageToken === undefined ? 5_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
```

轮询用和 `tracesQueryOptions` 一模一样的条件 —— 图和表得同时动，各走各的规则会出现「表停了图还在跳」。

`getTrace` 之后加：

```ts
export const getTraceSummary = async (search: TraceSearch): Promise<DashboardTraceSummaryResponse> => {
  const response = await dashboardClient.dashboard.api.traces.summary.$get({
    query: {
      // 同 getTraces：validator 暴露的是 transform 之后的 Date，HTTP 客户端要发的是 ISO 串。
      startedAfter: search.startedAfter as unknown as Date,
      startedBefore: search.startedBefore as unknown as Date,
      ...(search.traceId === undefined ? {} : { traceId: search.traceId }),
      ...(search.requestId === undefined ? {} : { requestId: search.requestId }),
      ...(search.sessionSource === undefined ? {} : { sessionSource: search.sessionSource }),
      ...(search.sessionId === undefined ? {} : { sessionId: search.sessionId }),
      ...(search.otelStatusCode === undefined ? {} : { otelStatusCode: search.otelStatusCode }),
      ...(search.terminationReason === undefined ? {} : { terminationReason: search.terminationReason }),
      ...(search.inboundProtocol === undefined ? {} : { inboundProtocol: search.inboundProtocol }),
      ...(search.requestedModelId === undefined ? {} : { requestedModelId: search.requestedModelId }),
      ...(search.finalProviderId === undefined ? {} : { finalProviderId: search.finalProviderId }),
      ...(search.finalModelId === undefined ? {} : { finalModelId: search.finalModelId }),
      ...(search.finalHttpStatus === undefined ? {} : { finalHttpStatus: search.finalHttpStatus }),
    },
  });
  if (!response.ok) throw new DashboardTracesRequestError(response.status);
  return response.json();
};
```

文件末尾的类型导出加：

```ts
export type TraceSummaryData = Awaited<ReturnType<typeof getTraceSummary>>;
```

import 加 `import { omit } from 'es-toolkit/object';`。

- [ ] **Step 3: 加 hook**

`packages/dashboard/src/modules/traces/hooks/use-trace-summary-query.ts`：

```ts
import { useQuery } from '@tanstack/react-query';

import type { TraceSearch } from '../lib/trace-search';
import { traceSummaryQueryOptions } from '../services/traces-service';

export const useTraceSummaryQuery = (search: TraceSearch, autoRefresh: boolean) =>
  useQuery(traceSummaryQueryOptions(search, autoRefresh));
```

- [ ] **Step 4: 确认类型能编译**

```bash
bun run check
```

Expected: 通过。`dashboardClient.dashboard.api.traces.summary.$get` 这条链路能被推导出来，就说明 Task 5 的路由类型确实流到了前端 —— 路由要是没注册，或者 query 字段名对不上，这里直接编译不过。

这一步不加单测：三个文件都是既有模式的直译，没有分支也没有计算，唯一会错的地方（路由类型对不上）已经被 `bun run check` 抓住了，真实取数行为在 Task 7 的组件测试里过。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/lib/query-keys.ts packages/dashboard/src/modules/traces
git commit -m "feat(dashboard): 接入调用链摘要聚合接口"
```

---

## Task 7: Events 卡片

表格上方的堆叠柱状图。三个文件：`traces-events-chart` 只管画（recharts），`traces-events` 管卡片壳、图例、折叠和交互的语义，`stores/traces-events-collapsed.ts` 管偏好持久化。分开是因为 recharts 在 jsdom 里量不到宽高、`ResponsiveContainer` 不渲染子元素 —— 图表本身测不了，把可测的行为全留在 `traces-events` 里，测试 mock 掉图表模块。仓库里既有的两张图（`model-usage-trend.tsx`、`usage-trend-chart.tsx`）都没有测试，这里也不为了凑覆盖率去和 jsdom 搏斗。

**Files:**
- Modify: `packages/ui/src/styles.css:28,79`
- Create: `packages/dashboard/src/modules/traces/stores/traces-events-collapsed.ts`
- Create: `packages/dashboard/src/modules/traces/components/traces-events-chart/index.ts`
- Create: `packages/dashboard/src/modules/traces/components/traces-events-chart/traces-events-chart.tsx`
- Create: `packages/dashboard/src/modules/traces/components/traces-events/index.ts`
- Create: `packages/dashboard/src/modules/traces/components/traces-events/traces-events.tsx`
- Create: `packages/dashboard/src/modules/traces/components/traces-events/traces-events.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.tsx`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx`
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`

**Interfaces:**
- Consumes: Task 6 的 `useTraceSummaryQuery`；Task 3 的 `DashboardTraceSummaryBucket` / `DashboardTraceSummaryBucketSize`；`TraceSearch` / `withTraceFilters` from `../../lib/trace-search`；`ChartConfig` / `ChartContainer` / `ChartTooltip` / `ChartTooltipContent` from `@aio-proxy/ui/components/chart`。
- Produces:
  - `tracesEventsCollapsedAtom`（jotai，`boolean`）
  - `TracesEventsChart: React.FC<TracesEventsChartProps>`，`TracesEventsChartProps = { buckets: readonly DashboardTraceSummaryBucket[]; bucket: DashboardTraceSummaryBucketSize; onBucketSelect: (at: string) => void }`
  - `TracesEvents: React.FC<TracesEventsProps>`，`TracesEventsProps = { search: TraceSearch; autoRefresh: boolean; onChange: (search: TraceSearch) => void }`
  - Task 8 只跑收口命令，不依赖这里的导出。

- [ ] **Step 1: 加状态色 token**

`packages/ui/src/styles.css` 两处。`@theme inline` 里 `--color-chart-5` 那一行**之前**（28 行）加两行，让 `bg-chart-success` 这类工具类可用（图例色块要用）：

```css
  --color-chart-error: var(--chart-error);
  --color-chart-success: var(--chart-success);
```

`:root` 里 `--chart-1` 那一行**之前**（79 行）加两行：

```css
  /* 状态色，不是分类色：失败永远是红，不参与 chart-1..5 的轮转。
     teal-600 / red-500 在 light 和 dark 两个 surface 上都过了 validate_palette.js 的六项检查，
     所以 .dark 不需要覆写 —— 两模同值是选出来的结果，不是忘了写。 */
  --chart-success: var(--color-teal-600);
  --chart-error: var(--color-red-500);
```

`.dark` 块不动。

- [ ] **Step 2: 加 i18n 文案**

五个 locale 的 `dashboard.traces` 各加四个键。成功/失败两个图例 chip 直接复用既有的 `success` / `failure`，不新造：

| 文件 | `events` | `events_hint` | `events_collapse` | `events_expand` |
|---|---|---|---|---|
| `en.json` | `"Events"` | `"Click a bar to zoom into that time range"` | `"Collapse chart"` | `"Expand chart"` |
| `ja.json` | `"イベント"` | `"バーをクリックするとその時間帯に絞り込みます"` | `"グラフを折りたたむ"` | `"グラフを展開"` |
| `ko.json` | `"이벤트"` | `"막대를 클릭하면 해당 시간대로 좁혀집니다"` | `"차트 접기"` | `"차트 펼치기"` |
| `zh-Hans.json` | `"事件"` | `"点击柱体可缩放到该时间段"` | `"折叠图表"` | `"展开图表"` |
| `zh-Hant.json` | `"事件"` | `"點擊長條可縮放到該時間區間"` | `"摺疊圖表"` | `"展開圖表"` |

```bash
bun run i18n:compile
```

- [ ] **Step 3: 加折叠偏好的 store**

`packages/dashboard/src/modules/traces/stores/traces-events-collapsed.ts`：

```ts
import { atomWithStorage } from 'jotai/utils';

// 折叠是个人显示偏好，存 localStorage 而不是 URL：进了 URL 就会被分享出去，
// 对方打开链接看到的是你的折叠状态。
// getOnInit 让首帧就读到存的值，否则会先展开一帧再收起来，闪一下。
export const tracesEventsCollapsedAtom = atomWithStorage('aio-proxy:traces-events-collapsed', false, undefined, {
  getOnInit: true,
});
```

`jotai` 已经是 `packages/dashboard` 的依赖（`usage/stores/usage-overview-filters.ts` 在用），不用加包。

- [ ] **Step 4: 写失败测试**

`packages/dashboard/src/modules/traces/components/traces-events/traces-events.test.tsx`。摘要 hook 和图表模块都 mock 掉：hook 是为了不起网络，图表是因为 recharts 的 `ResponsiveContainer` 在 happy-dom 里量到 0 宽高、根本不渲染子元素。mock 出来的假图表暴露一个按钮来触发 `onBucketSelect`，被测的是 `TracesEvents` 里真实的收窄逻辑。

```tsx
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';

import { createDefaultTraceSearch, type TraceSearch } from '../../lib/trace-search';
import { TracesEvents } from './traces-events';

const mocks = rs.hoisted(() => ({ summarySearch: rs.fn() }));

rs.mock('../../hooks/use-trace-summary-query', () => ({
  useTraceSummaryQuery: (search: unknown, autoRefresh: boolean) => {
    mocks.summarySearch(search, autoRefresh);
    return {
      data: {
        bucket: '1m',
        buckets: [
          { at: '2026-07-27T08:00:00.000Z', success: 18_307, error: 0 },
          { at: '2026-07-27T08:01:00.000Z', success: 0, error: 93 },
        ],
        totals: { success: 18_307, error: 93 },
      },
      isLoading: false,
      isError: false,
    };
  },
}));

rs.mock('../traces-events-chart', () => ({
  TracesEventsChart: ({ onBucketSelect }: { readonly onBucketSelect: (at: string) => void }) => (
    <button type="button" onClick={() => onBucketSelect('2026-07-27T08:01:00.000Z')}>
      pick bucket
    </button>
  ),
}));

const renderEvents = (search: TraceSearch = createDefaultTraceSearch()) => {
  const onChange = rs.fn();
  // 每次渲染一个独立的 jotai store：atomWithStorage 在 store 初始化时读一次 localStorage，
  // 用默认 store 的话上一个用例的折叠状态会漏进下一个。
  render(
    <Provider store={createStore()}>
      <TracesEvents search={search} autoRefresh={false} onChange={onChange} />
    </Provider>,
  );
  return { onChange };
};

const successChip = () => screen.getByRole('button', { name: /Success|成功/u });
const errorChip = () => screen.getByRole('button', { name: /Failure|失败|失敗/u });

describe('TracesEvents', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.summarySearch.mockClear();
  });

  test('shows the range totals on the legend chips', () => {
    renderEvents();

    expect(successChip()).toHaveTextContent('18,307');
    expect(errorChip()).toHaveTextContent('93');
  });

  test('uses the legend chips as the otel status filter', () => {
    const { onChange } = renderEvents();

    expect(errorChip()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(errorChip());

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ otelStatusCode: 'ERROR' }));
  });

  test('clears the status filter when the pressed chip is clicked again', () => {
    const search = { ...createDefaultTraceSearch(), otelStatusCode: 'ERROR' as const };
    const { onChange } = renderEvents(search);

    expect(errorChip()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(errorChip());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).not.toHaveProperty('otelStatusCode');
  });

  test('narrows the time range to the clicked bucket', () => {
    const { onChange } = renderEvents();

    fireEvent.click(screen.getByRole('button', { name: 'pick bucket' }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAfter: '2026-07-27T08:01:00.000Z',
        // 桶宽从相邻两个桶的间隔推出来，闭区间的右端减 1ms
        startedBefore: '2026-07-27T08:01:59.999Z',
      }),
    );
  });

  test('keeps the collapsed preference in localStorage', () => {
    renderEvents();

    fireEvent.click(screen.getByRole('button', { name: /Collapse chart|折叠图表/u }));

    expect(screen.queryByRole('button', { name: 'pick bucket' })).toBeNull();
    expect(window.localStorage.getItem('aio-proxy:traces-events-collapsed')).toBe('true');

    renderEvents();

    expect(screen.queryByRole('button', { name: 'pick bucket' })).toBeNull();
    expect(screen.getByRole('button', { name: /Expand chart|展开图表/u })).toHaveAttribute('aria-expanded', 'false');
  });

  test('passes the search and the auto refresh flag straight to the summary query', () => {
    const search = { ...createDefaultTraceSearch(), pageToken: 'token' };
    renderEvents(search);

    expect(mocks.summarySearch).toHaveBeenCalledWith(search, false);
  });
});
```

最后一个用例看着像在测传参，其实钉的是「摘要 hook 拿到的是完整 `search`」—— 丢掉分页参数是 `traceSummaryQueryOptions` 的责任（Task 6），组件不许自己先削一遍，否则两处削法一旦不一致，query key 和请求体就会错位。

- [ ] **Step 5: 跑测试，确认失败**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/components/traces-events
```

Expected: FAIL，`Cannot find module './traces-events'`

- [ ] **Step 6: 写图表**

`packages/dashboard/src/modules/traces/components/traces-events-chart/traces-events-chart.tsx`：

```tsx
import { getLocale, m } from '@aio-proxy/i18n';
import type { DashboardTraceSummaryBucket, DashboardTraceSummaryBucketSize } from '@aio-proxy/types';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@aio-proxy/ui/components/chart';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

interface TracesEventsChartProps {
  readonly buckets: readonly DashboardTraceSummaryBucket[];
  readonly bucket: DashboardTraceSummaryBucketSize;
  readonly onBucketSelect: (at: string) => void;
}

export const TracesEventsChart: React.FC<TracesEventsChartProps> = ({ buckets, bucket, onBucketSelect }) => {
  const locale = getLocale();
  const formatCount = new Intl.NumberFormat(locale, { notation: 'compact' });
  const formatTick =
    bucket === '1d'
      ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
      : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
  const formatLabel = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const chartConfig = {
    success: { color: 'var(--chart-success)', label: m['dashboard.traces.success']() },
    error: { color: 'var(--chart-error)', label: m['dashboard.traces.failure']() },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-40 w-full">
      <BarChart
        data={buckets as DashboardTraceSummaryBucket[]}
        margin={{ left: 8, right: 8 }}
        barCategoryGap={2}
        maxBarSize={24}
        onClick={(state) => {
          // activeLabel 是命中那一类的 x 值，也就是桶的 at。事件挂在图上而不是 <Bar> 上，
          // 空桶（一条都没有）也点得到 —— 命中区是整条类目带，比柱体本身宽。
          if (typeof state.activeLabel === 'string') onBucketSelect(state.activeLabel);
        }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="at"
          axisLine={false}
          tickLine={false}
          minTickGap={24}
          tickFormatter={(value) => formatTick.format(new Date(String(value)))}
        />
        <YAxis axisLine={false} tickLine={false} width={40} tickFormatter={(value) => formatCount.format(Number(value))} />
        <ChartTooltip
          content={<ChartTooltipContent labelFormatter={(value) => formatLabel.format(new Date(String(value)))} />}
        />
        {/* 成功在下、失败在上。stroke 用卡片底色画 2px，既是堆叠两段之间的表面间隙，
            也把相邻柱子分开。两段都收 4px 圆角：绝大多数桶没有失败，只给顶段加圆角的话
            整张图会变成一排平头柱子。有失败时成功段顶上那两个圆角缺口正好落在 2px 间隙里。 */}
        <Bar
          dataKey="success"
          stackId="events"
          fill="var(--chart-success)"
          stroke="var(--card)"
          strokeWidth={2}
          radius={[4, 4, 0, 0]}
          className="cursor-pointer"
        />
        <Bar
          dataKey="error"
          stackId="events"
          fill="var(--chart-error)"
          stroke="var(--card)"
          strokeWidth={2}
          radius={[4, 4, 0, 0]}
          className="cursor-pointer"
        />
      </BarChart>
    </ChartContainer>
  );
};
```

图例不用 `ChartLegend` —— 它在 `traces-events.tsx` 里是两个带计数的筛选按钮，不是这张图的附属物。

`packages/dashboard/src/modules/traces/components/traces-events-chart/index.ts`：

```ts
export * from './traces-events-chart';
```

- [ ] **Step 7: 写 Events 卡片**

`packages/dashboard/src/modules/traces/components/traces-events/traces-events.tsx`：

```tsx
import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useAtom } from 'jotai';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useId } from 'react';

import { useTraceSummaryQuery } from '../../hooks/use-trace-summary-query';
import { type TraceSearch, withTraceFilters } from '../../lib/trace-search';
import { tracesEventsCollapsedAtom } from '../../stores/traces-events-collapsed';
import { TracesEventsChart } from '../traces-events-chart';

interface TracesEventsProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly onChange: (search: TraceSearch) => void;
}

export const TracesEvents: React.FC<TracesEventsProps> = ({ search, autoRefresh, onChange }) => {
  const bodyId = useId();
  const [collapsed, setCollapsed] = useAtom(tracesEventsCollapsedAtom);
  const query = useTraceSummaryQuery(search, autoRefresh);
  const formatCount = new Intl.NumberFormat(getLocale());
  const totals = query.data?.totals ?? { success: 0, error: 0 };
  const chips = [
    { code: 'OK', label: m['dashboard.traces.success'](), count: totals.success, dot: 'bg-chart-success' },
    { code: 'ERROR', label: m['dashboard.traces.failure'](), count: totals.error, dot: 'bg-chart-error' },
  ] as const;

  const selectBucket = (at: string) => {
    const [first, second] = query.data?.buckets ?? [];
    // 桶宽从相邻两个桶的间隔推出来，不在前端再抄一份粒度表。只有一个桶时，
    // 收窄的结果就是当前范围本身，直接不动。
    if (first === undefined || second === undefined) return;
    const startMs = Date.parse(at);
    const bucketMs = Date.parse(second.at) - Date.parse(first.at);
    onChange(
      withTraceFilters(search, {
        startedAfter: new Date(startMs).toISOString(),
        // 服务端的 startedBefore 是闭区间，减 1ms 免得把下一个桶的第一条也捞进来
        startedBefore: new Date(startMs + bucketMs - 1).toISOString(),
      }),
    );
  };

  return (
    <section className="border-b" aria-label={m['dashboard.traces.events']()}>
      <header className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2">
        {chips.map((chip) => {
          const pressed = search.otelStatusCode === chip.code;
          // 抽屉里还能筛 UNSET（还在跑），那时两个 chip 都不是按下态，也都该淡出。
          const filteredOut = search.otelStatusCode !== undefined && !pressed;
          return (
            <button
              key={chip.code}
              type="button"
              aria-pressed={pressed}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-opacity',
                pressed && 'border-ring',
                filteredOut && 'opacity-50',
              )}
              onClick={() =>
                onChange(withTraceFilters(search, { otelStatusCode: pressed ? undefined : chip.code }))
              }
            >
              <span className={cn('size-2 rounded-full', chip.dot)} />
              <span className="font-medium tabular-nums">{formatCount.format(chip.count)}</span>
              <span className="text-muted-foreground">{chip.label}</span>
            </button>
          );
        })}
        <span className="ml-auto text-muted-foreground text-xs max-sm:hidden">
          {m['dashboard.traces.events_hint']()}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          title={collapsed ? m['dashboard.traces.events_expand']() : m['dashboard.traces.events_collapse']()}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </header>
      {!collapsed && (
        <div id={bodyId} className="px-3 pb-3">
          {query.isLoading && <Skeleton className="h-40 w-full" />}
          {query.isError && <p className="text-muted-foreground text-xs">{m['dashboard.traces.error_title']()}</p>}
          {query.data && (
            <TracesEventsChart
              buckets={query.data.buckets}
              bucket={query.data.bucket}
              onBucketSelect={selectBucket}
            />
          )}
        </div>
      )}
    </section>
  );
};
```

按下的 chip 写的是 `otelStatusCode`，抽屉里那个「请求状态」筛选读的也是这个字段 —— 一份状态两个入口，不是两条过滤链路。被筛掉的那个系列计数会显示 0：那是当前筛选下的真实数量，不是丢了数据，再点一次按下的 chip 就全回来。

`packages/dashboard/src/modules/traces/components/traces-events/index.ts`：

```ts
export * from './traces-events';
```

- [ ] **Step 8: 跑测试，确认通过**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/components/traces-events
```

Expected: PASS（6 个用例）

- [ ] **Step 9: 改页面的测试**

`traces-page.test.tsx` 三处。第一处，摘要 hook 要 mock 掉，不然页面测试会真的去发请求。`data` 给 `undefined`，卡片就只渲染头部的图例 —— recharts 完全不进 happy-dom，页面测试不用为一张量不到宽高的图买单。加在既有的 `rs.mock('../../hooks/use-traces-query', …)` 之后：

```tsx
rs.mock('../../hooks/use-trace-summary-query', () => ({
  useTraceSummaryQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
```

第二处，125 行和 376 行的两个断言现在会撞上图例 chip 上的同名文案（`成功` / `失败`），得收窄到表格里：

```tsx
// 125 行
expect(screen.getByText(/Failure|失败/u)).toBeTruthy();
// 换成
expect(within(screen.getByRole('table')).getByText(/Failure|失败/u)).toBeTruthy();

// 376 行
expect(screen.getByText(/Success|成功/u)).toBeTruthy();
// 换成
expect(within(screen.getByRole('table')).getByText(/Success|成功/u)).toBeTruthy();
```

`within` 这个测试文件已经 import 了。

第三处，加一个用例把「Events 卡片在表格上方、图例点击写回 URL」钉住。放在 `describe('traces page')` 里：

```tsx
test('renders the events card above the table and routes legend clicks into the status filter', () => {
  const search = { ...createDefaultTraceSearch(), pageSize: 20 as const };
  const onSearchChange = rs.fn();
  render(<TracesPage search={search} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);

  const events = screen.getByRole('region', { name: /Events|事件|イベント|이벤트/u });
  expect(events.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(within(events).getByRole('button', { name: /Failure|失败|失敗|Failed/u }));

  expect(onSearchChange).toHaveBeenCalledWith(expect.objectContaining({ otelStatusCode: 'ERROR' }));
});
```

`compareDocumentPosition` 是在钉顺序：Events 卡片必须在表格之前。图放到表下面就成了「先看结果再看概览」，整块的意义就没了。

- [ ] **Step 10: 跑测试，确认失败**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces/templates/traces-page
```

Expected: FAIL，新用例找不到 `Events` region（卡片还没挂上）

- [ ] **Step 11: 挂到页面上**

`traces-page.tsx`：Task 1 换上的 `<TracesToolbar … />` 之后、包着表格的那个 `<div className="min-h-0 min-w-0 flex-1 pb-3 sm:pb-4">` 之前插入：

```tsx
<TracesEvents search={search} autoRefresh={autoRefresh} onChange={onSearchChange} />
```

import 加：

```tsx
import { TracesEvents } from '../../components/traces-events';
```

卡片自己带 `border-b`，工具栏和表格之间的分隔线就够了，不用再包 `Card`。

- [ ] **Step 12: 跑整个 traces 模块的测试**

```bash
cd packages/dashboard && bunx rstest run src/modules/traces
```

Expected: PASS（全绿）

- [ ] **Step 13: 提交**

```bash
git add packages/ui/src/styles.css packages/dashboard/src/modules/traces packages/i18n
git commit -m "feat(dashboard): 调用链列表页加成功/失败分桶图"
```

---

## Task 8: 收口

**Files:**
- Create: `.changeset/<随机名>.md`

**Interfaces:**
- Consumes: Task 1–7 的全部改动。
- Produces: 无（不留新的导出）。

- [ ] **Step 1: 跑完整 preflight**

```bash
bun run preflight
```

Expected: PASS（oxlint + oxfmt check + 全部单测）。失败就地修，不要带着红的往下走。

常见两处：
- oxfmt 会重排 import 顺序和换行，`bun run format` 一把过。
- `bun run check` 抓类型。dashboard 侧最可能报的是 `dashboardClient.dashboard.api.traces.summary.$get` 不存在 —— 那说明 server 没编译过或路由没注册，回 Task 5 看。

- [ ] **Step 2: 确认 i18n 五个 locale 齐了**

```bash
bun run i18n:compile
git diff --stat packages/i18n
```

Expected: 五个 `messages/*.json` 都在 diff 里，各多 6 个键（Task 1 的 `live` / `live_off`，Task 7 的 `events` / `events_hint` / `events_collapse` / `events_expand`）。少一个 locale，Paraglide 编译不报错但那个语言会掉回英文。

- [ ] **Step 3: 写 changeset**

`.changeset/` 下手写一个文件（`bun changeset` 是交互式的，agent 直接写文件更快）。frontmatter 必须同时列内部包和 `aio-proxy` —— 只列内部包的话，`aio-proxy` 的 CHANGELOG 条目是空的，`scripts/release.ts` 会跳过它的 GitHub Release，这条说明就无声消失了：

```md
---
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/ui': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链列表页进入时不再自动轮询，工具栏新增「实时」开关、筛选入口和时间范围选择器。表格上方新增按时间分桶的成功/失败堆叠柱状图：图例显示区间总数并直接充当状态筛选，点击柱体把时间范围收窄到该桶，折叠状态记在本地。表格的「状态」列移到 HTTP 之后。
```

正文一段、不超过 5 行、不带 `dashboard:` 之类的区域前缀（frontmatter 已经列了包），不写文件名和实现细节。

- [ ] **Step 4: 提交**

```bash
git add .changeset packages/i18n
git commit -m "chore: 调用链列表页改版的 changeset"
```

- [ ] **Step 5: 最后确认**

```bash
git status --short
git log --oneline main..HEAD
```

Expected: 工作区干净；`main..HEAD` 上是 Task 1–8 的 8 个提交（Task 3–6 各一个，Task 1/2/7/8 各一个）。
