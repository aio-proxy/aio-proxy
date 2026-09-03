import type {
  AuthorizationPort,
  ConfigSpec,
  LocalizedText,
  OAuthAdapter,
  OAuthLoginResult,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import type { AuthoredOAuthAlias, OAuthProviderMutationBody, ProviderTransforms } from '@aio-proxy/types';

import { AtomicConfigCommitUncertainError, type AtomicConfigFile } from '../config-file';
import { type DiagnosticFactory, type PluginLogSink } from '../diagnostic/index';
import type { PluginRegistry } from '../registry';
import type { PendingAccountOperation, PluginRepository } from '../repository/index';
import {
  CATALOG_DISCOVERY_TIMEOUT_MS,
  childDeadline,
  deadlineController,
  loginWithProtectedAuthorization,
  withAbort,
} from './deadline';
import {
  type OAuthCapabilityReference,
  OAuthCapabilityUnavailableError,
  OAuthCredentialImportUnsupportedError,
  OAuthProxyUnsupportedError,
  ProviderFingerprintMismatchError,
} from './errors';
import { discoverCatalog } from './login/discovery';
import { preflight } from './login/preflight';
import { type StageState, stageAccountWrite } from './login/stage';
import { safeSupersededDiagnostic } from './recovery';
import {
  inMemoryCredentialPort,
  validatedAccountOptions,
  validatedLoginResult,
  validateStagedOAuthWrite,
} from './validation';

export type RenderAccountOptionsInput = {
  readonly spec: ConfigSpec<unknown>;
  readonly currentPublicValues: Readonly<Record<string, unknown>>;
  readonly currentSecrets: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
};
export type RenderAccountOptions = (
  input: RenderAccountOptionsInput,
) => Promise<{ readonly publicValues: Record<string, unknown>; readonly secrets: Record<string, unknown> }>;
export type OAuthProviderPatch = {
  readonly name: string | undefined;
  readonly enabled: boolean;
  readonly priority?: number | undefined;
  readonly weight: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias: AuthoredOAuthAlias | undefined;
  readonly excludedModels?: readonly string[] | undefined;
  readonly transforms?: ProviderTransforms | undefined;
};
export type OAuthAccountWriteOptions = {
  readonly targetProviderId?: string;
  readonly capability?: OAuthCapabilityReference;
  readonly providerPatch?: OAuthProviderPatch;
  readonly registry: PluginRegistry;
  readonly repository: PluginRepository;
  readonly config: AtomicConfigFile;
  readonly fetch?: RuntimeFetch;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly coordinateProviderCommit?: <T>(capability: OAuthCapabilityReference, commit: () => Promise<T>) => Promise<T>;
  readonly validateProviderCommit?: (
    capability: OAuthCapabilityReference,
    current: Readonly<Record<string, unknown>>,
  ) => Promise<void> | void;
  readonly progress?: (message: LocalizedText) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
};

export type LoginOAuthAccountOptions = OAuthAccountWriteOptions & {
  readonly renderAccountOptions: RenderAccountOptions;
  readonly createAuthorization: (signal: AbortSignal) => AuthorizationPort;
  readonly onAuthorized?: () => void;
};

export type ImportOAuthAccountOptions = Omit<
  OAuthAccountWriteOptions,
  'targetProviderId' | 'capability' | 'providerPatch'
> & {
  readonly source: 'cpa';
  readonly type: string;
  readonly raw: unknown;
};

export type ImportOAuthAccountResult = LoginOAuthAccountResult;
export type LoginOAuthAccountResult = { readonly providerId: string };
export async function loginOAuthAccount(options: LoginOAuthAccountOptions): Promise<LoginOAuthAccountResult> {
  const deadline = deadlineController(options.signal);
  try {
    const initial = await preflight(options, deadline.signal);
    const adapter = options.registry.resolveOAuth(initial.capability.plugin, initial.capability.capability);
    if (adapter === undefined)
      throw new OAuthCapabilityUnavailableError(initial.capability.plugin, initial.capability.capability);
    if (adapter.supportsProxy === false && initial.hasEffectiveProxy) {
      throw new OAuthProxyUnsupportedError(initial.capability.plugin, initial.capability.capability);
    }
    const rendered = await withAbort(deadline.signal, () =>
      options.renderAccountOptions({
        spec: adapter.account.options,
        currentPublicValues: initial.publicOptions,
        currentSecrets: initial.secrets,
        signal: deadline.signal,
      }),
    );
    const parsedOptions = await validatedAccountOptions(adapter, rendered, deadline.signal);
    const loginResult = await loginWithProtectedAuthorization(
      adapter,
      () => options.createAuthorization(deadline.signal),
      options.progress ?? (() => {}),
      deadline.signal,
      parsedOptions.value,
      options.fetch,
    );
    return await persistOAuthAccount({
      options,
      initial,
      adapter,
      rendered,
      parsedOptions: parsedOptions.value,
      rawResult: loginResult,
      deadline,
      afterValidation: options.onAuthorized,
    });
  } finally {
    deadline.close();
  }
}

export async function importOAuthAccount(options: ImportOAuthAccountOptions): Promise<ImportOAuthAccountResult> {
  const deadline = deadlineController(options.signal);
  try {
    const type = options.type.trim();
    const capability = options.registry
      .oauthCapabilities()
      .find(({ adapter }) => adapter.credentialImports?.cpa?.types.includes(type));
    const importer = capability?.adapter.credentialImports?.cpa;
    if (capability === undefined || importer === undefined) {
      throw new OAuthCredentialImportUnsupportedError(options.source, type);
    }
    const writeOptions: OAuthAccountWriteOptions = {
      ...options,
      capability: { plugin: capability.plugin, capability: capability.capability },
    };
    const initial = await preflight(writeOptions, deadline.signal);
    if (capability.adapter.supportsProxy === false && initial.hasEffectiveProxy) {
      throw new OAuthProxyUnsupportedError(capability.plugin, capability.capability);
    }
    const rendered = { publicValues: {}, secrets: {} };
    const parsedOptions = await validatedAccountOptions(capability.adapter, rendered, deadline.signal);
    const rawResult = await withAbort(deadline.signal, () =>
      importer.import(
        {
          progress: options.progress ?? (() => {}),
          signal: deadline.signal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        },
        parsedOptions.value,
        options.raw,
      ),
    );
    return await persistOAuthAccount({
      options: writeOptions,
      initial,
      adapter: capability.adapter,
      rendered,
      parsedOptions: parsedOptions.value,
      rawResult,
      deadline,
    });
  } finally {
    deadline.close();
  }
}

async function persistOAuthAccount(input: {
  readonly options: OAuthAccountWriteOptions;
  readonly initial: Awaited<ReturnType<typeof preflight>>;
  readonly adapter: OAuthAdapter;
  readonly rendered: { readonly publicValues: Record<string, unknown>; readonly secrets: Record<string, unknown> };
  readonly parsedOptions: unknown;
  readonly rawResult: OAuthLoginResult<unknown>;
  readonly deadline: ReturnType<typeof deadlineController>;
  readonly afterValidation?: () => void;
}): Promise<LoginOAuthAccountResult> {
  const { options, initial, adapter, rendered, parsedOptions, rawResult, deadline } = input;
  const validated = await validatedLoginResult(adapter, rawResult, deadline.signal);
  if (initial.fingerprint !== undefined && validated.fingerprint !== initial.fingerprint) {
    throw new ProviderFingerprintMismatchError(options.targetProviderId as string);
  }
  input.afterValidation?.();
  const metadata: { accountLabel?: string; expiresAt?: number } = {
    ...(validated.accountLabel === undefined ? {} : { accountLabel: validated.accountLabel }),
    ...(validated.expiresAt === undefined ? {} : { expiresAt: validated.expiresAt }),
  };
  const discoveryDeadline = childDeadline(deadline.signal, CATALOG_DISCOVERY_TIMEOUT_MS);
  const credentials = inMemoryCredentialPort(adapter, validated.credential, discoveryDeadline.signal, metadata);
  const discovered = await discoverCatalog({
    adapter,
    initial,
    options,
    secrets: rendered.secrets,
    credentialPort: credentials.port,
    currentCredential: credentials.current,
    discoverOptions: parsedOptions,
    deadline,
    discoveryDeadline,
  });
  const state: StageState = {};
  let staged: PendingAccountOperation;
  try {
    const commit = () =>
      options.config.transaction(
        async (current) => {
          await options.validateProviderCommit?.(initial.capability, current);
          return stageAccountWrite(
            current,
            {
              options,
              initial,
              adapter,
              discovered,
              publicValues: rendered.publicValues,
              secrets: rendered.secrets,
              currentCredential: credentials.current,
              fingerprint: validated.fingerprint,
              suggestedKey: validated.suggestedKey,
              metadata,
              diagnostics: options.diagnostics,
              signal: deadline.signal,
            },
            state,
          );
        },
        { validateCandidate: validateStagedOAuthWrite, signal: deadline.signal },
      );
    staged = await (options.coordinateProviderCommit === undefined
      ? commit()
      : options.coordinateProviderCommit(initial.capability, commit));
  } catch (error) {
    if (state.operation !== undefined && !(error instanceof AtomicConfigCommitUncertainError)) {
      const status = options.repository.compensateAccountOperation(state.operation.operationId);
      if (status === 'superseded' && state.providerId !== undefined)
        safeSupersededDiagnostic(state.providerId, options.repository, options.diagnostics, options.logger);
    }
    throw error;
  }
  options.repository.completeAccountOperation(staged.operationId);
  return { providerId: staged.providerId };
}
