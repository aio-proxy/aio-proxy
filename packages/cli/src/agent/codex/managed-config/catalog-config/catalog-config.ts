import type { CodexCatalog } from '@aio-proxy/server';

import { editCodexDocument, readManagedField, type FieldEdit } from '../../config-document';
import type { CodexCatalogUpdateResult, CodexLocation, CodexMarker, OwnedField } from '../../contracts';
import { withCodexInstallation, type CodexLease } from '../../storage/installation-lock';
import {
  catalogOwnedField,
  catalogReference,
  prepareCodexCatalog,
  pruneCodexCatalogs,
  validateCatalogPath,
} from '../catalog-storage';
import { completeOperation, recoverPending, runExclusive } from '../config-operation';
import { changedFields } from '../inspect';
import { fingerprint } from '../journal';
import { appliedProviderBaseUrl, readMarker, validateMarker } from '../marker';
import { readRegularFile } from '../storage';

// Both callers hold the installation lease; recovery must precede this inspection.
async function eligibleCatalogTarget(location: CodexLocation, baseUrl: string) {
  const marker = await readMarker(location);
  const current = await readRegularFile(location.configPath);
  if (marker === undefined || current === undefined || changedFields(marker, current.text).length > 0) return undefined;
  const provider = readManagedField(current.text, ['model_provider']);
  if (!provider.present || provider.value !== marker.providerId || appliedProviderBaseUrl(marker) !== baseUrl)
    return undefined;
  const prior = catalogOwnedField(marker);
  const actual = readManagedField(current.text, ['model_catalog_json']);
  if (prior === undefined && actual.present) return undefined;
  const previous = catalogReference(prior?.applied);
  // A missing digest is repairable; an existing, modified digest is never replaceable.
  if (previous !== undefined) await validateCatalogPath(location, previous, true);
  return { marker, current, prior, actual, previous };
}

async function commitCatalogField(
  { location, signal }: { readonly location: CodexLocation; readonly signal: AbortSignal },
  owned: CodexLease,
  { marker, current }: NonNullable<Awaited<ReturnType<typeof eligibleCatalogTarget>>>,
  nextMarker: CodexMarker,
  edit: FieldEdit,
): Promise<void> {
  validateMarker(nextMarker, location);
  const nextText = editCodexDocument(current.text, [edit]);
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
}

export async function canUpdateManagedCodexCatalog(
  location: CodexLocation,
  baseUrl: string,
  lease: CodexLease,
): Promise<boolean> {
  return lease.withOwnership(() =>
    runExclusive(location.markerPath, async () => (await eligibleCatalogTarget(location, baseUrl)) !== undefined),
  );
}

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
        const target = await eligibleCatalogTarget(location, baseUrl);
        if (target === undefined) return 'skipped';
        const { marker, prior, actual, previous } = target;
        signal.throwIfAborted();
        // Codex refuses to start on a catalog without models, and an empty catalog usually means
        // model metadata was briefly unavailable. Keep the last good file; with none, hand
        // the field back to its pre-integration value so Codex falls back to its own catalog.
        if (catalog.models.length === 0) {
          if (prior === undefined || (previous !== undefined && (await readRegularFile(previous)) !== undefined))
            return 'empty';
          const fields = marker.fields.filter((field) => field !== prior);
          await commitCatalogField(
            input,
            owned,
            target,
            { ...marker, fields },
            { path: prior.path, next: prior.before },
          );
          return 'empty';
        }
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
        await commitCatalogField(input, owned, target, nextMarker, { path: next.path, next: next.applied });
        await pruneCodexCatalogs(location, previous === undefined ? [prepared.path] : [prepared.path, previous], owned);
        return 'updated';
      }),
    );
  return lease === undefined ? withCodexInstallation(input.location, input.signal, update) : update(lease);
}
