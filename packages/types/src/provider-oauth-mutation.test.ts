import { expect, test } from 'bun:test';

import type { ZodType } from 'zod';

import * as provider from './provider';

test('OAuth provider mutation accepts routing fields but rejects identity and account options', () => {
  expect(provider).toHaveProperty('OAuthProviderMutationBodySchema');
  const schema = Reflect.get(provider, 'OAuthProviderMutationBodySchema') as ZodType;
  const body = {
    kind: 'oauth',
    id: 'person',
    name: 'Personal',
    enabled: false,
    weight: 4,
    metadata: { model: { limit: { context: 400_000, input: 272_000, output: 128_000 } } },
    alias: { chat: { model: 'model-1', preserve: false } },
  };

  expect(schema.parse(body)).toEqual(body);
  expect(() => schema.parse({ ...body, plugin: '@example/other' })).toThrow();
  expect(() => schema.parse({ ...body, options: { tenant: 'other' } })).toThrow();
});
