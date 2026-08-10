import type { DashboardTraceSummary } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { TraceContextRail } from './trace-context-rail';

const trace: DashboardTraceSummary = {
  traceId: 'a'.repeat(32),
  rootSpanId: 'b'.repeat(16),
  requestId: 'request-a',
  startedAt: '2026-07-12T08:00:00.000Z',
  endedAt: '2026-07-12T08:00:00.125Z',
  durationMs: 125,
  otelStatusCode: 'OK',
  session: { source: 'openai-prompt-cache', id: 'cache-a' },
  inboundProtocol: 'openai-response',
  requestedModelId: 'gpt-5',
  finalProviderId: 'provider-a',
  finalHttpStatus: 200,
};

test('keeps context unbordered and delegates Session ID filtering', () => {
  const onSessionSelect = rs.fn();
  render(<TraceContextRail trace={trace} onSessionSelect={onSessionSelect} />);

  const rail = screen.getByTestId('trace-context-rail');
  expect(rail.querySelector('[data-slot="card"]')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'cache-a' }));
  expect(onSessionSelect).toHaveBeenCalledWith(trace.session);
});
