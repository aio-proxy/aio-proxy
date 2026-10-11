import type {
  CredentialPort,
  OAuthAdapter,
  OAuthCredentialImportContext,
  OAuthCredentialImporter,
  OAuthLocalSignIn,
  OAuthLocalSignInContext,
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

declare const importContext: OAuthCredentialImportContext;

const cpaImporter: OAuthCredentialImporter<MyOptions, MyCredential> = {
  types: ['example'],
  async import(context, options, raw) {
    const input: unknown = raw;
    context.progress(`Importing ${options.baseURL}`);
    context.signal.throwIfAborted();
    await context.fetch?.('https://provider.example/import');
    void input;
    return { fingerprint: 'account', suggestedKey: 'account', credentials: { accessToken: 'token' } };
  },
};

const importerAdapter: OAuthAdapter<MyOptions, MyCredential> = {
  ...quotaAdapter,
  id: 'importer',
  credentialImports: { cpa: cpaImporter },
};

void cpaImporter.import(importContext, { baseURL: 'https://provider.example' }, {});
api.oauth.register(importerAdapter);

// @ts-expect-error an importer must claim at least one type
const emptyImporter: OAuthCredentialImporter<MyOptions, MyCredential> = { types: [], import: cpaImporter.import };
void emptyImporter;

declare const localSignInContext: OAuthLocalSignInContext;

const localSignIn: OAuthLocalSignIn<MyOptions, MyCredential> = {
  source: { default: 'Example tool', 'zh-Hans': '示例工具' },
  async detect(context) {
    context.signal.throwIfAborted();
    // @ts-expect-error presence detection cannot report account details
    void context.progress;
    // @ts-expect-error presence detection does not receive network access
    void context.fetch;
    return true;
  },
  async read(context, options) {
    context.progress(`Reading ${options.baseURL}`);
    context.signal.throwIfAborted();
    await context.fetch?.('https://provider.example/account');
    return { fingerprint: 'account', suggestedKey: 'account', credentials: { accessToken: 'token' } };
  },
  async write(context, next, previous) {
    const signal: AbortSignal = context.signal;
    const nextToken: string = next.accessToken;
    const previousToken: string = previous.accessToken;
    void signal;
    void nextToken;
    void previousToken;
  },
};

const localSignInAdapter: OAuthAdapter<MyOptions, MyCredential> = { ...quotaAdapter, localSignIn };
api.oauth.register(localSignInAdapter);
void localSignIn.detect(localSignInContext);
void localSignIn.read(importContext, { baseURL: 'https://provider.example' });
void localSignIn.write?.(localSignInContext, { accessToken: 'next' }, { accessToken: 'previous' });

// @ts-expect-error local sign-in reads use the adapter's account options
void localSignIn.read(importContext, { baseURL: 1 });
// @ts-expect-error local sign-in writes use the adapter's credential type
void localSignIn.write?.(localSignInContext, { accessToken: 1 }, { accessToken: 'previous' });

const readOnlyLocalSignIn: OAuthLocalSignIn<MyOptions, MyCredential> = {
  source: 'Example tool',
  detect: localSignIn.detect,
  read: localSignIn.read,
};
void readOnlyLocalSignIn;

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
