import type { AuthorizationPort, ConfigSpec, LocalizedText } from '@aio-proxy/plugin-sdk';
import type { OAuthProviderMutationBody, ProviderAlias, ProviderTransforms } from '@aio-proxy/types';

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
  readonly weight: number | undefined;
  readonly proxy?: OAuthProviderMutationBody['proxy'];
  readonly alias: ProviderAlias | undefined;
  readonly transforms?: ProviderTransforms | undefined;
};
export type LoginOAuthAccountOptions = {
  readonly targetProviderId?: string;
  readonly capability?: OAuthCapabilityReference;
  readonly providerPatch?: OAuthProviderPatch;
  readonly registry: PluginRegistry;
  readonly repository: PluginRepository;
  readonly config: AtomicConfigFile;
  readonly renderAccountOptions: RenderAccountOptions;
  readonly createAuthorization: (signal: AbortSignal) => AuthorizationPort;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly coordinateProviderCommit?: <T>(capability: OAuthCapabilityReference, commit: () => Promise<T>) => Promise<T>;
  readonly progress?: (message: LocalizedText) => void;
  readonly onAuthorized?: () => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
};
export type LoginOAuthAccountResult = { readonly providerId: string };
export async function loginOAuthAccount(options: LoginOAuthAccountOptions): Promise<LoginOAuthAccountResult> {
  const deadline = deadlineController(options.signal);
  try {
    const initial = await preflight(options, deadline.signal);
    const adapter = options.registry.resolveOAuth(initial.capability.plugin, initial.capability.capability);
    if (adapter === undefined)
      throw new OAuthCapabilityUnavailableError(initial.capability.plugin, initial.capability.capability);
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
    );
    const validated = await validatedLoginResult(adapter, loginResult, deadline.signal);
    if (initial.fingerprint !== undefined && validated.fingerprint !== initial.fingerprint) {
      throw new ProviderFingerprintMismatchError(options.targetProviderId as string);
    }
    options.onAuthorized?.();
    const metadata: { label?: string; expiresAt?: number } = {
      ...(validated.label === undefined ? {} : { label: validated.label }),
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
      discoverOptions: parsedOptions.value,
      deadline,
      discoveryDeadline,
    });
    const state: StageState = {};
    let staged: PendingAccountOperation;
    try {
      const commit = () =>
        options.config.transaction(
          (current) =>
            Promise.resolve(
              stageAccountWrite(
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
              ),
            ),
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
  } finally {
    deadline.close();
  }
}
