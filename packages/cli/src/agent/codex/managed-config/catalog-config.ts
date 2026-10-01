import type { CodexCatalog } from '@aio-proxy/server';

import { editCodexDocument, readManagedField } from '../config-document';
import type { CodexCatalogUpdateResult, CodexLocation, CodexMarker, OwnedField } from '../contracts';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import {
  catalogOwnedField,
  catalogReference,
  prepareCodexCatalog,
  pruneCodexCatalogs,
  validateCatalogPath,
} from './catalog-storage';
import { completeOperation, recoverPending, runExclusive } from './config-operation';
import { changedFields } from './inspect';
import { fingerprint } from './journal';
import { appliedProviderBaseUrl, readMarker, validateMarker } from './marker';
import { readRegularFile } from './storage';

export async function updateManagedCodexCatalog(
  input: {
    readonly location: CodexLocation;
    readonly baseUrl: string;
    readonly catalog: CodexCatalog;
    readonly signal: AbortSignal;
  },
  lease?: CodexLease,
): Promise<CodexCatalogUpdateResult> {
  const update = (owned: CodexLease): Promise<CodexCatalogUpdateResult> =>
    owned.withOwnership(async () =>
      runExclusive(input.location.markerPath, async () => {
        const { location, baseUrl, catalog, signal } = input;
        signal.throwIfAborted();
        await owned.withOwnershipFence((assertOwned) => recoverPending(location, assertOwned));
        const marker = await readMarker(location);
        const current = await readRegularFile(location.configPath);
        if (marker === undefined || current === undefined || changedFields(marker, current.text).length > 0)
          return 'skipped';
        const provider = readManagedField(current.text, ['model_provider']);
        if (!provider.present || provider.value !== marker.providerId || appliedProviderBaseUrl(marker) !== baseUrl)
          return 'skipped';
        const prior = catalogOwnedField(marker);
        const actual = readManagedField(current.text, ['model_catalog_json']);
        if (prior === undefined && actual.present) return 'skipped';
        const previous = catalogReference(prior?.applied);
        // A missing digest is repairable; an existing, modified digest is never replaceable.
        if (previous !== undefined) await validateCatalogPath(location, previous, true);
        signal.throwIfAborted();
        const prepared = await prepareCodexCatalog(location, catalog, owned);
        if (previous === prepared.path) {
          return 'unchanged';
        }
        const next: OwnedField = {
          path: ['model_catalog_json'],
          before: prior?.before ?? actual,
          applied: { present: true, value: prepared.path },
        };
        const nextMarker: CodexMarker = {
          ...marker,
          fields: [...marker.fields.filter((field) => field !== prior), next],
        };
        validateMarker(nextMarker, location);
        const nextText = editCodexDocument(current.text, [{ path: next.path, next: next.applied }]);
        signal.throwIfAborted();
        await completeOperation(
          location,
          {
            operation: 'configure',
            originalExists: true,
            beforeFingerprint: fingerprint(current.text),
            afterFingerprint: fingerprint(nextText),
            oldMarker: marker,
            targetMarker: nextMarker,
            stage: 'prepared',
          },
          current,
          nextText,
          nextMarker,
          owned,
        );
        await pruneCodexCatalogs(location, previous === undefined ? [prepared.path] : [prepared.path, previous], owned);
        return 'updated';
      }),
    );
  return lease === undefined ? withCodexInstallation(input.location, input.signal, update) : update(lease);
}
