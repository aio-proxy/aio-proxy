import type { ProviderTransforms } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { type OAuthProviderEditValues, oauthProviderEditAction } from './oauth-provider-edit';

const values: OAuthProviderEditValues = {
  id: 'person',
  name: 'Personal',
  enabled: true,
  priority: 4,
  weight: 2,
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
      priority: 4,
      weight: 2,
      alias: { chat: { model: 'model-2', preserve: false } },
      metadata: {},
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
        priority: 4,
        weight: 2,
        alias: { chat: { model: 'model-2', preserve: false } },
        metadata: {},
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

// A credential change and a metadata edit arrive in the same save. Routing that save through
// reauthorization used to drop the metadata half on the floor: the login path rebuilds the provider
// entry, so anything missing from the patch reverts to whatever was last on disk.
test('metadata rides both action branches', () => {
  const metadata = { a: { name: 'A' } };
  const update = oauthProviderEditAction({ ...values, metadata }, { tenant: 'work' });
  expect(update.kind).toBe('update');
  if (update.kind === 'update') expect(update.body.metadata).toEqual(metadata);

  const reauth = oauthProviderEditAction({ ...values, metadata }, { tenant: 'work' }, true);
  expect(reauth.kind).toBe('reauthorize');
  if (reauth.kind === 'reauthorize') expect(reauth.input.providerPatch?.metadata).toEqual(metadata);
});

test('whitelist round-trips through both action branches', () => {
  const base = {
    id: 'p',
    enabled: true,
    publicValues: {},
    secrets: {},
    clearSecrets: [],
    models: ['m1', 'm2'],
  };
  const update = oauthProviderEditAction(base, {});
  expect(update.kind).toBe('update');
  if (update.kind === 'update') expect(update.body.models).toEqual(['m1', 'm2']);

  const reauth = oauthProviderEditAction(base, {}, true);
  expect(reauth.kind).toBe('reauthorize');
  if (reauth.kind === 'reauthorize') expect(reauth.input.providerPatch?.models).toEqual(['m1', 'm2']);
});

test('a whitespace-only display name is omitted from both action branches', () => {
  const update = oauthProviderEditAction({ ...values, name: '   ' }, { tenant: 'work' });
  expect(update.kind).toBe('update');
  if (update.kind === 'update') expect('name' in update.body).toBe(false);

  const reauth = oauthProviderEditAction({ ...values, name: '   ' }, { tenant: 'work' }, true);
  expect(reauth.kind).toBe('reauthorize');
  if (reauth.kind === 'reauthorize') expect(reauth.input.providerPatch).not.toHaveProperty('name');
});
