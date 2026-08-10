import type {
  CredentialPort,
  OAuthAdapter,
  OAuthLoginResult,
  OAuthQuotaItem,
  PluginApi,
  RuntimeContext,
  RuntimeFetch,
  RuntimeRequestInit,
} from '.';

declare const runtimeFetch: RuntimeFetch;

const standardFetch: typeof globalThis.fetch = runtimeFetch;
const runtimeFetchFromStandard: RuntimeFetch = globalThis.fetch;
const controlInit: RuntimeRequestInit = { aioProxy: { traffic: 'control' } };
void standardFetch;
void runtimeFetchFromStandard;
void runtimeFetch('https://provider.example/model');
void runtimeFetch('https://provider.example/token', controlInit);
void runtimeFetch('https://provider.example/model', { aioProxy: { traffic: 'model' } });

// @ts-expect-error runtime traffic is a closed union
void runtimeFetch('https://provider.example/model', { aioProxy: { traffic: 'background' } });

type MyOptions = {
  readonly baseURL: string;
};

type MyCredential = {
  readonly accessToken: string;
};

declare const runtimeContext: RuntimeContext<MyCredential, MyOptions>;
const requiredRuntimeFetch: RuntimeFetch = runtimeContext.fetch;
void requiredRuntimeFetch;

// @ts-expect-error RuntimeContext exposes one fetch only
void runtimeContext.modelFetch;

declare const api: PluginApi;
declare const adapter: OAuthAdapter<MyOptions, MyCredential>;
declare const credentials: CredentialPort<MyCredential>;

api.oauth.register(adapter);

const quotaAdapter: OAuthAdapter<MyOptions, MyCredential> = {
  id: 'quota',
  displayName: 'Quota',
  account: adapter.account,
  credentials: adapter.credentials,
  login: adapter.login,
  catalog: adapter.catalog,
  createRuntime: adapter.createRuntime,
  quota: {
    async read(context) {
      const credential = await context.credentials.read();
      return {
        items: [{ id: 'primary', displayName: 'Primary', remainingRatio: credential.value.accessToken.length / 100 }],
        resetCredits: { availableCount: 1, items: [{ id: 'credit-1', expiresAt: 1_800_000_000_000 }] },
      };
    },
    async reset(context) {
      await context.credentials.read();
    },
  },
};

api.oauth.register(quotaAdapter);

const proxyUnsupportedAdapter: OAuthAdapter<MyOptions, MyCredential> = {
  ...quotaAdapter,
  id: 'proxy-unsupported',
  supportsProxy: false,
};
api.oauth.register(proxyUnsupportedAdapter);

// @ts-expect-error supportsProxy only accepts booleans
const invalidProxySupport: OAuthAdapter<MyOptions, MyCredential> = { ...quotaAdapter, supportsProxy: 'false' };
void invalidProxySupport;

const loginResult: OAuthLoginResult<MyCredential> = {
  fingerprint: 'account',
  suggestedKey: 'account',
  credentials: { accessToken: 'token' },
};
const quotaItem: OAuthQuotaItem = { id: 'primary', displayName: 'Primary' };

// @ts-expect-error v1 adapter label is removed
const invalidAdapterLabel: OAuthAdapter<MyOptions, MyCredential> = { ...quotaAdapter, label: 'Quota' };
// @ts-expect-error v1 login-result label is removed
const invalidLoginResult: OAuthLoginResult<MyCredential> = { ...loginResult, label: 'account' };
const refreshMetadata: { readonly accountLabel?: string; readonly expiresAt?: number } = {
  // @ts-expect-error v1 credential refresh label is removed
  label: 'account',
};
void credentials.refresh(1, async (current) => ({ value: current.value, metadata: refreshMetadata }));
// @ts-expect-error v1 quota label is removed
const invalidQuotaItem: OAuthQuotaItem = { ...quotaItem, label: 'Primary' };
// @ts-expect-error quota timestamps are epoch milliseconds
const invalidResetAt: OAuthQuotaItem = { id: 'primary', displayName: 'Primary', resetsAt: new Date() };
void invalidAdapterLabel;
void invalidLoginResult;
void invalidQuotaItem;
void invalidResetAt;
