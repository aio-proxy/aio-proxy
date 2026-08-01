import { expect, test } from 'bun:test';

import { StatusNotRunningError } from '../errors';
import { dashboardCommand } from './dashboard';

test('dashboard opens the browser when the daemon is reachable', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ status: 'ok', uptime: 1, version: '1.2.3' }),
  });
  try {
    const opened: string[] = [];
    const lines: string[] = [];
    await dashboardCommand(
      { port: String(server.port) },
      {
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
        print: (line) => lines.push(line),
      },
    );
    const dashboardUrl = `http://127.0.0.1:${server.port}/dashboard`;
    expect(opened).toEqual([dashboardUrl]);
    expect(lines.join('\n')).toContain(dashboardUrl);
    expect(lines.join('\n').toLowerCase()).toContain('opened');
  } finally {
    server.stop(true);
  }
});

test('dashboard prints the URL even when the browser cannot be opened', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ status: 'ok', uptime: 1, version: '1.2.3' }),
  });
  try {
    const lines: string[] = [];
    await dashboardCommand(
      { port: String(server.port) },
      {
        openBrowser: () => false,
        print: (line) => lines.push(line),
      },
    );
    const dashboardUrl = `http://127.0.0.1:${server.port}/dashboard`;
    expect(lines).toEqual([dashboardUrl]);
  } finally {
    server.stop(true);
  }
});

test('dashboard reports not running and exits without opening a browser', async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });
  const deadPort = probe.port;
  probe.stop(true);

  const opened: string[] = [];
  const lines: string[] = [];
  let caught: unknown;
  await dashboardCommand(
    { port: String(deadPort) },
    {
      openBrowser: (url) => {
        opened.push(url);
        return true;
      },
      print: (line) => lines.push(line),
    },
  ).catch((err) => {
    caught = err;
  });

  expect(opened).toEqual([]);
  expect(lines.join('\n')).toContain(String(deadPort));
  expect(caught).toBeInstanceOf(StatusNotRunningError);
});
