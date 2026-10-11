import { expect, test } from 'bun:test';

import { z } from 'zod';

import { buildConfigJsonSchema, ConfigAuthoringSchema, ConfigSchema } from '../config';
import { ProviderMutationAuthoringBodySchema, ProviderMutationBodySchema, ProviderSchema } from '../provider';
import { validateSyncModels } from './index';

const providers = [
  { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://api.example.com/v1' },
  { kind: 'ai-sdk', packageName: '@ai-sdk/openai-compatible' },
] as const;

const providerSchemas = [ProviderSchema, ProviderMutationBodySchema, ProviderMutationAuthoringBodySchema];

test.each(providers)('syncModels with excludedModels parses for $kind', (provider) => {
  const fields = { syncModels: true, excludedModels: ['hidden-model'] };
  const input = { ...provider, ...fields };
  const config = ConfigSchema.parse({ providers: { upstream: input } });

  expect(config.invalidProviders).toEqual([]);
  expect(config.providers[0]).toMatchObject(fields);
  expect(ConfigAuthoringSchema.parse({ providers: { upstream: input } }).providers['upstream']).toMatchObject(fields);
  for (const schema of providerSchemas) {
    expect(schema.parse({ ...input, id: 'upstream' })).toMatchObject(fields);
  }
});

test.each(providers)('syncModels with non-empty models is rejected for $kind', (provider) => {
  const input = { ...provider, syncModels: true, models: ['static-model'] };
  const issue = { path: ['models'], message: 'models and syncModels are mutually exclusive' };

  for (const schema of providerSchemas) {
    const result = schema.safeParse({ ...input, id: 'upstream' });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(expect.objectContaining(issue));
  }
  const config = ConfigSchema.parse({ providers: { upstream: input } });
  expect(config.providers).toEqual([]);
  expect(config.invalidProviders).toEqual([
    { id: 'upstream', kind: provider.kind, code: 'PROVIDER_CONFIG_INVALID', issuePaths: [['models']] },
  ]);
  const authoring = ConfigAuthoringSchema.safeParse({ providers: { upstream: input } });
  expect(authoring.success).toBe(false);
  expect(authoring.error?.issues).toContainEqual(
    expect.objectContaining({ ...issue, path: ['providers', 'upstream', 'models'] }),
  );
});

test.each(providers)('syncModels with models: [] parses for $kind', (provider) => {
  const fields = { syncModels: true, models: [] };
  const input = { ...provider, ...fields };
  const config = ConfigSchema.parse({ providers: { upstream: input } });

  expect(config.invalidProviders).toEqual([]);
  expect(config.providers[0]).toMatchObject(fields);
  expect(ConfigAuthoringSchema.parse({ providers: { upstream: input } }).providers['upstream']).toMatchObject(fields);
  for (const schema of providerSchemas) {
    expect(schema.parse({ ...input, id: 'upstream' })).toMatchObject(fields);
  }
});

test.each(providers)('excludedModels without syncModels is rejected for $kind', (provider) => {
  for (const syncModels of [undefined, false]) {
    for (const excludedModels of [[], ['hidden-model']]) {
      const input = { ...provider, syncModels, excludedModels };
      const issue = { path: ['excludedModels'], message: 'excludedModels requires syncModels' };

      for (const schema of providerSchemas) {
        const result = schema.safeParse({ ...input, id: 'upstream' });
        expect(result.success).toBe(false);
        expect(result.error?.issues).toContainEqual(expect.objectContaining(issue));
      }
      const config = ConfigSchema.parse({ providers: { upstream: input } });
      expect(config.providers).toEqual([]);
      expect(config.invalidProviders).toEqual([
        { id: 'upstream', kind: provider.kind, code: 'PROVIDER_CONFIG_INVALID', issuePaths: [['excludedModels']] },
      ]);
      const authoring = ConfigAuthoringSchema.safeParse({ providers: { upstream: input } });
      expect(authoring.success).toBe(false);
      expect(authoring.error?.issues).toContainEqual(
        expect.objectContaining({ ...issue, path: ['providers', 'upstream', 'excludedModels'] }),
      );
    }
  }
});

test('oauth excludedModels still parses without syncModels', () => {
  const fields = { excludedModels: ['hidden-model'] };
  const input = { kind: 'oauth', plugin: '@aio-proxy/plugin-example', capability: 'default', ...fields };
  const config = ConfigSchema.parse({ providers: { upstream: input } });

  expect(config.invalidProviders).toEqual([]);
  expect(config.providers[0]).toMatchObject(fields);
  expect(ConfigAuthoringSchema.parse({ providers: { upstream: input } }).providers['upstream']).toMatchObject(fields);
  expect(ProviderSchema.parse({ ...input, id: 'upstream' })).toMatchObject(fields);
  for (const schema of [ProviderMutationBodySchema, ProviderMutationAuthoringBodySchema]) {
    expect(schema.parse({ kind: 'oauth', id: 'upstream', ...fields })).toMatchObject(fields);
  }
});

test('validateSyncModels is a no-op for OAuth', () => {
  const schema = z
    .object({
      kind: z.string(),
      syncModels: z.boolean(),
      models: z.array(z.string()),
      excludedModels: z.array(z.string()),
    })
    .superRefine(validateSyncModels);

  for (const syncModels of [false, true]) {
    expect(
      schema.safeParse({ kind: 'oauth', syncModels, models: ['static-model'], excludedModels: ['hidden-model'] })
        .success,
    ).toBe(true);
  }
});

test.each(providers)('static models keep working when syncModels is disabled for $kind', (provider) => {
  for (const syncModels of [undefined, false]) {
    const input = { ...provider, models: ['static-model'], syncModels };
    const config = ConfigSchema.parse({ providers: { upstream: input } });

    expect(config.invalidProviders).toEqual([]);
    expect(config.providers[0]).toMatchObject({ models: ['static-model'] });
    expect(ProviderMutationBodySchema.parse({ ...input, id: 'upstream' })).toMatchObject({ models: ['static-model'] });
  }
});

test('config JSON schema documents syncModels', () => {
  expect(JSON.stringify(buildConfigJsonSchema())).toContain('"syncModels"');
});
