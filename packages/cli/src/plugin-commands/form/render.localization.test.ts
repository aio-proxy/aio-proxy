import { describe, expect, test } from 'bun:test';

import { zod } from '@aio-proxy/plugin-sdk';

import { renderConfigSpec } from './index';
import { type PromptCall, prompts } from './test-support';

describe('renderConfigSpec localization', () => {
  test('resolves localized field, option, and placeholder copy at prompt time', async () => {
    const calls: PromptCall[] = [];
    await renderConfigSpec(
      {
        schema: zod.object({ mode: zod.literal('fast'), name: zod.string() }),
        form: [
          {
            type: 'select',
            key: 'mode',
            label: { default: 'Mode', 'zh-Hans': '模式' },
            description: { default: 'Choose', 'zh-Hans': '选择' },
            options: [{ value: 'fast', label: { default: 'Fast', 'zh-Hans': '快速' } }],
          },
          {
            type: 'text',
            key: 'name',
            label: { default: 'Name', 'zh-Hans': '名称' },
            placeholder: { default: 'Ada', 'zh-Hans': '小明' },
          },
        ],
      },
      { prompts: prompts(['fast', 'Ada'], calls), locale: 'zh-Hans' },
    );
    expect(calls.map(({ config }) => config)).toEqual([
      { message: '模式 (选择)', choices: [{ name: '快速', value: 'fast' }] },
      { message: '名称', placeholder: '小明' },
    ]);
  });
});
