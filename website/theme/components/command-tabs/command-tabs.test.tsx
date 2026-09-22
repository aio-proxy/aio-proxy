import { expect, mock, test } from 'bun:test';

import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@rspress/core/theme', () => ({
  CodeBlockRuntime: ({ code }: { readonly code: string }) => <code>{code}</code>,
  Tab: ({ children, label }: React.PropsWithChildren<{ readonly label: React.ReactNode }>) => (
    <section>
      {label}
      {children}
    </section>
  ),
  Tabs: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
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
