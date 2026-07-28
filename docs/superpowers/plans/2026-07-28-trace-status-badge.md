# Trace Status Badge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present Trace and Span outcomes with five user-facing statuses and restrained, theme-aware Badge colors.

**Architecture:** Keep the shared shadcn `Badge` unchanged. Move `TraceStatus` into the required colocated-test directory layout, derive one of five display statuses, and apply Trace-specific Teal and Sky classes directly through a local `cva` variant.

**Tech Stack:** React 19, TypeScript, shadcn/Base UI Badge, class-variance-authority, Tailwind CSS 4, Rstest, Testing Library.

## Global Constraints

- Keep the persisted OpenTelemetry status, Dashboard DTOs, API contracts, and raw OTel filters unchanged.
- User-facing statuses are exactly Running, Success, Failure, Cancelled, and Interrupted; OTel `ERROR` without a termination reason maps to Failure.
- Keep `packages/dashboard/src/components/ui/badge.tsx` unchanged.
- Success uses Teal 50 / Teal 700 in light mode and Teal 950 / Teal 300 in dark mode.
- Running uses Sky 50 / Sky 700 in light mode and Sky 950 / Sky 300 in dark mode.
- Write Success and Running colors directly in the Trace-local `cva`; do not add or reuse Dashboard color tokens and do not change `styles.css`.
- Cancelled and Interrupted use `outline`; Failure uses existing destructive colors.
- Do not add a global business Badge, a warning status, a warning token, or a dependency.
- All shell commands are prefixed with `rtk`.
- Before editing UI, load Impeccable's `reference/craft-floor.md`; after UI changes, run its detector once over the changed UI files.
- Every commit includes `Co-authored-by: Codex <noreply@openai.com>`.

---

### Task 1: Implement the five-state Trace Badge

**Files:**
- Delete after moving: `packages/dashboard/src/modules/traces/components/trace-status.tsx`
- Create: `packages/dashboard/src/modules/traces/components/trace-status/index.ts`
- Create: `packages/dashboard/src/modules/traces/components/trace-status/trace-status.tsx`
- Create: `packages/dashboard/src/modules/traces/components/trace-status/trace-status.test.tsx`

**Interfaces:**
- Consumes: `Badge` from `@/components/ui/badge`, `DashboardTraceSummary`, `DashboardTraceSpan`, and existing i18n status messages.
- Produces: `TraceStatus: React.FC<TraceStatusProps>` exported from `components/trace-status/index.ts`; existing imports of `./trace-status` remain valid.
- Produces: Trace-local `cva` classes for Teal Success and Sky Running presentations.

- [ ] **Step 1: Add the failing TraceStatus behavior test**

Create `packages/dashboard/src/modules/traces/components/trace-status/trace-status.test.tsx`:

```tsx
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceStatus } from './trace-status';

const endedAt = '2026-07-28T08:00:01.000Z';

test.each([
  {
    name: 'running takes precedence while the item has not ended',
    item: { endedAt: null, otelStatusCode: 'ERROR' as const, terminationReason: 'failure' as const },
    label: /Running|运行中/u,
    status: 'running',
    presentationClass: 'bg-sky-50',
  },
  {
    name: 'completed UNSET is successful',
    item: { endedAt, otelStatusCode: 'UNSET' as const },
    label: /Success|成功/u,
    status: 'success',
    presentationClass: 'bg-teal-50',
  },
  {
    name: 'failure termination is destructive',
    item: { endedAt, otelStatusCode: 'UNSET' as const, terminationReason: 'failure' as const },
    label: /Failure|失败/u,
    status: 'failure',
    presentationClass: 'text-destructive',
  },
  {
    name: 'cancellation is neutral',
    item: { endedAt, otelStatusCode: 'UNSET' as const, terminationReason: 'cancelled' as const },
    label: /Cancelled|已取消/u,
    status: 'cancelled',
    presentationClass: 'border-border',
  },
  {
    name: 'interruption is neutral',
    item: { endedAt, otelStatusCode: 'UNSET' as const, terminationReason: 'interrupted' as const },
    label: /Interrupted|已中断/u,
    status: 'interrupted',
    presentationClass: 'border-border',
  },
  {
    name: 'OTel ERROR without a termination reason is failure',
    item: { endedAt, otelStatusCode: 'ERROR' as const },
    label: /Failure|失败/u,
    status: 'failure',
    presentationClass: 'text-destructive',
  },
])('$name', ({ item, label, status, presentationClass }) => {
  render(<TraceStatus item={item} />);

  const badge = screen.getByText(label);
  expect(badge).toHaveAttribute('data-status', status);
  expect(badge).toHaveClass(presentationClass);
});
```

- [ ] **Step 2: Run the focused test and verify that it fails**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/components/trace-status/trace-status.test.tsx
```

Expected: FAIL because the new module layout and five-state presentation do not exist yet.

- [ ] **Step 3: Move TraceStatus into the colocated-test directory and implement the local cva variant**

Create `packages/dashboard/src/modules/traces/components/trace-status/index.ts`:

```ts
export { TraceStatus } from './trace-status';
```

Replace the old flat component with `packages/dashboard/src/modules/traces/components/trace-status/trace-status.tsx`:

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';
import { cva } from 'class-variance-authority';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TraceStatusProps {
  readonly item: Pick<DashboardTraceSummary | DashboardTraceSpan, 'endedAt' | 'otelStatusCode' | 'terminationReason'>;
  readonly className?: string;
}

type DisplayStatus = 'running' | 'success' | 'failure' | 'cancelled' | 'interrupted';

const statusLabels: Record<DisplayStatus, () => string> = {
  running: m['dashboard.traces.running'],
  success: m['dashboard.traces.success'],
  failure: m['dashboard.traces.failure'],
  cancelled: m['dashboard.traces.cancelled'],
  interrupted: m['dashboard.traces.interrupted'],
};

const traceStatusVariants = cva('', {
  variants: {
    status: {
      running: 'border-transparent bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
      success: 'border-transparent bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
      failure: 'border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20',
      cancelled: '',
      interrupted: '',
    },
  },
});

const displayStatus = (item: TraceStatusProps['item']): DisplayStatus => {
  if (item.endedAt === null) return 'running';
  if (item.terminationReason !== undefined) return item.terminationReason;
  return item.otelStatusCode === 'ERROR' ? 'failure' : 'success';
};

export const TraceStatus: React.FC<TraceStatusProps> = ({ item, className }) => {
  const status = displayStatus(item);
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      <Badge variant="outline" className={traceStatusVariants({ status })} data-status={status}>
        {statusLabels[status]()}
      </Badge>
    </div>
  );
};
```

Delete `packages/dashboard/src/modules/traces/components/trace-status.tsx` after the directory entry point exists. Do not change its callers; `./trace-status` resolves to the new `index.ts`.

- [ ] **Step 4: Run the focused test and verify that it passes**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/components/trace-status/trace-status.test.tsx
```

Expected: PASS for all six inputs and exactly five user-facing statuses.

- [ ] **Step 5: Run the Trace module regression tests**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces
```

Expected: PASS; existing Trace list, detail, Span panel, and waterfall consumers continue resolving `./trace-status`.

- [ ] **Step 6: Run the UI detector once**

Run:

```bash
rtk node /Users/bytedance/.agents/skills/impeccable/scripts/detect.mjs --json packages/dashboard/src/modules/traces/components/trace-status/trace-status.tsx
```

Expected: no blocking accessibility, theming, or component-system findings. Fix only findings within the Trace status scope, then rerun the focused test if code changes.

- [ ] **Step 7: Run repository preflight**

Run:

```bash
rtk bun run preflight
```

Expected: lint, formatting checks, type checks, and all unit tests pass.

- [ ] **Step 8: Commit the implementation**

Run:

```bash
rtk git add packages/dashboard/src/modules/traces/components/trace-status.tsx packages/dashboard/src/modules/traces/components/trace-status
rtk git commit -m "fix(dashboard): refine trace status badges" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Expected: one focused commit containing the file move, behavior regression test, five-state mapping, and theme-aware styling.
