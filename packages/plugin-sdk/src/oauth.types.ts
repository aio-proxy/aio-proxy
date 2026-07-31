import type { OAuthAdapter, OAuthQuotaItem, PluginApi, RuntimeContext, RuntimeFetch, RuntimeRequestInit } from '.';

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

api.oauth.register(adapter);

const quotaAdapter: OAuthAdapter<MyOptions, MyCredential> = {
  id: 'quota',
  label: 'Quota',
  account: adapter.account,
  credentials: adapter.credentials,
  login: adapter.login,
  catalog: adapter.catalog,
  createRuntime: adapter.createRuntime,
  quota: {
    async read(context) {
      const credential = await context.credentials.read();
      return {
        items: [{ id: 'primary', label: 'Primary', remainingRatio: credential.value.accessToken.length / 100 }],
        resetCredits: { availableCount: 1, items: [{ id: 'credit-1', expiresAt: 1_800_000_000_000 }] },
      };
    },
    async reset(context) {
      await context.credentials.read();
    },
  },
};

api.oauth.register(quotaAdapter);

// @ts-expect-error quota timestamps are epoch milliseconds
const invalidResetAt: OAuthQuotaItem = { id: 'primary', label: 'Primary', resetsAt: new Date() };
void invalidResetAt;
