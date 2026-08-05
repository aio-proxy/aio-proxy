import type { DashboardTraceSummary } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import * as ReactTable from '@tanstack/react-table';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { TracesTable } from './traces-table';

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
      expect.stringMatching(/Request status|请求状态/u),
      expect.stringMatching(/Protocol|协议/u),
      expect.stringMatching(/Requested model|请求模型/u),
      expect.stringMatching(/Final Provider ID|最终 Provider ID/u),
      expect.stringMatching(/Final HTTP status|最终 HTTP 状态/u),
      expect.stringMatching(/Latency|延迟/u),
      expect.stringMatching(/Tokens|Token/u),
      expect.stringMatching(/cost|成本/iu),
    ]);
    expect(screen.queryByRole('columnheader', { name: /Session|会话/u })).toBeNull();

    const cells = within(screen.getByRole('button', { name: new RegExp(trace.traceId, 'u') })).getAllByRole('cell');
    expect(cells[0].querySelector('time')).toHaveAttribute('datetime', trace.startedAt);
    expect(cells[1]).toHaveTextContent(trace.traceId);
    expect(cells[3]).toHaveTextContent(trace.inboundProtocol);
    expect(cells[3].querySelector('[data-slot="badge"]')).toBeNull();
    expect(view.container.querySelector('[data-column-controls]')).toBeNull();
  });

  test('shows requested and upstream models on two lines only when distinct', () => {
    const view = renderTable();
    const modelCell = within(screen.getByRole('button', { name: new RegExp(trace.traceId, 'u') })).getAllByRole(
      'cell',
    )[4];
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
    )[4];
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

    expect(screen.getByRole('button', { name: /previous|上一页|前へ|이전/iu })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next|下一页|次へ|다음/iu })).toBeEnabled();

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

    expect(screen.getByRole('button', { name: /previous|上一页|前へ|이전/iu })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next|下一页|次へ|다음/iu })).toBeDisabled();
  });

  test('keeps TanStack Table data stable across unrelated parent rerenders', () => {
    const data = { items: [trace] };
    const useReactTable = rs.spyOn(ReactTable, 'useReactTable');
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
    const firstTableData = useReactTable.mock.calls.at(-1)?.[0].data;

    view.rerender(<TracesTable {...props} />);

    expect(useReactTable.mock.calls.at(-1)?.[0].data).toBe(firstTableData);
    useReactTable.mockRestore();
  });
});
