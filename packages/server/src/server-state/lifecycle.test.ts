import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Router } from '@aio-proxy/core';
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

test('successful snapshot commits notify after publication and callback errors are isolated', async () => {
  const home = tempHome();
  const path = join(home, 'config.json');
  await Bun.write(path, JSON.stringify({ providers: {} }));
  let notifications = 0;
  let failRebuild = false;
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath: path,
    dbHome: home,
    watchConfig: false,
    logger: () => {},
    __test: {
      createRouter(providers, routerConfig) {
        if (failRebuild) throw new Error('injected rebuild');
        return new Router(providers, routerConfig);
      },
    },
    onProviderSnapshotChanged() {
      notifications++;
      throw new Error('injected callback');
    },
  });
  try {
    await Bun.write(path, JSON.stringify({ providers: {}, server: { port: 9876 } }));
    expect((await state.reload()).ok).toBe(true);
    expect(state.currentConfig().server.port).toBe(9876);
    expect(notifications).toBe(1);
    failRebuild = true;
    await Bun.write(path, JSON.stringify({ providers: {}, server: { port: 8765 } }));
    expect((await state.reload()).ok).toBe(false);
    expect(state.currentConfig().server.port).toBe(9876);
    expect(notifications).toBe(1);
    await Bun.write(path, '{broken');
    expect((await state.reload()).ok).toBe(false);
    expect(notifications).toBe(1);
  } finally {
    state.close();
  }
});

test('state and request recorder share live metrics', async () => {
  const state = await createServerState({
    builtIns: [],
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: tempHome(),
    watchConfig: false,
  });
  try {
    const session = state.requestRecorder.begin({
      inboundRequest: new Request('http://localhost/v1/chat/completions'),
      inboundProtocol: 'openai-chat',
    });
    expect(state.liveMetrics.snapshot().inFlight).toBe(1);
    session.finish({ outcome: 'success' });
    expect(state.liveMetrics.snapshot().inFlight).toBe(0);
  } finally {
    state.close();
  }
});

test('state and usage capture share live metrics', async () => {
  const state = await createServerState({
    builtIns: [],
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: tempHome(),
    watchConfig: false,
  });
  const record = spyOn(state.liveMetrics, 'recordContent');
  try {
    const captured = state.usageCapture.stream({
      providerId: 'p',
      modelId: 'm',
      live: true,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', id: 't', text: 'hello' });
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 },
              outputTokenDetails: { reasoningTokens: 0, textTokens: 0 },
            },
          });
          controller.close();
        },
      }),
    });
    for await (const _part of captured.value) {
      /* Drain through upstream completion. */
    }
    await captured.completion;
    expect(record).toHaveBeenCalledWith('p/m', 5);
  } finally {
    record.mockRestore();
    state.close();
  }
});
