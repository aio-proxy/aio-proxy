import { expect, test } from 'bun:test';

import type { RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { createRuntimeFetch } from '.';

test('defaults to model traffic and routes explicit control traffic', async () => {
  const model: Array<RequestInit | undefined> = [];
  const control: Array<RequestInit | undefined> = [];
  const fetch = createRuntimeFetch({
    model: (async (_input, init) => {
      model.push(init);
      return new Response('model');
    }) as typeof globalThis.fetch,
    control: (async (_input, init) => {
      control.push(init);
      return new Response('control');
    }) as typeof globalThis.fetch,
  });

  await fetch('https://example.test/default');
  await fetch('https://example.test/model', { aioProxy: { traffic: 'model' } });
  const init = {
    method: 'POST',
    aioProxy: { traffic: 'control' },
    decompress: false,
  } as RuntimeRequestInit & { readonly decompress: boolean };
  await fetch('https://example.test/control', init);

  expect(model).toHaveLength(2);
  expect(control).toHaveLength(1);
  expect(control[0]).toMatchObject({ method: 'POST', decompress: false });
  expect(Reflect.has(control[0] as object, 'aioProxy')).toBe(false);
  expect(init.aioProxy).toEqual({ traffic: 'control' });
});

test('rejects invalid runtime traffic before dispatch', async () => {
  let calls = 0;
  const downstream = (async () => {
    calls++;
    return new Response();
  }) as typeof globalThis.fetch;
  const fetch = createRuntimeFetch({ control: downstream, model: downstream });

  await expect(
    fetch('https://example.test', {
      aioProxy: { traffic: 'invalid' },
    } as unknown as RuntimeRequestInit),
  ).rejects.toBeInstanceOf(TypeError);
  expect(calls).toBe(0);
});
