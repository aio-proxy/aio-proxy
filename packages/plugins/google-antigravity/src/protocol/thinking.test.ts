import { expect, test } from 'bun:test';

import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

import type { AntigravityFamily } from '../catalog/collapse';
import { bindAntigravityThinking } from './thinking';

const { applyAntigravityThinking, geminiThinkingConfig } = bindAntigravityThinking(thinkingCatalog());

test('rejects a Gemini split effort that does not match the current wire', () => {
  expect(() => geminiThinkingConfig('gemini-3.5-flash-low', { thinkingLevel: 'HIGH' })).toThrow();
  expect(() => applyAntigravityThinking('gemini-3.5-flash-low', { mode: 'adaptive', effort: 'high' })).toThrow();
});

test('maps a matching Gemini split effort to the catalog thinkingBudget', () => {
  expect(geminiThinkingConfig('gemini-3.5-flash-low', { thinkingLevel: 'MEDIUM' })).toEqual({
    thinkingBudget: 4000,
    includeThoughts: true,
  });
});

test('leaves thinkingLevel on a Gemini tiered wire when thinkingBudget is -1', () => {
  expect(
    geminiThinkingConfig('gemini-3.7-flash-tiered', {
      thinkingLevel: 'HIGH',
      vendorMarker: true,
    }),
  ).toEqual({ thinkingLevel: 'high', vendorMarker: true });
});

test('maps minimal on an extra-low wire to the catalog thinkingBudget', () => {
  expect(geminiThinkingConfig('gemini-3.5-flash-extra-low', { thinkingLevel: 'MINIMAL' })).toEqual({
    thinkingBudget: 1000,
    includeThoughts: true,
  });
});

test('rejects minimal on extra-low when thinkingBudget is missing', () => {
  expect(() => geminiThinkingConfig('gemini-legacy-extra-low', { thinkingLevel: 'minimal' })).toThrow();
  expect(() => applyAntigravityThinking('gemini-legacy-extra-low', { mode: 'adaptive', effort: 'minimal' })).toThrow();
});

test('rejects minimal on gemini-3.8-flash when the medium base is not extra-low', () => {
  expect(() => geminiThinkingConfig('gemini-3.8-flash', { thinkingLevel: 'minimal' })).toThrow();
  expect(() => applyAntigravityThinking('gemini-3.8-flash', { mode: 'adaptive', effort: 'minimal' })).toThrow();
});

test('maps off and none to budget 0 even when minThinkingBudget is positive', () => {
  expect(geminiThinkingConfig('gemini-3.5-flash-extra-low', { thinkingLevel: 'OFF' })).toEqual({
    thinkingBudget: 0,
    includeThoughts: false,
  });
  expect(geminiThinkingConfig('gemini-3.5-flash-extra-low', { thinkingLevel: 'none' })).toEqual({
    thinkingBudget: 0,
    includeThoughts: false,
  });
});

test.each([
  ['low', 4096],
  ['medium', 8192],
  ['high', 16384],
  ['max', 32768],
] as const)('maps Claude adaptive %s to the constant budget', (effort, budget) => {
  expect(applyAntigravityThinking('claude-opus-4-6-thinking', { mode: 'adaptive', effort })).toEqual({
    thinkingBudget: budget,
    includeThoughts: true,
  });
});

test('maps Gemini-protocol Claude high through the adaptive ladder', () => {
  expect(geminiThinkingConfig('claude-opus-4-6-thinking', { thinkingLevel: 'HIGH' })).toEqual({
    thinkingBudget: 16384,
    includeThoughts: true,
  });
});

test('does not remap GPT-OSS thinking.mode none', () => {
  expect(geminiThinkingConfig('gpt-oss-120b', { thinkingLevel: 'HIGH', vendorMarker: true })).toEqual({
    thinkingLevel: 'HIGH',
    vendorMarker: true,
  });
  expect(geminiThinkingConfig('gpt-oss-120b', { thinkingBudget: 999, includeThoughts: true })).toEqual({
    thinkingBudget: 999,
    includeThoughts: true,
  });
  expect(applyAntigravityThinking('gpt-oss-120b', { mode: 'adaptive', effort: 'high' })).toEqual({
    thinkingLevel: 'high',
  });
});

test('allows Gemini same-wire high with tiered semantics', () => {
  expect(geminiThinkingConfig('gemini-3.8-flash', { thinkingLevel: 'HIGH' })).toEqual({
    thinkingBudget: 8000,
    includeThoughts: true,
  });
});

test('enforces Gemini Anthropic fixed minThinkingBudget without a 1024 Claude floor', () => {
  expect(() => applyAntigravityThinking('gemini-fixed-min', { mode: 'fixed', budgetTokens: 500 })).toThrow();
  expect(() => applyAntigravityThinking('gemini-fixed-min', { mode: 'fixed', budgetTokens: 1500 })).toThrow();
  expect(applyAntigravityThinking('gemini-fixed-min', { mode: 'fixed', budgetTokens: 2000 })).toEqual({
    thinkingBudget: 2000,
    includeThoughts: true,
  });
  expect(applyAntigravityThinking('gemini-fixed-open', { mode: 'fixed', budgetTokens: 500 })).toEqual({
    thinkingBudget: 500,
    includeThoughts: true,
  });
});

test('enforces Claude fixed >= max(1024, minThinkingBudget ?? 1024)', () => {
  expect(() => applyAntigravityThinking('claude-sonnet-4-6', { mode: 'fixed', budgetTokens: 1023 })).toThrow();
  expect(applyAntigravityThinking('claude-sonnet-4-6', { mode: 'fixed', budgetTokens: 1024 })).toEqual({
    thinkingBudget: 1024,
    includeThoughts: true,
  });
  expect(() => applyAntigravityThinking('claude-opus-4-6-thinking', { mode: 'fixed', budgetTokens: 1500 })).toThrow();
  expect(applyAntigravityThinking('claude-opus-4-6-thinking', { mode: 'fixed', budgetTokens: 2048 })).toEqual({
    thinkingBudget: 2048,
    includeThoughts: true,
  });
});

test('rejects Claude fixed budgets that are not below maxOutputTokens', () => {
  expect(() => applyAntigravityThinking('claude-opus-4-6-thinking', { mode: 'fixed', budgetTokens: 64_000 })).toThrow();
});

test('maps Gemini xhigh to high and rejects unknown efforts', () => {
  expect(geminiThinkingConfig('gemini-3.8-flash', { thinkingLevel: 'xhigh' })).toEqual({
    thinkingBudget: 8000,
    includeThoughts: true,
  });
  expect(() => geminiThinkingConfig('gemini-3.8-flash', { thinkingLevel: 'extreme' })).toThrow();
  expect(() => applyAntigravityThinking('claude-opus-4-6-thinking', { mode: 'adaptive', effort: 'extreme' })).toThrow();
});

test('maps Gemini wires outside any family without variant-table rejection', () => {
  expect(geminiThinkingConfig('gemini-lonely', { thinkingLevel: 'HIGH' })).toEqual({
    thinkingBudget: 2500,
    includeThoughts: true,
  });
  expect(geminiThinkingConfig('gemini-lonely-dynamic', { thinkingLevel: 'LOW' })).toEqual({
    thinkingLevel: 'low',
  });
});

test('maps Anthropic disabled thinking to a zero budget', () => {
  expect(applyAntigravityThinking('claude-sonnet-4-6', { mode: 'disabled' })).toEqual({
    thinkingBudget: 0,
    includeThoughts: false,
  });
});

test('rejects minimal on extra-low when the catalog budget is not positive', () => {
  expect(() => geminiThinkingConfig('gemini-no-minimal-budget-extra-low', { thinkingLevel: 'minimal' })).toThrow();
});

function thinkingCatalog(): ModelCatalog {
  return {
    language: [
      gemini('gemini-3.5-flash-extra-low', { thinkingBudget: 1000, minThinkingBudget: 512 }),
      gemini('gemini-legacy-extra-low', {}),
      gemini('gemini-3.5-flash-low', { thinkingBudget: 4000 }),
      gemini('gemini-3-flash-agent', { thinkingBudget: 10_000 }),
      gemini('gemini-3.7-flash-tiered', { thinkingBudget: -1 }),
      gemini('gemini-3.8-flash', { thinkingBudget: 8000, minThinkingBudget: 1024 }),
      gemini('gemini-fixed-min', { minThinkingBudget: 2000 }),
      gemini('gemini-fixed-open', {}),
      gemini('gemini-lonely', { thinkingBudget: 2500 }),
      gemini('gemini-lonely-dynamic', { thinkingBudget: -1 }),
      gemini('gemini-no-minimal-budget-extra-low', { thinkingBudget: -1 }),
      claude('claude-sonnet-4-6', {}),
      claude('claude-opus-4-6-thinking', { minThinkingBudget: 2048, maxOutputTokens: 64_000 }),
      {
        id: 'gpt-oss-120b',
        extra: { antigravity: { apiProvider: 'openai' } },
      },
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    extra: {
      antigravityFamilies: [
        family({
          logicalId: 'gemini-3.5-flash',
          kind: 'split',
          mode: 'gemini',
          base: 'gemini-3.5-flash-low',
          variants: [
            { effort: 'low', model: 'gemini-3.5-flash-extra-low' },
            { effort: 'medium', model: 'gemini-3.5-flash-low' },
            { effort: 'high', model: 'gemini-3-flash-agent' },
          ],
        }),
        family({
          logicalId: 'gemini-3.7-flash',
          kind: 'tiered',
          mode: 'gemini',
          base: 'gemini-3.7-flash-tiered',
          variants: [
            { effort: 'low', model: 'gemini-3.7-flash-tiered' },
            { effort: 'medium', model: 'gemini-3.7-flash-tiered' },
            { effort: 'high', model: 'gemini-3.7-flash-tiered' },
          ],
        }),
        family({
          logicalId: 'gemini-3.8-flash',
          kind: 'same-wire',
          mode: 'gemini',
          base: 'gemini-3.8-flash',
          variants: [
            { effort: 'low', model: 'gemini-3.8-flash' },
            { effort: 'medium', model: 'gemini-3.8-flash' },
            { effort: 'high', model: 'gemini-3.8-flash' },
          ],
        }),
        family({
          logicalId: 'claude-sonnet-4-6',
          kind: 'same-wire',
          mode: 'claude',
          base: 'claude-sonnet-4-6',
          variants: [
            { effort: 'low', model: 'claude-sonnet-4-6' },
            { effort: 'medium', model: 'claude-sonnet-4-6' },
            { effort: 'high', model: 'claude-sonnet-4-6' },
          ],
        }),
        family({
          logicalId: 'claude-opus-4-6',
          kind: 'same-wire',
          mode: 'claude',
          base: 'claude-opus-4-6-thinking',
          variants: [
            { effort: 'low', model: 'claude-opus-4-6-thinking' },
            { effort: 'medium', model: 'claude-opus-4-6-thinking' },
            { effort: 'high', model: 'claude-opus-4-6-thinking' },
          ],
        }),
        family({
          logicalId: 'gpt-oss-120b',
          kind: 'split',
          mode: 'none',
          base: 'gpt-oss-120b',
          variants: [{ effort: 'medium', model: 'gpt-oss-120b' }],
        }),
      ] satisfies AntigravityFamily[],
    },
  };
}

function gemini(
  id: string,
  fields: {
    readonly thinkingBudget?: number;
    readonly minThinkingBudget?: number;
    readonly maxOutputTokens?: number;
  },
): ModelDescriptor {
  return descriptor(id, 'gemini', fields);
}

function claude(
  id: string,
  fields: {
    readonly thinkingBudget?: number;
    readonly minThinkingBudget?: number;
    readonly maxOutputTokens?: number;
  },
): ModelDescriptor {
  return descriptor(id, 'anthropic', fields);
}

function descriptor(
  id: string,
  apiProvider: string,
  fields: {
    readonly thinkingBudget?: number;
    readonly minThinkingBudget?: number;
    readonly maxOutputTokens?: number;
  },
): ModelDescriptor {
  return {
    id,
    extra: {
      antigravity: {
        apiProvider,
        ...(fields.thinkingBudget === undefined ? {} : { thinkingBudget: fields.thinkingBudget }),
        ...(fields.minThinkingBudget === undefined ? {} : { minThinkingBudget: fields.minThinkingBudget }),
        ...(fields.maxOutputTokens === undefined ? {} : { maxOutputTokens: fields.maxOutputTokens }),
      },
    },
  };
}

function family(input: {
  readonly logicalId: string;
  readonly kind: AntigravityFamily['kind'];
  readonly mode: AntigravityFamily['thinking']['mode'];
  readonly base: string;
  readonly variants: AntigravityFamily['variants'];
}): AntigravityFamily {
  return {
    logicalId: input.logicalId,
    kind: input.kind,
    thinking: { mode: input.mode },
    base: input.base,
    variants: input.variants,
  };
}
