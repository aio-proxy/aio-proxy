# Trace Detail Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Trace detail navigation and summary metadata concise while displaying successful completed traces with user-facing status semantics.

**Architecture:** Keep TraceStore, persisted OpenTelemetry values, Dashboard API DTOs, and raw OTel filters unchanged. Derive operational status and consolidated summary values inside the existing Dashboard components, using shared `PageContainer`, `Button`, and Base UI Tooltip primitives.

**Tech Stack:** React 19, TypeScript, TanStack Router, Base UI Tooltip, Paraglide i18n, Rstest, Testing Library, Bun.

## Global Constraints

- Do not change TraceStore, server routes, DTO schemas, database tables, or migrations.
- Keep raw `UNSET` / `OK` / `ERROR` values available to API consumers and Trace filters.
- All new user-facing labels and tooltip copy must exist in both `packages/i18n/messages/en.json` and `packages/i18n/messages/zh-Hans.json`.
- Reuse `PageContainer`, `Button`, `Badge`, and `Tooltip`; add no new UI primitive or dependency.
- Follow strict RED → GREEN TDD and run each focused test before its implementation.
- Do not edit generated `packages/dashboard/src/route-tree.gen.ts`.

---

### Task 1: Display operational Trace status

**Files:**
- Modify: `packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/trace-status.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Consumes: `endedAt`, `otelStatusCode`, and `terminationReason` from `DashboardTraceSummary` or `DashboardTraceSpan`.
- Produces: the existing `TraceStatus` React component with one operational Badge and the same props.

- [ ] **Step 1: Write the failing success-status test**

Add this behavior test to `trace-detail-page.test.tsx`. It catches a regression where an ended successful Trace exposes raw OTel `UNSET` instead of a user-facing success label.

```tsx
test('renders a completed UNSET Trace as successful', () => {
  mocks.data = {
    ...detail,
    trace: {
      ...detail.trace,
      otelStatusCode: 'UNSET',
      terminationReason: undefined,
      errorType: undefined,
      errorCode: undefined,
      finalHttpStatus: 200,
    },
    spans: detail.spans.map((span) => ({
      ...span,
      otelStatusCode: 'UNSET',
      terminationReason: undefined,
    })),
  };

  render(<TraceDetailPage traceId={traceId} />);

  expect(screen.getAllByText(/Success|成功/u).length).toBeGreaterThan(0);
  expect(screen.queryByText(/UNSET|未设置/u)).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx
```

Expected: FAIL because the completed fixture renders `UNSET` / `未设置` and no `Success` / `成功` label.

- [ ] **Step 3: Add the success copy and compile i18n**

Add next to the existing Trace status messages:

```json
// packages/i18n/messages/en.json
"success": "Success"
```

```json
// packages/i18n/messages/zh-Hans.json
"success": "成功"
```

Run:

```bash
bun run i18n:compile
```

Expected: the Paraglide compile and TypeScript build complete successfully.

- [ ] **Step 4: Replace raw OTel rendering with one operational status**

Replace the status maps and JSX in `trace-status.tsx` with this mapping. Keep `TraceStatusProps` unchanged.

```tsx
type DisplayStatus = 'running' | 'success' | 'failure' | 'cancelled' | 'interrupted' | 'error';

const statusLabels: Record<DisplayStatus, () => string> = {
  running: m['dashboard.traces.running'],
  success: m['dashboard.traces.success'],
  failure: m['dashboard.traces.failure'],
  cancelled: m['dashboard.traces.cancelled'],
  interrupted: m['dashboard.traces.interrupted'],
  error: m['dashboard.traces.otel_error'],
};

const statusVariants = {
  running: 'secondary',
  success: 'default',
  failure: 'destructive',
  cancelled: 'outline',
  interrupted: 'outline',
  error: 'destructive',
} as const satisfies Record<DisplayStatus, 'secondary' | 'default' | 'destructive' | 'outline'>;

const displayStatus = (item: TraceStatusProps['item']): DisplayStatus => {
  if (item.endedAt === null) return 'running';
  if (item.terminationReason !== undefined) return item.terminationReason;
  return item.otelStatusCode === 'ERROR' ? 'error' : 'success';
};

export const TraceStatus: React.FC<TraceStatusProps> = ({ item, className }) => {
  const status = displayStatus(item);
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      <Badge variant={statusVariants[status]}>{statusLabels[status]()}</Badge>
    </div>
  );
};
```

Remove the unused raw-status imports, `traceStatusLabel`, and the second termination-reason Badge.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same focused command from Step 2.

Expected: all Trace detail page tests pass; the success regression test finds `Success` / `成功` and no raw `UNSET` label.

- [ ] **Step 6: Commit the status behavior**

```bash
git add packages/dashboard/src/modules/traces/components/trace-status.tsx packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
git commit -m "fix(dashboard): display operational trace status" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Distill Trace detail navigation and summary metadata

**Files:**
- Modify: `packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/trace-summary.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Consumes: the existing `DashboardTraceSummary` fields and `onSessionSelect({ source, id })` callback.
- Produces: the existing `TraceSummary` component with one Session row, one Model row, one Result details row, and unchanged Session-filter navigation.

- [ ] **Step 1: Extend the router mock and add failing behavior tests**

Replace the router mock so the real page can render its existing `PageContainer` back link:

```tsx
rs.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    children,
    preload: _preload,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    readonly to: string;
    readonly preload?: string;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));
```

Add a small test helper:

```tsx
const summaryRow = (label: RegExp): HTMLElement => {
  const row = screen.getByText(label).closest('div');
  if (row === null) throw new Error(`Missing summary row: ${label.source}`);
  return row;
};
```

Add these tests. They catch removal of the back link, reintroduction of duplicate Session/model fields, missing upstream-model disclosure, and split result metadata.

```tsx
test.each(['terminal', 'loading', 'not-found', 'error'])(
  'links the %s state back to the Trace list',
  (mode) => {
    mocks.mode = mode;
    render(<TraceDetailPage traceId={traceId} />);
    expect(screen.getByRole('link', { name: /Back|返回/u })).toHaveAttribute('href', '/traces');
  },
);

test('shows only the Session ID and discloses its source in a tooltip', async () => {
  render(<TraceDetailPage traceId={traceId} />);

  const session = screen.getByRole('button', { name: 'cache-a' });
  expect(within(screen.getByTestId('trace-summary')).queryByText('openai-prompt-cache')).toBeNull();

  fireEvent.focus(session);
  expect(await screen.findByText(/Session source: openai-prompt-cache|会话来源：openai-prompt-cache/u)).toBeTruthy();
});

test('shows the requested model and discloses a different upstream model', async () => {
  render(<TraceDetailPage traceId={traceId} />);

  const row = summaryRow(/^Model$|^模型$/u);
  const requestedModel = within(row).getByText('gpt-5');
  expect(within(row).queryByText('gpt-5.1')).toBeNull();

  fireEvent.focus(requestedModel);
  expect(await screen.findByText(/Upstream model: gpt-5.1|上游模型：gpt-5.1/u)).toBeTruthy();
});

test('does not add an upstream-model tooltip when models match', () => {
  mocks.data = { ...detail, trace: { ...detail.trace, finalModelId: 'gpt-5' } };
  render(<TraceDetailPage traceId={traceId} />);

  fireEvent.focus(within(summaryRow(/^Model$|^模型$/u)).getByText('gpt-5'));
  expect(screen.queryByText(/Upstream model|上游模型/u)).toBeNull();
});

test('combines HTTP and error metadata into one result row', () => {
  render(<TraceDetailPage traceId={traceId} />);

  const row = summaryRow(/Result details|结果详情/u);
  expect(within(row).getByText('HTTP 503 · upstream_error · provider_unavailable')).toBeTruthy();
  expect(screen.queryByText(/Final HTTP status|最终 HTTP 状态码/u)).toBeNull();
  expect(screen.queryByText(/Error type|错误类型/u)).toBeNull();
  expect(screen.queryByText(/Error code|错误码/u)).toBeNull();
});
```

Update the existing Session-navigation test to click `screen.getByRole('button', { name: 'cache-a' })`; retain its exact `sessionSource` and `sessionId` navigation assertion.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx
```

Expected: FAIL because there is no back link, Session source is visible twice, requested/final models are separate rows, and result metadata is split across three rows.

- [ ] **Step 3: Add consolidated summary copy and compile i18n**

Add these keys inside `dashboard.traces`:

```json
// packages/i18n/messages/en.json
"model": "Model",
"result_details": "Result details",
"session_source_value": "Session source: {source}",
"upstream_model_value": "Upstream model: {model}",
"http_status_value": "HTTP {status}"
```

```json
// packages/i18n/messages/zh-Hans.json
"model": "模型",
"result_details": "结果详情",
"session_source_value": "会话来源：{source}",
"upstream_model_value": "上游模型：{model}",
"http_status_value": "HTTP {status}"
```

Run `bun run i18n:compile` and require a successful build.

- [ ] **Step 4: Consolidate the Trace summary values**

Import the shared Tooltip primitives in `trace-summary.tsx`:

```tsx
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
```

Before `summaryRows`, derive the three display values:

```tsx
const sessionValue =
  trace.session === undefined ? undefined : (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="link"
            className="h-auto max-w-full justify-end px-0 py-0 text-right whitespace-normal"
            onClick={() => onSessionSelect(trace.session!)}
          />
        }
      >
        {trace.session.id}
      </TooltipTrigger>
      <TooltipContent>
        {m['dashboard.traces.session_source_value']({ source: trace.session.source })}
      </TooltipContent>
    </Tooltip>
  );

const displayedModel = trace.requestedModelId ?? trace.finalModelId;
const upstreamModel =
  trace.requestedModelId !== undefined &&
  trace.finalModelId !== undefined &&
  trace.requestedModelId !== trace.finalModelId
    ? trace.finalModelId
    : undefined;
const modelValue =
  displayedModel === undefined || upstreamModel === undefined ? (
    displayedModel
  ) : (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-4" />}>
        {displayedModel}
      </TooltipTrigger>
      <TooltipContent>{m['dashboard.traces.upstream_model_value']({ model: upstreamModel })}</TooltipContent>
    </Tooltip>
  );

const resultDetails = [
  trace.finalHttpStatus === undefined
    ? undefined
    : m['dashboard.traces.http_status_value']({ status: trace.finalHttpStatus }),
  trace.errorType,
  trace.errorCode,
]
  .filter((value): value is string => value !== undefined)
  .join(' · ');
```

Replace the duplicate rows with:

```tsx
[m['dashboard.traces.session'](), sessionValue],
[m['dashboard.traces.protocol'](), <ProtocolLabel key="protocol" protocol={trace.inboundProtocol} />],
[m['dashboard.traces.model'](), modelValue],
[m['dashboard.traces.final_provider'](), trace.finalProviderId],
[m['dashboard.traces.result_details'](), resultDetails === '' ? undefined : resultDetails],
```

Remove the `sessionResolvedBy`, requested-model, final-model, final-HTTP-status, error-type, and error-code rows. Keep all identifiers, timing rows, Provider, protocol, usage, and Session navigation behavior.

- [ ] **Step 5: Enable the existing back action in every page state**

Add `backTo="/traces"` to all three `PageContainer` usages in `trace-detail-page.tsx`:

```tsx
<PageContainer
  title={m['dashboard.traces.detail_title']()}
  subtitle={traceId}
  extra={refresh}
  backTo="/traces"
>
```

Use `trace.traceId` for the loaded state's existing subtitle. Do not create another navigation component.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Trace detail test command from Step 2.

Then run all Trace module tests:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces
```

Expected: all tests pass, including existing Span selection, loading/error states, and Session-filter navigation.

- [ ] **Step 7: Run the UI quality gate and full repository verification**

Run the Impeccable detector once over the changed UI files:

```bash
node /Users/bytedance/.agents/skills/impeccable/scripts/detect.mjs --json packages/dashboard/src/modules/traces/components/trace-status.tsx packages/dashboard/src/modules/traces/components/trace-summary.tsx packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.tsx
```

Expected: `[]`. If it reports a finding, fix only the reported issue and rerun the affected focused test before rerunning the detector.

Run:

```bash
bun run preflight
```

Expected: type-aware lint, formatting, builds, unit tests, and artifact tests complete with exit code 0.

- [ ] **Step 8: Commit the summary refinement**

```bash
git add packages/dashboard/src/modules/traces/components/trace-summary.tsx packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.tsx packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
git commit -m "refactor(dashboard): distill trace detail summary" -m "Co-authored-by: Codex <noreply@openai.com>"
```
