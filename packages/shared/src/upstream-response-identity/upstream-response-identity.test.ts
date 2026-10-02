import { expect, test } from 'bun:test';

import { inheritUpstreamResponseIdentity, upstreamResponseIdentity } from './upstream-response-identity';

test('host and independently loaded plugin helpers preserve the same response identity', async () => {
  const source = await Bun.file(new URL('./upstream-response-identity.ts', import.meta.url)).text();
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  const plugin = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as {
    readonly inheritUpstreamResponseIdentity: typeof inheritUpstreamResponseIdentity;
    readonly upstreamResponseIdentity: typeof upstreamResponseIdentity;
  };
  const original = Object.freeze(new Response('upstream'));
  const wrapped = Object.freeze(new Response(original.body, original));
  const identity = upstreamResponseIdentity(original);

  plugin.inheritUpstreamResponseIdentity(original, wrapped);

  expect(upstreamResponseIdentity(wrapped)).toBe(identity);
  expect(plugin.upstreamResponseIdentity(original)).toBe(identity);
  expect(plugin.upstreamResponseIdentity(new Response('independent send'))).not.toBe(identity);
});
