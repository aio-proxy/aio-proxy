import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { format } from 'date-fns';

import { createDefaultLogsSearch } from '../../logs-search';
import { LogsPage } from './logs-page';

const mocks = rs.hoisted(() => ({ refetch: rs.fn(), mode: 'data' }));

rs.mock('../../hooks/use-logs-query', () => ({
  useLogsQuery: () =>
    mocks.mode === 'loading'
      ? { isLoading: true, isError: false, isFetching: false, refetch: mocks.refetch }
      : mocks.mode === 'error'
        ? { isLoading: false, isError: true, isFetching: false, refetch: mocks.refetch }
        : {
            data: {
              page: 1,
              pageSize: 50,
              total: 3,
              pageCount: 1,
              items: [
                {
                  requestId: 'request-1',
                  inboundProtocol: 'openai-compatible',
                  requestedModelId: 'mini',
                  requestedModelDisplayName: 'GPT Mini',
                  outcome: 'success',
                  finalProviderId: 'openrouter',
                  finalProviderName: 'OpenRouter',
                  finalModelId: 'openai/gpt-5',
                  finalModelDisplayName: 'GPT-5',
                  finalStatusCode: 200,
                  attempts: [
                    {
                      index: 0,
                      providerId: 'openrouter',
                      modelId: 'openai/gpt-5',
                      providerKind: 'api',
                      protocol: 'openai-compatible',
                      outcome: 'success',
                      statusCode: 200,
                      durationMs: 80,
                    },
                  ],
                  startedAt: '2026-07-12T07:59:59.900Z',
                  completedAt: '2026-07-12T08:00:00.000Z',
                  durationMs: 100,
                  usage: {
                    providerId: 'openrouter',
                    modelId: 'openai/gpt-5',
                    inputTokens: 100,
                    outputTokens: 50,
                    totalTokens: 150,
                    estimatedCostUsd: 0.25,
                  },
                },
                {
                  requestId: 'request-2',
                  inboundProtocol: 'anthropic',
                  requestedModelId: 'claude-sonnet',
                  outcome: 'failure',
                  finalProviderId: 'backup',
                  finalModelId: 'claude-sonnet',
                  finalStatusCode: 503,
                  attempts: [],
                  startedAt: '2026-07-12T08:00:00.900Z',
                  completedAt: '2026-07-12T08:00:01.000Z',
                  durationMs: 100,
                },
                {
                  requestId: 'request-3',
                  inboundProtocol: 'openai-compatible',
                  requestedModelId: 'legacy-model',
                  outcome: 'cancelled',
                  finalProviderId: 'openrouter',
                  finalModelId: 'openai/gpt-5',
                  finalModelDisplayName: 'GPT-5',
                  finalStatusCode: 200,
                  attempts: [],
                  startedAt: '2026-07-12T08:00:01.900Z',
                  completedAt: '2026-07-12T08:00:02.000Z',
                  durationMs: 100,
                },
              ],
            },
            isLoading: false,
            isError: false,
            isFetching: false,
            refetch: mocks.refetch,
            ...(mocks.mode === 'empty' ? { data: { page: 1, pageSize: 50, total: 0, pageCount: 0, items: [] } } : {}),
          },
}));

describe('logs page time range and refresh', () => {
  test('manually refreshes without changing the search', () => {
    const onSearchChange = rs.fn();
    render(
      <LogsPage
        search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))}
        onSearchChange={onSearchChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Refresh|刷新/u }));
    expect(mocks.refetch).toHaveBeenCalled();
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  test('opens one shared date time calendar with the Logs presets', async () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Time range|时间范围/u }));

    expect(await screen.findAllByTestId('date-time-range-calendar')).toHaveLength(1);
    for (const name of [
      /Last 15 minutes|最近 15 分钟/u,
      /Last 1 hour|最近 1 小时/u,
      /Last 3 hours|最近 3 小时/u,
      /Last 6 hours|最近 6 小时/u,
      /Last 12 hours|最近 12 小时/u,
      /Last 24 hours|最近 24 小时/u,
      /Last 3 days|最近 3 天/u,
      /Last 7 days|最近 7 天/u,
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});

describe('logs page time range apply', () => {
  test('applies exact typed times and resets pagination', async () => {
    const onSearchChange = rs.fn();
    const target = new Date();
    target.setDate(target.getDate() - 1);
    const from = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 8, 15);
    const to = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 9, 45);
    render(
      <LogsPage
        search={{ ...createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z')), page: 3 }}
        onSearchChange={onSearchChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Time range|时间范围/u }));
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: format(from, 'yyyy-MM-dd HH:mm') },
    });
    fireEvent.change(screen.getByLabelText(/End|结束时间/u), {
      target: { value: format(to, 'yyyy-MM-dd HH:mm') },
    });
    fireEvent.click(screen.getByRole('button', { name: /Apply|应用/u }));

    await waitFor(() => expect(onSearchChange).toHaveBeenCalledTimes(1));
    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 1,
        startedAfter: from.toISOString(),
        completedBefore: new Date(to.getFullYear(), to.getMonth(), to.getDate(), 9, 45, 59, 999).toISOString(),
      }),
    );
  });
});
