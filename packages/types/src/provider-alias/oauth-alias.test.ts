import { expect, test } from 'bun:test';

import { AuthoredOAuthAliasSchema, oauthExposedModels, resolveOAuthAlias } from './oauth-alias';

const cfg = (model: string, preserve = false) => ({ model, preserve });

test('oauthExposedModels is catalog minus excludedModels', () => {
  expect(oauthExposedModels(['a', 'b', 'c'], ['b', 'stale'])).toEqual(['a', 'c']);
  expect(oauthExposedModels(['a'], undefined)).toEqual(['a']);
  expect(oauthExposedModels(['a'], [])).toEqual(['a']);
});

test('inherit on starts from plugin defaults and lets authored keys win', () => {
  expect(
    resolveOAuthAlias(
      { mini: cfg('gpt-5-mini', true), fast: cfg('gpt-5-nano') },
      { mini: cfg('old'), codex: cfg('codex') },
      ['gpt-5-mini', 'gpt-5-nano', 'codex'],
    ),
  ).toEqual({
    mini: cfg('gpt-5-mini', true),
    fast: cfg('gpt-5-nano'),
    codex: cfg('codex'),
  });
});

test('false hides an inherited key when inherit is on', () => {
  expect(
    resolveOAuthAlias({ codex: false }, { mini: cfg('gpt-5-mini'), codex: cfg('codex') }, ['gpt-5-mini', 'codex']),
  ).toEqual({
    mini: cfg('gpt-5-mini'),
  });
});

test('*: false turns inherit off and ignores other false keys', () => {
  expect(
    resolveOAuthAlias(
      { '*': false, mini: cfg('gpt-5-mini'), leftover: false },
      { mini: cfg('old'), codex: cfg('codex') },
      ['gpt-5-mini', 'codex'],
    ),
  ).toEqual({ mini: cfg('gpt-5-mini') });
});

test('a later plugin default appears when inherit is on and the key is not authored', () => {
  expect(resolveOAuthAlias({}, { fresh: cfg('new-model') }, ['new-model'])).toEqual({ fresh: cfg('new-model') });
});

test('a leftover authored key stays at the file value when the plugin default changes', () => {
  expect(
    resolveOAuthAlias({ mini: cfg('gpt-4o-mini') }, { mini: cfg('gpt-5-mini') }, ['gpt-4o-mini', 'gpt-5-mini']),
  ).toEqual({
    mini: cfg('gpt-4o-mini'),
  });
});

test('preserve cannot keep an excluded catalog id in the effective map', () => {
  expect(resolveOAuthAlias({ mini: cfg('hidden', true) }, undefined, ['visible'])).toEqual({});
});

test('authored preserve drops an inherited alias that occupies the original model id', () => {
  expect(
    resolveOAuthAlias(
      { nick: cfg('m', true) },
      {
        m: {
          model: 'm',
          preserve: false,
          variants: [{ when: { effort: 'high' }, model: 'm-high', preserve: false }],
        },
        codex: cfg('codex'),
      },
      ['m', 'm-high', 'codex'],
    ),
  ).toEqual({
    nick: cfg('m', true),
    codex: cfg('codex'),
  });
});

test('an authored alias name drops an inherited preserve of that id', () => {
  expect(resolveOAuthAlias({ m: cfg('other') }, { nick: cfg('m', true) }, ['m', 'other'])).toEqual({
    m: cfg('other'),
  });
});

test('resolve drops entries whose targets are missing from the exposed catalog', () => {
  expect(
    resolveOAuthAlias({ keep: cfg('live'), gone: cfg('missing') }, { inherited: cfg('hidden') }, ['live']),
  ).toEqual({ keep: cfg('live') });
});

test('omitting exposedCatalog keeps catalog-invalid entries for edit-view', () => {
  expect(resolveOAuthAlias({ keep: cfg('live') }, { inherited: cfg('not-yet-filtered') })).toEqual({
    keep: cfg('live'),
    inherited: cfg('not-yet-filtered'),
  });
});

test('AuthoredOAuthAliasSchema accepts false, string shorthand, and *: false', () => {
  expect(
    AuthoredOAuthAliasSchema.parse({
      mini: 'gpt-5-mini',
      codex: false,
      '*': false,
    }),
  ).toEqual({
    mini: cfg('gpt-5-mini'),
    codex: false,
    '*': false,
  });
});

test('reserved * after trim only accepts false', () => {
  const starObject = AuthoredOAuthAliasSchema.safeParse({ '*': { model: 'gpt-5' } });
  expect(starObject.success).toBe(false);
  if (!starObject.success) expect(starObject.error.issues[0]?.path).toEqual(['*']);

  const padded = AuthoredOAuthAliasSchema.safeParse({ ' *': { model: 'gpt-5' } });
  expect(padded.success).toBe(false);
  if (!padded.success) expect(padded.error.issues[0]?.path).toEqual([' *']);
});

test('a failed authored value reports the key path, not a union blob', () => {
  const result = AuthoredOAuthAliasSchema.safeParse({ mini: true });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues[0]?.path).toEqual(['mini']);
});
