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
    expect((calls[0]?.config as { default?: unknown } | undefined)?.default).toBeUndefined();
    expect((calls[1]?.config as { default?: unknown } | undefined)?.default).toBeUndefined();
    expect((calls[2]?.config as { default?: unknown } | undefined)?.default).toBe(true);
    expect((calls[3]?.config as { default?: unknown } | undefined)?.default).toBeUndefined();
    expect((calls[4]?.config as { default?: unknown } | undefined)?.default).toBe('{"safe":true}');
  });
});
