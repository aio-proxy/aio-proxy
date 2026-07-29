import type { DashboardTraceSummary } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../trace-search';
import { TracesPage } from './traces-page';

const mocks = rs.hoisted(() => ({ refetch: rs.fn(), querySearch: rs.fn() }));
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
      data: { items: [runningTrace, toolOnlyTrace, terminalTrace], page: 2, pageSize: 20, total: 42, pageCount: 3 },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: mocks.refetch,
    };
  },
}));

describe('traces page', () => {
  test('renders TTFT only when a streamed trace has a first content token', async () => {
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), page: 2, pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={rs.fn()}
      />,
    );

    expect(screen.getByText(/Running|运行中/u)).toBeTruthy();
    expect(screen.getByText(/Failure|失败/u)).toBeTruthy();
    expect(screen.queryByText(/Final|最终/u)).toBeNull();
    const sessionId = screen.getByText('cache-a');
    expect(screen.queryByText('openai-prompt-cache')).toBeNull();
    fireEvent.focus(sessionId);
    expect(await screen.findByText(/Session source: openai-prompt-cache|会话来源：openai-prompt-cache/u)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /^(Provider|提供商)$/u })).toBeTruthy();
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
    expect(toolOnlyDurationCell).not.toHaveTextContent('TTFT');
    expect(toolOnlyDurationCell).not.toHaveTextContent('N/A');
    expect(screen.getByText(/42 (ms|毫秒)/u)).toBeTruthy();
    expect(screen.getAllByText(/TTFT/u)).toHaveLength(1);
    expect(screen.getByText('$0.25')).toBeTruthy();
  });

  test('drives server pagination through URL search state', () => {
    const onSearchChange = rs.fn();
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), page: 2, pageSize: 20 }}
        onSearchChange={onSearchChange}
        onTraceSelect={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Next|下一页/u }));

    expect(onSearchChange).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3, pageSize: 20 }));
  });

  test('resets pagination when a trace filter changes', async () => {
    const onSearchChange = rs.fn();
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), page: 3, pageSize: 20, otelStatusCode: 'ERROR' }}
        onSearchChange={onSearchChange}
        onTraceSelect={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /More filters|更多筛选/u }));
    fireEvent.change(await screen.findByRole('textbox', { name: /Session ID|会话 ID/u }), {
      target: { value: 'cache-exact' },
    });

    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, sessionId: 'cache-exact', otelStatusCode: 'ERROR' }),
    );
  });

  test('keeps an incomplete Trace ID as a draft until it is valid', async () => {
    const onSearchChange = rs.fn();
    mocks.querySearch.mockClear();
    const initialSearch = { ...createDefaultTraceSearch(), page: 3 };
    const view = render(<TracesPage search={initialSearch} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /More filters|更多筛选/u }));
    const traceIdInput = await screen.findByRole('textbox', { name: /Trace ID|追踪 ID/u });
    fireEvent.change(traceIdInput, { target: { value: 'abc' } });

    expect(onSearchChange).not.toHaveBeenCalled();
    expect(mocks.querySearch).toHaveBeenCalledTimes(1);
    expect(mocks.querySearch).toHaveBeenLastCalledWith(initialSearch, true);
    expect(screen.getByRole('alert')).toHaveTextContent(/32-character lowercase hexadecimal|32 位小写十六进制/u);

    const traceId = 'a'.repeat(32);
    fireEvent.change(traceIdInput, { target: { value: traceId } });

    const validSearch = onSearchChange.mock.calls.at(-1)?.[0];
    expect(validSearch).toEqual(expect.objectContaining({ page: 1, traceId }));
    view.rerender(<TracesPage search={validSearch} onSearchChange={onSearchChange} onTraceSelect={rs.fn()} />);
    expect(mocks.querySearch).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, traceId }), true);
  });

  test('navigates a keyboard-selected row to its trace detail', () => {
    const onTraceSelect = rs.fn();
    render(
      <TracesPage
        search={{ ...createDefaultTraceSearch(), page: 2, pageSize: 20 }}
        onSearchChange={rs.fn()}
        onTraceSelect={onTraceSelect}
      />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: new RegExp(runningTrace.traceId, 'u') }), { key: 'Enter' });

    expect(onTraceSelect).toHaveBeenCalledWith(runningTrace.traceId);
  });
});
