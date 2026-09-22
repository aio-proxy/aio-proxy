import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { getTraceRuntime } from '../request-tracing';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('a closed state does not resynchronize otel destinations from a later commit', async () => {
  const state = await createServerState({
    builtIns: [],
    config: ConfigSchema.parse({
      providers: {},
      server: {
        otel: {
          destinations: [{ url: 'http://127.0.0.1:4318/v1/traces', contentType: 'json', headers: {} }],
        },
      },
    }),
    dbHome: tempHome(),
    watchConfig: false,
  });
  const sync = spyOn(getTraceRuntime().exporter, 'sync');
  try {
    state.close();
    expect((await state.reload()).ok).toBe(true);
    expect(sync).not.toHaveBeenCalled();
  } finally {
    sync.mockRestore();
    state.close();
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-otel-close-commit-'));
  homes.push(home);
  return home;
}
