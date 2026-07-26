import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

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

describe('logs page rendering', () => {
  test('renders request usage and opens ordered attempt details with the keyboard', () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByText('OpenRouter')).toBeTruthy();
    expect(screen.getByText('150')).toBeTruthy();
    const row = screen.getByRole('button', { name: /request-1/u });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByText('request-1')).toBeTruthy();
    expect(screen.getByText(/#1 · openrouter \/ openai\/gpt-5/u)).toBeTruthy();
  });

  test('renders display names and a redirected model in one column', () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByText('OpenRouter')).toBeTruthy();
    expect(screen.getByText('GPT Mini')).toBeTruthy();
    expect(screen.getAllByText('GPT-5')).toHaveLength(2);
    expect(screen.getByText('claude-sonnet')).toBeTruthy();
    expect(screen.getByText('legacy-model')).toBeTruthy();
    expect(screen.getAllByRole('columnheader', { name: /Model|模型/u })).toHaveLength(1);
  });

  test('uses distinct badge colors for successful and failed requests', () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByText(/Success|成功/u)).toHaveClass('bg-primary');
    expect(screen.getByText(/Failure|失败/u)).toHaveClass('bg-destructive/10');
  });
});

describe('logs page pagination controls', () => {
  test('renders rows per page inside the table pagination', () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByRole('combobox', { name: /Rows per page|每页行数/u })).toBeTruthy();
  });
});
