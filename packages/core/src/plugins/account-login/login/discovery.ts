import type { CredentialPort, OAuthAdapter } from '@aio-proxy/plugin-sdk';

import { validateModelCatalog } from '../../catalog';
import { collectSecretStrings, redactPluginError } from '../../diagnostic/index';
import { withAbort } from '../deadline';
import type { OAuthAccountWriteOptions } from '../login';
import type { Preflight } from './preflight';
import type { CatalogDiscovery } from './stage';

type Deadline = { readonly signal: AbortSignal; readonly close: () => void };

export type DiscoverCatalogInput = {
  readonly adapter: OAuthAdapter;
  readonly initial: Preflight;
  readonly options: OAuthAccountWriteOptions;
  readonly secrets: unknown;
  readonly credentialPort: CredentialPort<unknown>;
  readonly currentCredential: () => unknown;
  readonly discoverOptions: unknown;
  readonly deadline: Deadline;
  readonly discoveryDeadline: Deadline;
};

export async function discoverCatalog(input: DiscoverCatalogInput): Promise<CatalogDiscovery> {
  const { adapter, initial, options, secrets, credentialPort, currentCredential, discoverOptions } = input;
  const { deadline, discoveryDeadline } = input;
  try {
    return {
      kind: 'success',
      catalog: validateModelCatalog(
        await withAbort(discoveryDeadline.signal, () =>
          adapter.catalog.discover({
            credentials: credentialPort,
            options: discoverOptions,
            signal: discoveryDeadline.signal,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        ),
      ),
    };
  } catch (error) {
    if (deadline.signal.aborted) throw error;
    const fallback = initial.account === undefined ? adapter.catalog.initialFallback?.(error) : undefined;
    const discovered: CatalogDiscovery =
      fallback === undefined
        ? { kind: 'failure', error }
        : { kind: 'success', catalog: validateModelCatalog(fallback) };
    if (discovered.kind === 'failure') {
      options.logger({
        event: 'plugin.catalog.discovery.failed',
        code: 'CATALOG_UNAVAILABLE',
        context: { plugin: initial.capability.plugin, capability: initial.capability.capability },
        error: redactPluginError(error, {
          secretValues: [...collectSecretStrings(secrets), ...collectSecretStrings(currentCredential())],
        }),
      });
    }
    return discovered;
  } finally {
    discoveryDeadline.close();
  }
}
