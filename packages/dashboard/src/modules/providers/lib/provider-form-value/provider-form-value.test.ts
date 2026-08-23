import { ProviderKind } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';

import { normalizeProviderFormValue, parseProviderFormInitial, type ProviderFormShape } from './provider-form-value';

const apiValues = (overrides: Partial<ProviderFormShape> = {}): ProviderFormShape =>
  ({
    kind: ProviderKind.Api,
    id: 'demo-api',
    protocol: 'openai-response',
    baseURL: 'https://x.example/v1',
    ...overrides,
  }) as ProviderFormShape;

describe('normalizeProviderFormValue', () => {
  // `replaceProvider` writes this body verbatim into the user's hand-editable config file, so a
  // display name the user cleared must leave no key behind rather than stamp a dead `name: ""`. The
  // OAuth write path already drops it (`providerEntry` in core account-login/validation.ts); this is
  // the `api`/`ai-sdk` half of the same rule. `toStrictEqual` is required: `name: undefined` would
  // satisfy a plain `toEqual` and still serialize the key away only by accident.
  test.each(['', '   '])('a display name cleared to %j leaves no name key in the body', (name) => {
    const result = normalizeProviderFormValue(apiValues({ name }));

    expect(result).toStrictEqual(apiValues());
    expect('name' in (result as object)).toBe(false);
  });

  test('a real display name survives', () => {
    expect(normalizeProviderFormValue(apiValues({ name: ' Demo ' }))).toStrictEqual(apiValues({ name: ' Demo ' }));
  });

  // `validationModel` is the editor's own test-connection field and is not part of any mutation body.
  test('the editor-only validation model never reaches the body', () => {
    const result = normalizeProviderFormValue(apiValues({ validationModel: 'gpt-5' }));

    expect('validationModel' in (result as object)).toBe(false);
  });
});

describe('parseProviderFormInitial', () => {
  test('a kind the editor cannot render comes back undefined instead of a half-parsed shape', () => {
    expect(parseProviderFormInitial({ kind: 'oauth', id: 'copilot' })).toBeUndefined();
    expect(parseProviderFormInitial(null)).toBeUndefined();
    expect(parseProviderFormInitial({ id: 'no-kind' })).toBeUndefined();
  });

  test('an endpoints-only api provider hydrates a draft instead of failing', () => {
    expect(
      parseProviderFormInitial({
        kind: ProviderKind.Api,
        id: 'moonshot',
        endpoints: [{ protocol: 'anthropic', baseURL: 'https://api.moonshot.cn/anthropic/v1' }],
      }),
    ).toMatchObject({
      kind: ProviderKind.Api,
      id: 'moonshot',
      endpoints: {
        shape: 'shared',
        baseURL: 'https://api.moonshot.cn/anthropic/v1',
        protocols: ['anthropic'],
      },
    });
  });

  test('a shared multi-protocol draft writes the endpoints object, not a fabricated pair', () => {
    expect(
      normalizeProviderFormValue({
        kind: ProviderKind.Api,
        id: 'gw',
        endpoints: {
          shape: 'shared',
          baseURL: 'https://gw.example/v1',
          protocols: ['openai-compatible', 'anthropic'],
        },
      } as ProviderFormShape),
    ).toEqual({
      kind: ProviderKind.Api,
      id: 'gw',
      endpoints: { baseURL: 'https://gw.example/v1', protocol: ['openai-compatible', 'anthropic'] },
    });
  });
});
