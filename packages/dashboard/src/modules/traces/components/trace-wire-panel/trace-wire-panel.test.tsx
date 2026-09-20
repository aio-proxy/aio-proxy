import { m } from '@aio-proxy/i18n';
import type { DashboardTraceWireHop } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { TraceWirePanel } from './trace-wire-panel';

const hopWithBody = (body: NonNullable<DashboardTraceWireHop['request']>['body']): DashboardTraceWireHop => ({
  id: 'inbound',
  kind: 'inbound',
  request: {
    method: 'POST',
    url: 'https://proxy.test/v1/messages',
    headers: {},
    ...(body === undefined ? {} : { body }),
  },
});

const WARNING = () => m['dashboard.traces.wire_body_truncated']();

// 完整正文不该挂警告，否则这句话在每条抓包上都出现，等于没有。
test('says nothing about completeness when the body was fully recorded', () => {
  render(<TraceWirePanel side="request" hop={hopWithBody({ text: 'full', outcome: 'complete' })} />);

  expect(screen.queryByText(WARNING())).toBeNull();
  expect(screen.getByText('full')).toBeTruthy();
});

// `body-tap.ts` 四个 terminal 调用点全都带 outcome，所以有正文却没有 outcome 只可能是
// 流还在跑、或者那行日志在崩溃/半截读里丢了 —— 两种都不是完整正文。少了这一条，面板会把
// 半截 body 当完整的摆出来，而看的人正在拿它查问题。
test('warns when a body arrived without a terminal event', () => {
  render(<TraceWirePanel side="request" hop={hopWithBody({ text: 'partial' })} />);

  expect(screen.getByText(WARNING())).toBeTruthy();
});

test.each(['cancelled', 'error'] as const)('warns when the capture ended as %s', (outcome) => {
  render(<TraceWirePanel side="request" hop={hopWithBody({ text: 'partial', outcome })} />);

  expect(screen.getByText(WARNING())).toBeTruthy();
});

// 服务端裁掉尾巴是另一条路：outcome 是 complete，但正文不全。
test('warns when the server truncated the body even though the capture completed', () => {
  render(<TraceWirePanel side="request" hop={hopWithBody({ text: 'head', outcome: 'complete', truncated: true })} />);

  expect(screen.getByText(WARNING())).toBeTruthy();
});
