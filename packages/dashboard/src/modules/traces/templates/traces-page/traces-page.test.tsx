import type { DashboardTraceSummary } from '@aio-proxy/types';
import { beforeEach, describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { PropsWithChildren } from 'react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
import { DashboardTracesRequestError } from '../../services/traces-service';
import { TracesPage } from './traces-page';

const mocks = rs.hoisted(() => ({
  refetch: rs.fn(),
  querySearch: rs.fn(),
  data: undefined as
    | {
        items: DashboardTraceSummary[];
        nextPageToken?: string;
        prevPageToken?: string;
      }
    | undefined,
  error: null as Error | null,
  isFetching: false,
  isPlaceholderData: false,
  mobile: false,
}));

rs.mock('@aio-proxy/ui/hooks/use-mobile', () => ({
  useIsMobile: () => mocks.mobile,
}));
rs.mock('@aio-proxy/ui/components/sidebar', () => ({
  Sidebar: ({ children }: PropsWithChildren) => <aside data-slot="sidebar">{children}</aside>,
  SidebarHeader: ({ children }: PropsWithChildren) => <div data-slot="sidebar-header">{children}</div>,
  SidebarContent: ({ children }: PropsWithChildren) => <div data-slot="sidebar-content">{children}</div>,
}));
const terminalTrace: DashboardTraceSummary = {
  traceId: 'a'.repeat(32),
  rootSpanId: 'b'.repeat(16),
  requestId: 'request-terminal',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:00.125Z',
  durationMs: 125,
  stream: true,
  ttftMs: 42,
  otelStatusCode: 'ERROR',
  terminationReason: 'failure',
  session: { source: 'openai-prompt-cache', id: 'cache-a' },
  sessionResolvedBy: 'openai-prompt-cache',
  inboundProtocol: 'openai-response',
  requestedModelId: 'gpt-5',
  finalProviderId: 'provider-a',
  finalModelId: 'gpt-5.1',
  finalHttpStatus: 503,
  usage: {
    providerId: 'provider-a',
    modelId: 'gpt-5.1',
    inputTokens: 26_600,
    outputTokens: 318,
    totalTokens: 26_918,
    cacheReadTokens: 1_024,
    cacheWriteTokens: 64,
    estimatedCostUsd: 0.25,
  },
};
const runningTrace: DashboardTraceSummary = {
  traceId: 'c'.repeat(32),
  rootSpanId: 'd'.repeat(16),
  requestId: 'request-running',
  startedAt: '2026-07-12T08:01:00.000Z',
  endedAt: null,
  durationMs: 80,
  stream: false,
  otelStatusCode: 'UNSET',
  session: { source: 'header-session', id: 'session-b' },
  sessionResolvedBy: 'header-session',
  inboundProtocol: 'anthropic',
  requestedModelId: 'claude-sonnet',
};
const toolOnlyTrace: DashboardTraceSummary = {
  traceId: 'e'.repeat(32),
  rootSpanId: 'f'.repeat(16),
  requestId: 'request-tool-only',
  startedAt: '2026-07-12T08:02:00.000Z',
  endedAt: '2026-07-12T08:02:00.250Z',
  durationMs: 250,
  stream: true,
  otelStatusCode: 'UNSET',
  inboundProtocol: 'openai-response',
  requestedModelId: 'gpt-5',
  finalHttpStatus: 200,
};

rs.mock('../../hooks/use-traces-query', () => ({
  useTracesQuery: (search: unknown, autoRefresh: boolean) => {
    mocks.querySearch(search, autoRefresh);
    return {
      data: mocks.data,
      isLoading: false,
      isError: mocks.error !== null,
      error: mocks.error,
      isFetching: mocks.isFetching,
      isPlaceholderData: mocks.isPlaceholderData,
      refetch: mocks.refetch,
    };
  },
}));

describe('traces page', () => {
  beforeEach(() => {
    mocks.data = {
      items: [runningTrace, toolOnlyTrace, terminalTrace],
      prevPageToken: 'newer-token',
      nextPageToken: 'older-token',
    };
    mocks.error = null;
    mocks.isFetching = false;
    mocks.isPlaceholderData = false;
    mocks.mobile = false;
    mocks.querySearch.mockClear();
  });

  test('renders aligned latency and token details without the Session column', () => {
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'middle-token', pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );

    expect(screen.getByText(/Running|运行中/u)).toBeTruthy();
    expect(screen.getByText(/Failure|失败/u)).toBeTruthy();
    expect(screen.queryByText('cache-a')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /Final Provider ID|最终 Provider ID/u })).toBeTruthy();
    const modelCell = within(screen.getByRole('button', { name: new RegExp(terminalTrace.traceId, 'u') })).getAllByRole(
      'cell',
    )[4];
    expect(modelCell).toHaveTextContent('gpt-5');
    expect(modelCell).toHaveTextContent('gpt-5.1');
    const terminalCells = within(
      screen.getByRole('button', { name: new RegExp(terminalTrace.traceId, 'u') }),
    ).getAllByRole('cell');
    expect(terminalCells[5]).toHaveTextContent('provider-a');
    expect(terminalCells[8]).toHaveTextContent('26.6K');
    expect(terminalCells[8]).toHaveTextContent('318');
    expect(terminalCells[8]).toHaveTextContent('1K');
    expect(terminalCells[8]).toHaveTextContent('64');
    const runningTokenCell = within(
      screen.getByRole('button', { name: new RegExp(runningTrace.traceId, 'u') }),
    ).getAllByRole('cell')[8];
    expect(runningTokenCell).toHaveTextContent('—');
    expect(runningTokenCell).not.toHaveTextContent('N/A');
    const toolOnlyDurationCell = within(
      screen.getByRole('button', { name: new RegExp(toolOnlyTrace.traceId, 'u') }),
    ).getAllByRole('cell')[7];
    expect(toolOnlyDurationCell).toHaveTextContent('TTFT');
    expect(toolOnlyDurationCell).not.toHaveTextContent('N/A');
    expect(screen.getByText(/42 (ms|毫秒)/u)).toBeTruthy();
    expect(screen.getAllByText(/TTFT/u)).toHaveLength(2);
    expect(screen.getByText('$0.25')).toBeTruthy();
  });

  test('drives previous and next token navigation through URL search state', () => {
    const onSearchChange = rs.fn();
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'middle-token', pageSize: 20 }}
        onSearchChange={onSearchChange}
        onTraceSelect={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /previous|上一页|前へ|이전/iu }));
    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageToken: 'newer-token', pageSize: 20 }),
    );

    fireEvent.click(screen.getByRole('button', { name: /next|下一页|次へ|다음/iu }));

    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageToken: 'older-token', pageSize: 20 }),
    );
  });

  test('resets pagination when a trace filter changes', async () => {
    const onSearchChange = rs.fn();
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'stale-token', pageSize: 20, otelStatusCode: 'ERROR' }}
        onSearchChange={onSearchChange}
        onTraceSelect={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Filters|筛选/u }));
    fireEvent.click(screen.getByRole('button', { name: /^Request$|^请求$/u }));
    fireEvent.change(await screen.findByRole('textbox', { name: /Session ID|会话 ID/u }), {
      target: { value: 'cache-exact' },
    });

    const nextSearch = onSearchChange.mock.calls.at(-1)?.[0];
    expect(nextSearch).toEqual(expect.objectContaining({ sessionId: 'cache-exact', otelStatusCode: 'ERROR' }));
    expect(nextSearch).not.toHaveProperty('pageToken');
  });

  test('keeps an incomplete Trace ID as a draft until it is valid', async () => {
    const onSearchChange = rs.fn();
    mocks.querySearch.mockClear();
    const initialSearch = { ...createDefaultTraceSearch(), pageToken: 'stale-token' };
    const view = render(<TracesPage search={initialSearch} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Filters|筛选/u }));
    fireEvent.click(screen.getByRole('button', { name: /^Request$|^请求$/u }));
    const traceIdInput = await screen.findByRole('textbox', { name: /Trace ID|追踪 ID/u });
    fireEvent.change(traceIdInput, { target: { value: 'abc' } });

    expect(onSearchChange).not.toHaveBeenCalled();
    expect(mocks.querySearch).toHaveBeenLastCalledWith(initialSearch, true);
    expect(screen.getByRole('alert')).toHaveTextContent(/32-character lowercase hexadecimal|32 位小写十六进制/u);

    const traceId = 'a'.repeat(32);
    fireEvent.change(traceIdInput, { target: { value: traceId } });

    const validSearch = onSearchChange.mock.calls.at(-1)?.[0];
    expect(validSearch).toEqual(expect.objectContaining({ traceId }));
    expect(validSearch).not.toHaveProperty('pageToken');
    view.rerender(<TracesPage search={validSearch} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);
    expect(mocks.querySearch).toHaveBeenLastCalledWith(expect.objectContaining({ traceId }), true);
  });

  test('navigates a keyboard-selected row to its trace detail', () => {
    const onTraceSelect = rs.fn();
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'middle-token', pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={onTraceSelect}
      />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: new RegExp(runningTrace.traceId, 'u') }), { key: 'Enter' });

    expect(onTraceSelect).toHaveBeenCalledWith(runningTrace.traceId);
  });

  test('mounts desktop filters only after the list trigger opens them', () => {
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'middle-token', pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );

    expect(screen.queryByTestId('traces-filter-rail')).toBeNull();
    expect(document.querySelector('main main main')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Filters|筛选/u }));

    expect(screen.getByTestId('traces-filter-rail')).toBeTruthy();
    expect(screen.getByTestId('traces-filter-rail').closest('[data-slot="sidebar"]')).toBeTruthy();
  });

  test('opens the same filters in a mobile Sheet', () => {
    mocks.mobile = true;
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'middle-token', pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Filters|筛选/u }));

    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByTestId('traces-filter-rail')).toBeTruthy();
  });

  test('freezes the latest page across repeated polls and replaces it with the latest response on acceptance', () => {
    const initial = [runningTrace, terminalTrace];
    mocks.data = { items: initial, nextPageToken: 'older-initial' };
    const view = render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );

    const firstNew = { ...toolOnlyTrace, traceId: '1'.repeat(32) };
    mocks.data = {
      items: [firstNew, { ...runningTrace, endedAt: terminalTrace.endedAt }],
      nextPageToken: 'older-first',
    };
    view.rerender(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );
    expect(screen.getByText(terminalTrace.traceId)).toBeTruthy();
    expect(screen.queryByText(firstNew.traceId)).toBeNull();

    const latestNew = { ...toolOnlyTrace, traceId: '2'.repeat(32) };
    mocks.data = { items: [latestNew, firstNew], nextPageToken: 'older-latest' };
    view.rerender(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );

    const notice = screen.getByRole('button', { name: /new traces available:\s*2|新.*2|2.*新/iu });
    expect(screen.queryByText(latestNew.traceId)).toBeNull();
    fireEvent.click(notice);
    expect(screen.getByText(latestNew.traceId)).toBeTruthy();
    expect(screen.getByText(firstNew.traceId)).toBeTruthy();
    expect(screen.queryByText(terminalTrace.traceId)).toBeNull();
  });

  test('applies same-ID updates immediately unless a new-item notice freezes the snapshot', () => {
    mocks.data = { items: [runningTrace] };
    const search = { ...createDefaultTraceSearch(), pageSize: 20 as const };
    const view = render(<TracesPage search={search} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);

    mocks.data = {
      items: [{ ...runningTrace, endedAt: terminalTrace.endedAt }],
    };
    view.rerender(<TracesPage search={search} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);
    expect(screen.queryByText(/Running|运行中/u)).toBeNull();
    expect(screen.getByText(/Success|成功/u)).toBeTruthy();
  });

  test('resets buffering for filters and page-size changes and never buffers token pages', () => {
    const initialSearch = { ...createDefaultTraceSearch(), pageSize: 20 as const };
    mocks.data = { items: [runningTrace], nextPageToken: 'older-token' };
    const view = render(<TracesPage search={initialSearch} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);

    const filtered = { ...initialSearch, requestedModelId: 'new-filter' };
    mocks.data = { items: [terminalTrace] };
    view.rerender(<TracesPage search={filtered} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);
    expect(screen.getByText(terminalTrace.traceId)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new trace|新 Trace/u })).toBeNull();

    const resized = { ...filtered, pageSize: 50 as const };
    mocks.data = { items: [toolOnlyTrace] };
    view.rerender(<TracesPage search={resized} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);
    expect(screen.getByText(toolOnlyTrace.traceId)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new trace|新 Trace/u })).toBeNull();

    const pageTwo = { ...resized, pageToken: 'older-token' };
    const pageTwoTrace = { ...runningTrace, traceId: '3'.repeat(32) };
    mocks.data = { items: [pageTwoTrace], prevPageToken: 'newer-token' };
    view.rerender(<TracesPage search={pageTwo} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);
    expect(screen.getByText(pageTwoTrace.traceId)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new trace|新 Trace/u })).toBeNull();
  });

  test('isolates a frozen latest-page buffer immediately during placeholder search transitions', () => {
    const initialSearch = { ...createDefaultTraceSearch(), pageSize: 20 as const };
    mocks.data = { items: [runningTrace, terminalTrace], nextPageToken: 'older-token' };
    const view = render(<TracesPage search={initialSearch} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);

    const newTrace = { ...toolOnlyTrace, traceId: '4'.repeat(32) };
    mocks.data = { items: [newTrace, runningTrace], nextPageToken: 'older-updated' };
    view.rerender(<TracesPage search={initialSearch} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);
    expect(screen.getByRole('button', { name: /new traces available|新 Trace/iu })).toBeTruthy();
    expect(screen.getByText(terminalTrace.traceId)).toBeTruthy();
    expect(screen.queryByText(newTrace.traceId)).toBeNull();

    mocks.isPlaceholderData = true;
    const filteredSearch = { ...initialSearch, requestedModelId: 'filtered-model' };
    view.rerender(<TracesPage search={filteredSearch} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);
    expect(screen.queryByRole('button', { name: /new traces available|新 Trace/iu })).toBeNull();
    expect(screen.getByText(newTrace.traceId)).toBeTruthy();
    expect(screen.queryByText(terminalTrace.traceId)).toBeNull();

    const resizedPlaceholder = { ...toolOnlyTrace, traceId: '5'.repeat(32) };
    mocks.data = { items: [resizedPlaceholder] };
    view.rerender(
      <TracesPage search={{ ...filteredSearch, pageSize: 50 }} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />,
    );
    expect(screen.getByText(resizedPlaceholder.traceId)).toBeTruthy();
    expect(screen.queryByText(newTrace.traceId)).toBeNull();

    const pagePlaceholder = { ...runningTrace, traceId: '6'.repeat(32) };
    mocks.data = { items: [pagePlaceholder], prevPageToken: 'newer-token' };
    view.rerender(
      <TracesPage
        search={{ ...filteredSearch, pageToken: 'older-token', pageSize: 50 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );
    expect(screen.getByText(pagePlaceholder.traceId)).toBeTruthy();
    expect(screen.queryByText(resizedPlaceholder.traceId)).toBeNull();
  });

  test('retains the previous response while an adjacent token page is placeholder data', () => {
    const previousPage = { items: [runningTrace], nextPageToken: 'older-token' };
    mocks.data = previousPage;
    const latestSearch = { ...createDefaultTraceSearch(), pageSize: 20 as const };
    const view = render(<TracesPage search={latestSearch} onSearchChange={rs.fn()} onTraceSelect={rs.fn()} />);

    mocks.isPlaceholderData = true;
    view.rerender(
      <TracesPage
        search={{ ...latestSearch, pageToken: 'older-token' }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );

    expect(screen.getByText(runningTrace.traceId)).toBeTruthy();
    expect(screen.getByRole('button', { name: /next|下一页|次へ|다음/iu })).toBeDisabled();
  });

  test('canonicalizes a successful newest response to the token-free URL with replacement', () => {
    const onSearchChange = rs.fn();
    const search = {
      ...createDefaultTraceSearch(),
      pageToken: 'newer-token',
      requestedModelId: 'gpt-5',
    };
    mocks.data = { items: [runningTrace], nextPageToken: 'older-token' };

    render(<TracesPage search={search} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);

    expect(onSearchChange).toHaveBeenCalledWith(expect.objectContaining({ requestedModelId: 'gpt-5' }), {
      replace: true,
    });
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange.mock.calls[0]?.[0]).not.toHaveProperty('pageToken');
  });

  test('canonicalizes the same token again after returning to the token-free search', () => {
    const onSearchChange = rs.fn();
    const latestSearch = { ...createDefaultTraceSearch(), requestedModelId: 'gpt-5' };
    const tokenSearch = { ...latestSearch, pageToken: 'revisited-token' };
    mocks.data = { items: [runningTrace], nextPageToken: 'older-token' };
    const view = render(<TracesPage search={tokenSearch} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);

    view.rerender(<TracesPage search={latestSearch} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);
    view.rerender(<TracesPage search={tokenSearch} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);

    expect(onSearchChange).toHaveBeenCalledTimes(2);
    expect(onSearchChange).toHaveBeenNthCalledWith(1, latestSearch, { replace: true });
    expect(onSearchChange).toHaveBeenNthCalledWith(2, latestSearch, { replace: true });
  });

  test.each(['placeholder', 'failed'] as const)('does not canonicalize a %s token response', (state) => {
    const onSearchChange = rs.fn();
    mocks.data = { items: [runningTrace], nextPageToken: 'older-token' };
    mocks.isPlaceholderData = state === 'placeholder';
    mocks.error = state === 'failed' ? new DashboardTracesRequestError(503) : null;

    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'newer-token' }}
        onSearchChange={onSearchChange}
        onTraceSelect={rs.fn()}
      />,
    );

    expect(onSearchChange).not.toHaveBeenCalled();
  });

  test('clears an invalid page token while preserving filters', () => {
    const onSearchChange = rs.fn();
    mocks.error = new DashboardTracesRequestError(400);
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), pageToken: 'invalid-token', requestedModelId: 'gpt-5' }}
        onSearchChange={onSearchChange}
        onTraceSelect={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /reset|重置|リセット|초기화/iu }));

    expect(onSearchChange).toHaveBeenCalledWith(expect.objectContaining({ requestedModelId: 'gpt-5' }));
    expect(onSearchChange.mock.calls[0]?.[0]).not.toHaveProperty('pageToken');
  });
});
