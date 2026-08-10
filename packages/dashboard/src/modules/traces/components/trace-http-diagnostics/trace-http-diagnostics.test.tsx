import type { DashboardTraceDiagnostics } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceHttpDiagnostics } from './trace-http-diagnostics';

test('renders only named safe request diagnostics under Headers and Body', () => {
  const diagnostics = {
    protocol: 'openai-response',
    method: 'POST',
    contentType: 'application/json',
    contentLengthBytes: 35,
    userAgent: 'diagnostics-test/1.0',
    authorization: 'Bearer secret',
  } as DashboardTraceDiagnostics['request'] & { readonly authorization: string };

  render(<TraceHttpDiagnostics side="request" diagnostics={diagnostics} />);

  expect(screen.getByRole('heading', { name: /^Headers$|^标头$/u })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /^Body$|^正文$/u })).toBeInTheDocument();
  expect(screen.getByText('diagnostics-test/1.0')).toBeInTheDocument();
  expect(screen.queryByText('Bearer secret')).toBeNull();
});

test('names the unavailable diagnostics side precisely', () => {
  render(<TraceHttpDiagnostics side="response" diagnostics={undefined} />);

  expect(screen.getByRole('status')).toHaveTextContent(/Response diagnostics are unavailable|响应诊断不可用/u);
});
