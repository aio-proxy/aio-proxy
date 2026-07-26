import { describe, expect, test } from 'bun:test';

import { zod } from '@aio-proxy/plugin-sdk';

import {
  FormJsonInvalidError,
  FormNumberInvalidError,
  FormSchemaValidationError,
  type PluginFormPrompts,
  renderConfigSpec,
} from './index';
import { type PromptCall, prompts, spec } from './test-support';

describe('renderConfigSpec validation', () => {
  test('forwards the same signal to every prompt and abort returns no partial result', async () => {
    const controller = new AbortController();
    const calls: PromptCall[] = [];
    const aborting: PluginFormPrompts = {
      ...prompts([], calls),
      async input(config, context) {
        calls.push({ type: 'input', config, signal: context?.signal });
        controller.abort();
        throw controller.signal.reason;
      },
    };
    await expect(renderConfigSpec(spec, { prompts: aborting, signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  test('rejects malformed number and json before schema validation', async () => {
    const numberSpec = {
      schema: zod.object({ count: zod.number() }),
      form: [{ type: 'number', key: 'count', label: 'Count' }],
    } as const;
    await expect(renderConfigSpec(numberSpec, { prompts: prompts(['wat']) })).rejects.toEqual(
      new FormNumberInvalidError('count'),
    );
    const jsonSpec = {
      schema: zod.object({ data: zod.unknown() }),
      form: [{ type: 'json', key: 'data', label: 'Data' }],
    } as const;
    await expect(renderConfigSpec(jsonSpec, { prompts: prompts(['{']) })).rejects.toEqual(
      new FormJsonInvalidError('data'),
    );
  });

  test('maps schema issues to top-level field keys', async () => {
    const invalidSpec = {
      schema: zod.object({ endpoint: zod.string().url(), retries: zod.number().int().positive() }),
      form: [
        { type: 'text', key: 'endpoint', label: 'Endpoint' },
        { type: 'number', key: 'retries', label: 'Retries' },
      ],
    } as const;
    try {
      await renderConfigSpec(invalidSpec, { prompts: prompts(['nope', '-1']) });
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(FormSchemaValidationError);
      expect((error as FormSchemaValidationError).issues.map((issue) => issue.key)).toEqual(['endpoint', 'retries']);
    }
  });
});
