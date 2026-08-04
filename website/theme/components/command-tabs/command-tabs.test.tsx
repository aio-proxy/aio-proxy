import { expect, mock, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@rspress/core/theme', () => ({
  getCustomMDXComponent: () => ({ code: 'code', pre: 'pre' }),
}));

const { CommandTabs } = await import('./index');

test('renders built-in icons for configured commands', () => {
  const html = renderToStaticMarkup(
    <CommandTabs
      commands={{
        brew: 'brew install aio-proxy/tap/aio-proxy',
        bun: 'bun add -g aio-proxy',
      }}
    />,
  );

  expect(html).toContain('<svg');
  expect(html).toContain('brew install aio-proxy/tap/aio-proxy');
});
