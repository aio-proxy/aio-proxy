import { OAuthProxyUnsupportedError } from '.';
import {
  authorization,
  createAccount,
  emptyCatalog,
  expect,
  fixture,
  loginOAuthAccount,
  options,
  registry,
  test,
} from './test-support';

type ProxySetup = { readonly global?: string; readonly provider?: string | false };

async function configureProxy(state: ReturnType<typeof fixture>, setup: ProxySetup): Promise<void> {
  await state.config.replace((current) => {
    const providers = current['providers'] as Record<string, Record<string, unknown>>;
    const person = { ...providers['person'] };
    if (setup.provider === undefined) delete person['proxy'];
    else person['proxy'] = setup.provider;
    const next: Record<string, unknown> = { ...current, providers: { ...providers, person } };
    if (setup.global !== undefined) next['proxy'] = setup.global;
    return next;
  });
}

test.each([
  ['an inherited global proxy', { global: 'https://global.example:8443' }, undefined],
  ['a provider proxy', { provider: 'https://provider.example:8443' }, undefined],
  [
    'a cleared false override that resumes inheritance',
    { global: 'https://global.example:8443', provider: false },
    null,
  ],
] as const)('rejects %s before form, authorization, login, or catalog work', async (_name, setup, patchProxy) => {
  const state = fixture();
  await createAccount(state);
  await configureProxy(state, setup);
  const calls = { render: 0, authorization: 0, login: 0, discover: 0 };
  const attempt = loginOAuthAccount(
    options(state, {
      targetProviderId: 'person',
      capability: undefined,
      registry: registry({
        supportsProxy: false,
        login: async () => {
          calls.login++;
          throw new Error('login must not run');
        },
        discover: async () => {
          calls.discover++;
          return emptyCatalog();
        },
      }),
      renderAccountOptions: async () => {
        calls.render++;
        return { publicValues: {}, secrets: {} };
      },
      createAuthorization: () => {
        calls.authorization++;
        return authorization;
      },
      ...(patchProxy === undefined
        ? {}
        : {
            providerPatch: {
              name: undefined,
              enabled: true,
              weight: undefined,
              proxy: patchProxy,
              alias: undefined,
            },
          }),
    }),
  );

  await expect(attempt).rejects.toBeInstanceOf(OAuthProxyUnsupportedError);
  await expect(attempt).rejects.toThrow('PROXY_UNSUPPORTED');
  expect(calls).toEqual({ render: 0, authorization: 0, login: 0, discover: 0 });
});

test('proxy false disables inherited global proxy and permits login', async () => {
  const state = fixture();
  await createAccount(state);
  await configureProxy(state, { global: 'https://global.example:8443', provider: false });
  const calls = { login: 0, discover: 0 };

  const result = await loginOAuthAccount(
    options(state, {
      targetProviderId: 'person',
      capability: undefined,
      registry: registry({
        supportsProxy: false,
        login: async () => {
          calls.login++;
          return { fingerprint: 'person@example.com', suggestedKey: 'person', credentials: { token: 'new' } };
        },
        discover: async () => {
          calls.discover++;
          return emptyCatalog();
        },
      }),
    }),
  );

  expect(result).toEqual({ providerId: 'person' });
  expect(calls).toEqual({ login: 1, discover: 1 });
});
