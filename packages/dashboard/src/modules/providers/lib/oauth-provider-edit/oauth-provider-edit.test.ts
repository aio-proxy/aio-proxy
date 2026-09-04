import type { ProviderTransforms } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { type OAuthProviderEditValues, oauthProviderEditAction } from './oauth-provider-edit';

const values: OAuthProviderEditValues = {
  id: 'person',
  name: 'Personal',
  enabled: true,
  alias: { chat: { model: 'model-2', preserve: false } },
  publicValues: { tenant: 'work' },
  secrets: {},
  clearSecrets: [],
};

const transforms: ProviderTransforms = { request: [{ update: [{ $unset: 'request.body.store' }] }] };

test('common-only OAuth edits use the normal provider update', () => {
  expect(oauthProviderEditAction(values, { tenant: 'work' })).toEqual({
    kind: 'update',
    body: {
      kind: 'oauth',
      id: 'person',
      name: 'Personal',
      enabled: true,
      alias: { chat: { model: 'model-2', preserve: false } },
      excludedModels: [],
    },
  });
});

test('account edits start locked reauthorization and omit blank replacement secrets', () => {
  expect(
    oauthProviderEditAction(
      {
        ...values,
        publicValues: { tenant: 'personal' },
        secrets: { token: '', refreshToken: 'replacement' },
        clearSecrets: ['legacyToken'],
      },
      { tenant: 'work' },
    ),
  ).toEqual({
    kind: 'reauthorize',
    input: {
      targetProviderId: 'person',
      publicValues: { tenant: 'personal' },
      secrets: { refreshToken: 'replacement' },
      clearSecrets: ['legacyToken'],
      completeUrl: `${window.location.origin}/dashboard/oauth/complete`,
      providerPatch: {
        name: 'Personal',
        enabled: true,
        alias: { chat: { model: 'model-2', preserve: false } },
        excludedModels: [],
      },
    },
  });
});

test('explicit reauthorization keeps the current draft atomic', () => {
  expect(oauthProviderEditAction(values, { tenant: 'work' }, true).kind).toBe('reauthorize');
});

test('normal OAuth edits preserve request transforms', () => {
  expect(oauthProviderEditAction({ ...values, transforms }, { tenant: 'work' })).toEqual({
    kind: 'update',
    body: expect.objectContaining({ transforms }),
  });
});

test('OAuth reauthorization preserves request transforms in the provider patch', () => {
  expect(oauthProviderEditAction({ ...values, transforms }, { tenant: 'work' }, true)).toEqual({
    kind: 'reauthorize',
    input: expect.objectContaining({ providerPatch: expect.objectContaining({ transforms }) }),
  });
});

test('OAuth proxy edits preserve explicit inheritance across update and reauthorization', () => {
  expect(oauthProviderEditAction({ ...values, proxy: null }, { tenant: 'work' })).toEqual({
    kind: 'update',
    body: expect.objectContaining({ proxy: null }),
  });
  expect(oauthProviderEditAction({ ...values, proxy: null }, { tenant: 'work' }, true)).toEqual({
    kind: 'reauthorize',
    input: expect.objectContaining({ providerPatch: expect.objectContaining({ proxy: null }) }),
  });
});

test('excludedModels and an empty authored alias always go out on both action branches', () => {
  const base = {
    id: 'p',
    enabled: true,
    publicValues: {},
    secrets: {},
    clearSecrets: [],
    excludedModels: ['m1'],
  };
  const update = oauthProviderEditAction(base, {});
  expect(update.kind).toBe('update');
  if (update.kind === 'update') {
    expect(update.body.excludedModels).toEqual(['m1']);
    expect(update.body.alias).toEqual({});
    expect(update.body).not.toHaveProperty('models');
  }

  const reauth = oauthProviderEditAction(base, {}, true);
  expect(reauth.kind).toBe('reauthorize');
  if (reauth.kind === 'reauthorize') {
    expect(reauth.input.providerPatch?.excludedModels).toEqual(['m1']);
    expect(reauth.input.providerPatch?.alias).toEqual({});
    expect(reauth.input.providerPatch).not.toHaveProperty('models');
  }
});

// The routing board owns priority and weight, but core rebuilds the whole oauth entry from this patch
// and reads an omitted routing field as a clear. Dropping them here resets priority to 0 and — worse —
// revives a Provider the user deliberately parked at weight 0 the moment a reauthorization completes.
test('routing values travel with both action branches so a reauthorization cannot clear them', () => {
  const routed = { ...values, priority: 20, weight: 0 };

  const update = oauthProviderEditAction(routed, { tenant: 'work' });
  expect(update).toEqual({ kind: 'update', body: expect.objectContaining({ priority: 20, weight: 0 }) });

  const reauth = oauthProviderEditAction(routed, { tenant: 'work' }, true);
  expect(reauth).toEqual({
    kind: 'reauthorize',
    input: expect.objectContaining({ providerPatch: expect.objectContaining({ priority: 20, weight: 0 }) }),
  });
});

test('a whitespace-only display name is omitted from both action branches', () => {
  const update = oauthProviderEditAction({ ...values, name: '   ' }, { tenant: 'work' });
  expect(update.kind).toBe('update');
  if (update.kind === 'update') expect('name' in update.body).toBe(false);

  const reauth = oauthProviderEditAction({ ...values, name: '   ' }, { tenant: 'work' }, true);
  expect(reauth.kind).toBe('reauthorize');
  if (reauth.kind === 'reauthorize') expect(reauth.input.providerPatch).not.toHaveProperty('name');
});
