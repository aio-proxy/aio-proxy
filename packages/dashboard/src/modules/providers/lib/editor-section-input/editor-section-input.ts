import type { ProviderKind } from '@aio-proxy/types';

import type { ProviderEditorShape } from '../../hooks/use-provider-editor-form';
import { aliasEditorIssues } from '../alias-editor';
import type { ProviderFormMode } from '../constants';
import { oauthEditorExposedModels } from '../exposed-models';
import type { SectionStatusInput } from '../section-status';

export const editorSectionInput = (
  values: ProviderEditorShape,
  kind: ProviderKind,
  mode: ProviderFormMode,
  extras: {
    readonly authorized: boolean;
    readonly capabilityKey: string;
    readonly discoveredModels: readonly string[] | undefined;
    readonly hasApiKey: boolean;
    readonly optionsValid: boolean;
    readonly transformsValid: boolean;
    readonly transformCount: number;
  },
): SectionStatusInput => {
  const models = values.kind === 'oauth' ? [] : (values.models ?? []);
  const discoveryMode = values.kind === 'oauth' || values.syncModels === true;
  // Empty sync lists mean discovery has not succeeded; failures never replace a good catalog.
  const discoveredModels =
    values.kind !== 'oauth' && values.syncModels === true && extras.discoveredModels?.length === 0
      ? undefined
      : extras.discoveredModels;
  const exposed = discoveryMode ? oauthEditorExposedModels(discoveredModels, values.excludedModels) : models;
  const aliasTargets = values.kind !== 'oauth' && values.syncModels === true ? discoveredModels : exposed;
  return {
    kind: values.kind ?? kind,
    mode,
    id: values.id ?? '',
    ...(values.kind === 'api'
      ? {
          baseURL: values.baseURL,
          protocol: values.protocol,
          endpoints: values.endpoints,
          apiKey: values.apiKey,
          hasApiKey: extras.hasApiKey,
        }
      : {}),
    capabilityKey: extras.capabilityKey,
    authorized: extras.authorized,
    packageName: values.kind === 'ai-sdk' ? values.packageName : undefined,
    models,
    syncModels: values.kind === 'oauth' ? undefined : values.syncModels,
    excludedModels: discoveryMode ? values.excludedModels : undefined,
    discoveredModels: discoveryMode ? discoveredModels : undefined,
    aliasCount: (values.alias ?? []).length,
    aliasIssues: aliasEditorIssues(values.alias ?? [], aliasTargets),
    transformsValid: extras.transformsValid,
    transformCount: extras.transformCount,
    headerCount: values.kind === 'api' ? Object.keys(values.headers ?? {}).length : 0,
    proxyCustom: values.proxy !== undefined && values.proxy !== null,
    optionsValid: extras.optionsValid,
  };
};
