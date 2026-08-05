import type { DashboardTraceSummary } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';

import { createDefaultTraceSearch } from '../../lib/trace-search';
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
      data={{ items: [item], pageCount: 3 }}
      search={{ ...createDefaultTraceSearch(), pageSize: 20 }}
      isFetching={false}
      isPlaceholderData={false}
      newItemsCount={0}
      onAcceptNewItems={rs.fn()}
      onLoadOlder={rs.fn()}
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
        data={{ items: [{ ...trace, finalModelId: trace.requestedModelId }], pageCount: 1 }}
        search={{ ...createDefaultTraceSearch(), pageSize: 20 }}
        isFetching={false}
        isPlaceholderData={false}
        newItemsCount={0}
        onAcceptNewItems={rs.fn()}
        onLoadOlder={rs.fn()}
        onSelect={rs.fn()}
      />,
    );
    const sameModelCell = within(screen.getByRole('button', { name: new RegExp(trace.traceId, 'u') })).getAllByRole(
      'cell',
    )[4];
    expect(sameModelCell.children).toHaveLength(1);
    expect(sameModelCell).toHaveTextContent('requested-model');
  });
});
