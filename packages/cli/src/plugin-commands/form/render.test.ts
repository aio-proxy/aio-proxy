import { describe, expect, test } from 'bun:test';

import { zod } from '@aio-proxy/plugin-sdk';

import { renderConfigSpec } from './index';
import { type PromptCall, prompts, spec } from './test-support';

describe('renderConfigSpec', () => {
  test('renders all six field types and keeps secrets out of public values', async () => {
    const calls: PromptCall[] = [];
    const result = await renderConfigSpec(spec, {
      prompts: prompts(['https://example.test', 'secret-value', '3', true, 'us', '{"mode":"strict"}'], calls),
    });
    expect(result).toEqual({
      publicValues: {
        endpoint: 'https://example.test',
        retries: 3,
        enabled: true,
        region: 'us',
        advanced: { mode: 'strict' },
      },
      secrets: { token: 'secret-value' },
    });
    expect(result.publicValues).not.toHaveProperty('token');
    expect(calls[1]?.config).toEqual({ message: 'Token', mask: '*' });
  });

  test('skips fields whose when condition is false', async () => {
    const conditional = {
      schema: zod.object({ mode: zod.string(), detail: zod.string().optional() }),
      form: [
        {
          type: 'select',
          key: 'mode',
          label: 'Mode',
          options: [
            { label: 'Simple', value: 'simple' },
            { label: 'Advanced', value: 'advanced' },
          ],
        },
        { type: 'text', key: 'detail', label: 'Detail', when: { key: 'mode', equals: 'advanced' } },
      ],
    } as const;
    const calls: PromptCall[] = [];
    const result = await renderConfigSpec(conditional, { prompts: prompts(['simple'], calls) });
    expect(result.publicValues).toEqual({ mode: 'simple' });
    expect(calls).toHaveLength(1);
  });

  test('prompts for exact Provider IDs and model slugs only in systemOne mode', async () => {
    const conditional = {
      schema: zod.object({
        strategy: zod.enum(['default', 'systemOne']),
        providerId: zod.string().optional(),
        modelId: zod.string().optional(),
      }),
      form: [
        {
          type: 'select',
          key: 'strategy',
          label: 'Strategy',
          options: [
            { label: 'Default', value: 'default' },
            { label: 'System One', value: 'systemOne' },
          ],
        },
        { type: 'provider', key: 'providerId', label: 'providerId', when: { key: 'strategy', notEquals: 'default' } },
        {
          type: 'provider-model',
          key: 'modelId',
          label: 'modelId',
          providerKey: 'providerId',
          when: { key: 'strategy', notEquals: 'default' },
        },
      ],
    } as const;
    const calls: PromptCall[] = [];
    const result = await renderConfigSpec(conditional, {
      prompts: prompts(['systemOne', ' system-one-local ', ' jev-latest '], calls),
    });
    expect(result.publicValues).toMatchObject({
      strategy: 'systemOne',
      providerId: 'system-one-local',
      modelId: 'jev-latest',
    });
    expect(
      calls.map((call) => (call.type === 'select' ? 'strategy' : (call.config as { message: string }).message)),
    ).toEqual(['strategy', 'providerId', 'modelId']);

    const defaultCalls: PromptCall[] = [];
    const defaultResult = await renderConfigSpec(conditional, {
      prompts: prompts(['default'], defaultCalls),
    });
    expect(defaultResult.publicValues).toEqual({ strategy: 'default' });
    expect(defaultCalls).toHaveLength(1);
  });

  test('uses current defaults only when their values are compatible with the field type', async () => {
    const defaultsSpec = {
      schema: zod.object({
        text: zod.string(),
        count: zod.number(),
        enabled: zod.boolean(),
        region: zod.enum(['us', 'eu']),
        data: zod.unknown(),
      }),
      form: [
        { type: 'text', key: 'text', label: 'Text' },
        { type: 'number', key: 'count', label: 'Count' },
        { type: 'boolean', key: 'enabled', label: 'Enabled', defaultValue: true },
        {
          type: 'select',
          key: 'region',
          label: 'Region',
          options: [
            { label: 'US', value: 'us' },
            { label: 'EU', value: 'eu' },
          ],
        },
        { type: 'json', key: 'data', label: 'Data', defaultValue: { safe: true } },
      ],
    } as const;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const calls: PromptCall[] = [];
    await renderConfigSpec(defaultsSpec, {
      prompts: prompts(['text', '2', false, 'us', '{}'], calls),
      currentPublicValues: {
        text: 123,
        count: Number.POSITIVE_INFINITY,
        enabled: 'false',
        region: 'missing',
        data: cyclic,
      },
    });
    expect((calls[0]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBeUndefined();
    expect((calls[1]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBeUndefined();
    expect((calls[2]?.config as { initialValue?: unknown } | undefined)?.initialValue).toBe(true);
    expect((calls[3]?.config as { initialValue?: unknown } | undefined)?.initialValue).toBeUndefined();
    expect((calls[4]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBe('{"safe":true}');
  });

  test('prompts with a field default when the stored value is missing or incompatible', async () => {
    const defaultsSpec = {
      schema: zod.object({
        text: zod.string(),
        region: zod.enum(['us', 'eu']),
      }),
      form: [
        { type: 'text', key: 'text', label: 'Text', defaultValue: 'codex-tui' },
        {
          type: 'select',
          key: 'region',
          label: 'Region',
          defaultValue: 'eu',
          options: [
            { label: 'US', value: 'us' },
            { label: 'EU', value: 'eu' },
          ],
        },
      ],
    } as const;
    const calls: PromptCall[] = [];
    await renderConfigSpec(defaultsSpec, {
      prompts: prompts(['codex-tui', 'eu'], calls),
      currentPublicValues: { text: 1, region: 'missing' },
    });
    expect((calls[0]?.config as { defaultValue?: unknown } | undefined)?.defaultValue).toBe('codex-tui');
    expect((calls[1]?.config as { initialValue?: unknown } | undefined)?.initialValue).toBe('eu');
  });
});
