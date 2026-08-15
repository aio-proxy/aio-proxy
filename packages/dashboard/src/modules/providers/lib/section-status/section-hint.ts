import { m } from '@aio-proxy/i18n';

import { PROVIDER_AI_SDK_DEFAULT_PACKAGE } from '../constants';
import { exposedModels } from '../exposed-models';
import type { SectionStatus, SectionStatusInput } from './section-status';

// The finished badge text for each section. A hint always follows the status it accompanies, so it
// can never name a problem the status does not have.

/** `undefined` is an untouched field the schema defaults; `''` is one the user emptied. */
export const blankPackageName = (packageName: string | undefined): boolean =>
  packageName !== undefined && packageName.trim() === '';

export const identityHint = (input: SectionStatusInput, status: SectionStatus): string =>
  status === 'todo' ? m['dashboard.providers.editor.hint_identity_todo']() : input.id.trim();

export const connectionHint = (input: SectionStatusInput, status: SectionStatus): string => {
  if (input.kind === 'oauth') {
    if (status === 'todo') return m['dashboard.providers.editor.hint_connection_todo_oauth']();
    if (status === 'attention') return m['dashboard.providers.editor.hint_connection_oauth_unauthorized']();
    return m['dashboard.providers.editor.hint_connection_oauth_ready']();
  }
  if (input.kind === 'ai-sdk') {
    if (blankPackageName(input.packageName)) return m['dashboard.providers.editor.hint_connection_todo_ai_sdk']();
    // Invalid options are todo too. Naming the package there says less than the options editor's own
    // JSON error, but it is never wrong; "needs a package name" would be.
    return input.packageName ?? PROVIDER_AI_SDK_DEFAULT_PACKAGE;
  }
  if (status === 'todo') return m['dashboard.providers.editor.hint_connection_todo_api']();
  if (status === 'attention') return m['dashboard.providers.editor.hint_connection_no_api_key']();
  return (input.baseURL ?? '').trim().replace(/^https?:\/\//u, '');
};

export const modelsHint = (input: SectionStatusInput, status: SectionStatus): string => {
  if (status === 'attention') return m['dashboard.providers.editor.hint_models_stale']();
  const count = exposedModels(input.models, input.discoveredModels).length;
  if (count === 0) return m['dashboard.providers.editor.hint_models_todo']();
  const aliases = input.aliasCount ?? 0;
  return aliases === 0
    ? m['dashboard.providers.editor.hint_models_count']({ count })
    : m['dashboard.providers.editor.hint_models_count_aliases']({ count, aliases });
};

export const routingHint = (input: SectionStatusInput, status: SectionStatus): string => {
  if (status === 'todo') return m['dashboard.providers.editor.hint_routing_alias_issues']();
  if (status === 'attention') return m['dashboard.providers.editor.hint_routing_weight_tie']();
  // A disabled provider is never materialized, so its weight would describe routing it never joins.
  if (input.enabled === false) return m['dashboard.providers.editor.hint_routing_disabled']();
  // Absent coalesces to 0 at the single ordering point, config.ts:185.
  return m['dashboard.providers.editor.hint_routing_weight']({ weight: input.weight ?? 0 });
};

export const advancedHint = (input: SectionStatusInput): string => {
  const headers = input.headerCount ?? 0;
  const transforms = input.transformCount ?? 0;
  const parts = [
    headers > 0 ? m['dashboard.providers.editor.hint_advanced_headers']({ count: headers }) : '',
    input.proxyCustom === true ? m['dashboard.providers.editor.hint_advanced_proxy']() : '',
    transforms > 0 ? m['dashboard.providers.editor.hint_advanced_transforms']({ count: transforms }) : '',
  ].filter((part) => part !== '');
  // Punctuation, not copy: the separator is identical in every locale.
  return parts.length === 0 ? m['dashboard.providers.editor.hint_advanced_defaults']() : parts.join(' · ');
};
