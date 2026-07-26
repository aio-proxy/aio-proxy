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

describe('logs page filters and states', () => {
  test.each([
    ['loading', /Loading request logs|正在加载请求日志/u],
    ['empty', /No matching requests|没有匹配的请求/u],
    ['error', /Request logs unavailable|无法加载请求日志/u],
  ])('renders the %s state', (mode, name) => {
    mocks.mode = mode;
    render(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );
    expect(screen.queryByText(name) ?? screen.queryByLabelText(name)).toBeTruthy();
    mocks.mode = 'data';
  });

  test('applies an exact filter from More filters and resets pagination', async () => {
    const onSearchChange = rs.fn();
    render(
      <LogsPage
        search={{
          ...createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z')),
          page: 3,
          outcome: 'failure',
        }}
        onSearchChange={onSearchChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /More filters|更多筛选/u }));
    fireEvent.change(await screen.findByRole('textbox', { name: /Request ID|请求 ID/u }), {
      target: { value: 'request-exact' },
    });

    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, requestId: 'request-exact', outcome: 'failure' }),
    );
  });

  test('does not expose current-page filtering, sorting, or column controls', () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );

    expect(screen.queryByRole('textbox', { name: /Filter current page|筛选当前页/u })).toBeNull();
    expect(screen.queryByRole('button', { name: /Columns|列/u })).toBeNull();
    expect(screen.getByText(/Completed|完成时间/u).closest('button')).toBeNull();
  });
});

describe('logs page filter control sync', () => {
  test('updates common filter controls when search changes via navigation', () => {
    const { rerender } = render(
      <LogsPage
        search={{
          ...createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z')),
          requestedModelId: 'gpt-5',
          outcome: 'failure',
          inboundProtocol: 'openai-chat',
        }}
        onSearchChange={rs.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: /Requested model|请求模型/u })).toHaveValue('gpt-5');
    expect(screen.getByRole('combobox', { name: /Outcome|结果/u })).toHaveTextContent(/failure/u);
    expect(screen.getByRole('combobox', { name: /Protocol|协议/u })).toHaveTextContent(/openai-chat/u);

    rerender(
      <LogsPage search={createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z'))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByRole('textbox', { name: /Requested model|请求模型/u })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: /Outcome|结果/u })).not.toHaveTextContent(/failure/u);
    expect(screen.getByRole('combobox', { name: /Protocol|协议/u })).not.toHaveTextContent(/openai-chat/u);
  });

  test('resets all filters to defaults', () => {
    const onSearchChange = rs.fn();
    render(
      <LogsPage
        search={{ ...createDefaultLogsSearch(new Date('2026-07-12T08:00:00.000Z')), outcome: 'failure', page: 3 }}
        onSearchChange={onSearchChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Reset|重置/u }));

    expect(onSearchChange).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    expect(onSearchChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('outcome');
  });
});
