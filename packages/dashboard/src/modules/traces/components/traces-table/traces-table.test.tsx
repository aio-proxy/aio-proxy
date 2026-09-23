import type { DashboardPluginSummary, DashboardTraceSummary } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as ReactTable from '@tanstack/react-table';
import { fireEvent, render as renderRtl, screen, within } from '@testing-library/react';

import { providerStub } from '@/lib/provider-fixtures';
import { queryKeys } from '@/lib/query-keys';

import { TracesTable } from './traces-table';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
const render: typeof renderRtl = (ui, options) =>
  renderRtl(ui, {
    ...options,
    wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });

const trace: DashboardTraceSummary = {
  traceId: 'a'.repeat(32),
  rootSpanId: 'b'.repeat(16),
  requestId: 'request-a',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:00.125Z',
  durationMs: 125,
  stream: true,
  ttftMs: 42,
  otelStatusCode: 'UNSET',
  inboundProtocol: 'openai-response',
  requestedModelId: 'requested-model',
  finalProviderId: 'provider-a',
  finalModelId: 'upstream-model',
  finalHttpStatus: 200,
};

const renderTable = (item = trace) =>
  render(
    <TracesTable
      data={{ items: [item], prevPageToken: 'newer-token', nextPageToken: 'older-token' }}
      isFetching={false}
      newItemsCount={0}
      onAcceptNewItems={rs.fn()}
      onPrevious={rs.fn()}
      onNext={rs.fn()}
      onSelect={rs.fn()}
    />,
  );

describe('traces table', () => {
  test('renders the exact server-paginated columns with absolute start time before Trace ID', () => {
    const view = renderTable();

    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual([
      expect.stringMatching(/Started|开始/u),
      'Trace ID',
      expect.stringMatching(/Protocol|协议/u),
      expect.stringMatching(/Model|模型/u),
      expect.stringMatching(/^(Provider|提供商|プロバイダー|프로바이더)$/u),
      expect.stringMatching(/HTTP status|HTTP 状态/u),
      expect.stringMatching(/Status|状态/u),
      expect.stringMatching(/Latency|延迟/u),
      expect.stringMatching(/Tokens|Token/u),
      expect.stringMatching(/cost|成本/iu),
    ]);
    expect(screen.queryByRole('columnheader', { name: /Session|会话/u })).toBeNull();

    const cells = within(screen.getByRole('button', { name: new RegExp(trace.traceId, 'u') })).getAllByRole('cell');
    expect(cells[0].querySelector('time')).toHaveAttribute('datetime', trace.startedAt);
    expect(cells[1]).toHaveTextContent(trace.traceId);
    expect(cells[2]).toHaveTextContent(trace.inboundProtocol);
    expect(cells[2].querySelector('[data-slot="badge"]')).toBeNull();
    expect(view.container.querySelector('[data-column-controls]')).toBeNull();
  });

  test('shows requested and upstream models on two lines only when distinct', () => {
    const view = renderTable();
    const modelCell = within(screen.getByRole('button', { name: new RegExp(trace.traceId, 'u') })).getAllByRole(
      'cell',
    )[3];
    expect(modelCell.children).toHaveLength(2);
    expect(modelCell).toHaveTextContent('requested-model');
    expect(modelCell).toHaveTextContent('upstream-model');

    view.rerender(
      <TracesTable
        data={{ items: [{ ...trace, finalModelId: trace.requestedModelId }] }}
        isFetching={false}
        newItemsCount={0}
        onAcceptNewItems={rs.fn()}
        onPrevious={rs.fn()}
        onNext={rs.fn()}
        onSelect={rs.fn()}
      />,
    );
    const sameModelCell = within(screen.getByRole('button', { name: new RegExp(trace.traceId, 'u') })).getAllByRole(
      'cell',
    )[3];
    expect(sameModelCell.children).toHaveLength(1);
    expect(sameModelCell).toHaveTextContent('requested-model');
  });

  test('navigates only with response-provided previous and next tokens', () => {
    const onPrevious = rs.fn();
    const onNext = rs.fn();
    render(
      <TracesTable
        data={{ items: [trace], prevPageToken: 'newer-token', nextPageToken: 'older-token' }}
        isFetching={false}
        newItemsCount={0}
        onAcceptNewItems={rs.fn()}
        onPrevious={onPrevious}
        onNext={onNext}
        onSelect={rs.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /previous|上一页|前へ|이전/iu }));
    fireEvent.click(screen.getByRole('button', { name: /next|下一页|次へ|다음/iu }));

    expect(onPrevious).toHaveBeenCalledWith('newer-token');
    expect(onNext).toHaveBeenCalledWith('older-token');
    expect(screen.queryByText(/page\s+\d|第\s*\d\s*页/iu)).toBeNull();
  });

  test('disables unavailable token directions and all navigation while loading', () => {
    const view = render(
      <TracesTable
        data={{ items: [trace], nextPageToken: 'older-token' }}
        isFetching={false}
        newItemsCount={0}
        onAcceptNewItems={rs.fn()}
        onPrevious={rs.fn()}
        onNext={rs.fn()}
        onSelect={rs.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /previous|上一页|前へ|이전/iu })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: /next|下一页|次へ|다음/iu })).not.toHaveAttribute('aria-disabled');

    view.rerender(
      <TracesTable
        data={{ items: [trace], prevPageToken: 'newer-token', nextPageToken: 'older-token' }}
        isFetching
        newItemsCount={0}
        onAcceptNewItems={rs.fn()}
        onPrevious={rs.fn()}
        onNext={rs.fn()}
        onSelect={rs.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /previous|上一页|前へ|이전/iu })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: /next|下一页|次へ|다음/iu })).toHaveAttribute('aria-disabled', 'true');
  });

  test('keeps TanStack Table data stable across unrelated parent rerenders', () => {
    const data = { items: [trace] };
    const useTable = rs.spyOn(ReactTable, 'useTable');
    const props = {
      data,
      isFetching: false,
      newItemsCount: 0,
      onAcceptNewItems: rs.fn(),
      onPrevious: rs.fn(),
      onNext: rs.fn(),
      onSelect: rs.fn(),
    };
    const view = render(<TracesTable {...props} />);
    const firstTableData = useTable.mock.calls.at(-1)?.[0].data;

    view.rerender(<TracesTable {...props} />);

    expect(useTable.mock.calls.at(-1)?.[0].data).toBe(firstTableData);
    useTable.mockRestore();
  });

  test('renders a known Provider by its display name and keeps the ID on the hover title', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.providers, {
      providers: [providerStub({ id: 'provider-a', name: 'Carpool' })],
      routingRevision: '1',
    });
    client.setQueryData(queryKeys.plugins, { plugins: [] });
    renderRtl(
      <QueryClientProvider client={client}>
        <TracesTable
          data={{ items: [trace] }}
          isFetching={false}
          pageSize={20}
          newItemsCount={0}
          onAcceptNewItems={rs.fn()}
          onShowSizeChange={rs.fn()}
          onPrevious={rs.fn()}
          onNext={rs.fn()}
          onSelect={rs.fn()}
        />
      </QueryClientProvider>,
    );

    const label = screen.getByTitle('provider-a');
    expect(label).toHaveTextContent('Carpool');
    expect(label.textContent).toBe('Carpool');
    expect(within(label).queryByText('C')).toBeNull();
    expect(screen.queryByText('provider-a')).toBeNull();
  });

  test('shows OAuth services with their account labels without repeating identical names', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.providers, {
      providers: [
        providerStub({
          id: 'chatgpt-provider',
          plugin: '@aio-proxy/plugin-openai-chatgpt',
          capability: 'default',
          accountLabel: 'shared@example.com',
        }),
        providerStub({
          id: 'grok-provider',
          plugin: '@aio-proxy/plugin-xai-grok',
          capability: 'default',
          accountLabel: 'shared@example.com',
        }),
        providerStub({
          id: 'openrouter-provider',
          plugin: '@aio-proxy/plugin-openrouter',
          capability: 'default',
          accountLabel: 'OpenRouter',
        }),
      ],
      routingRevision: '1',
    });
    client.setQueryData(queryKeys.plugins, {
      plugins: [
        {
          packageName: '@aio-proxy/plugin-openai-chatgpt',
          displayName: 'OpenAI ChatGPT',
          builtin: true,
          enabled: true,
          hasOptions: false,
          state: { status: 'ready' },
        },
        {
          packageName: '@aio-proxy/plugin-xai-grok',
          displayName: 'xAI Grok',
          builtin: true,
          enabled: true,
          hasOptions: false,
          state: { status: 'ready' },
        },
        {
          packageName: '@aio-proxy/plugin-openrouter',
          displayName: 'OpenRouter',
          builtin: true,
          enabled: true,
          hasOptions: false,
          state: { status: 'ready' },
        },
      ] satisfies DashboardPluginSummary[],
    });
    const grokTrace = { ...trace, traceId: 'c'.repeat(32), finalProviderId: 'grok-provider' };
    const openrouterTrace = { ...trace, traceId: 'd'.repeat(32), finalProviderId: 'openrouter-provider' };
    renderRtl(
      <QueryClientProvider client={client}>
        <TracesTable
          data={{ items: [{ ...trace, finalProviderId: 'chatgpt-provider' }, grokTrace, openrouterTrace] }}
          isFetching={false}
          pageSize={20}
          newItemsCount={0}
          onAcceptNewItems={rs.fn()}
          onShowSizeChange={rs.fn()}
          onPrevious={rs.fn()}
          onNext={rs.fn()}
          onSelect={rs.fn()}
        />
      </QueryClientProvider>,
    );

    const chatgptCell = within(screen.getByRole('button', { name: new RegExp(trace.traceId, 'u') })).getAllByRole(
      'cell',
    )[4];
    const grokCell = within(screen.getByRole('button', { name: new RegExp(grokTrace.traceId, 'u') })).getAllByRole(
      'cell',
    )[4];
    const openrouterCell = within(
      screen.getByRole('button', { name: new RegExp(openrouterTrace.traceId, 'u') }),
    ).getAllByRole('cell')[4];
    expect(chatgptCell).toHaveTextContent('OpenAI ChatGPT');
    expect(chatgptCell).toHaveTextContent('shared@example.com');
    expect(grokCell).toHaveTextContent('xAI Grok');
    expect(grokCell).toHaveTextContent('shared@example.com');
    expect(openrouterCell.textContent).toBe('OpenRouter');
  });
});
