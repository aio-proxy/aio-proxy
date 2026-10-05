import { aliasTargetModels } from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';
import { isEqual, isPlainObject } from 'es-toolkit/predicate';

import type { ProviderEditorInitial, ProviderEditorShape } from '../../hooks/use-provider-editor-form';
import type { AliasRow } from '../alias-editor';
import { apiDraftFromProvider } from '../api-endpoints';
import { oauthEditorExposedModels } from '../exposed-models';

export const manualModelsFromCatalog = (
  discovered: readonly string[] | undefined,
  excludedModels: readonly string[] | undefined,
  alias: readonly AliasRow[],
): string[] => {
  const catalog = discovered ?? [];
  const targets = alias.flatMap((row) => aliasTargetModels(row.config)).filter((id) => catalog.includes(id));
  return uniq([...oauthEditorExposedModels(catalog, excludedModels), ...targets]);
};

const optionsBaseURL = (options: unknown): unknown => (isPlainObject(options) ? options['baseURL'] : undefined);

/** A draft with a different discovery source must never refresh the saved Provider's catalog. */
export const canRefreshSavedCatalog = (
  values: ProviderEditorShape,
  initial: ProviderEditorInitial | undefined,
): boolean => {
  if (values.kind === 'oauth' || values.syncModels !== true || initial?.syncModels !== true) return false;
  if (initial.kind !== undefined && initial.kind !== values.kind) return false;
  const endpoints =
    values.kind === 'api' ? (initial.endpoints ?? apiDraftFromProvider({ ...initial, kind: 'api' })) : undefined;
  return (
    values.protocol === initial.protocol &&
    values.baseURL === initial.baseURL &&
    isEqual(values.endpoints, endpoints) &&
    (values.kind === 'ai-sdk' ? values.packageName === initial.packageName : true) &&
    (values.kind === 'ai-sdk' ? isEqual(optionsBaseURL(values.options), optionsBaseURL(initial.options)) : true)
  );
};
