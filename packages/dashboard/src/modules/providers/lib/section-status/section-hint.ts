import { m } from '@aio-proxy/i18n';

import { PROVIDER_AI_SDK_DEFAULT_PACKAGE } from '../constants';
import { exposedModels } from '../exposed-models';
import type { SectionStatus, SectionStatusInput } from './section-status';

// The finished badge text for each section. A hint always follows the status it accompanies, so it
// can never name a problem the status does not have.

/** `undefined` is an untouched field the schema defaults; `''` is one the user emptied. */
export const blankPackageName = (packageName: string | undefined): boolean =>
  packageName !== undefined && packageName.trim() === '';

export const identityHint = (input: SectionStatusInput, status: SectionStatus): string => {
  if (status === 'todo') return m['dashboard.providers.editor.hint_identity_todo']();
  const id = input.id.trim();
  // oauth creation is `ok` with an empty id because the server assigns it. Falling through to the
  // raw id would render a badge holding nothing but a dot.
  return id === '' ? m['dashboard.providers.editor.hint_identity_server_assigned']() : id;
};

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

/**
 * oauth's empty whitelist means "expose the whole upstream catalog" (`section-status.ts`), so counting a
 * catalog the dashboard never fetched would print "0 models" for a provider that exposes all of them.
 * api and ai-sdk route only what their whitelist plus alias map name, so 0 is true there.
 */
const exposureText = (input: SectionStatusInput): string => {
  const count = exposedModels(input.models, input.discoveredModels).length;
  if (count === 0 && input.kind === 'oauth') return m['dashboard.providers.editor.hint_models_all']();
  return count === 1
    ? m['dashboard.providers.editor.hint_models_count_model']({ count })
    : m['dashboard.providers.editor.hint_models_count_models']({ count });
};

/** The same pair the alias block itself renders, so both places count aliases in one voice. */
const aliasText = (count: number): string =>
  count === 1
    ? m['dashboard.providers.form.aliases_summary_alias']({ count })
    : m['dashboard.providers.form.aliases_summary_aliases']({ count });

export const modelsHint = (input: SectionStatusInput, status: SectionStatus): string => {
  // Before the exposure count and before `hint_models_todo`: an alias pointing at nothing is the one
  // thing in this section that blocks the save, so it is what the badge has to say.
  if (input.aliasIssues.length > 0) return m['dashboard.providers.editor.hint_models_alias_issues']();
  if (status === 'attention') return m['dashboard.providers.editor.hint_models_stale']();
  // Keyed off the status, not off the count: an oauth provider whose catalog could not be fetched
  // exposes everything and is `ok`, so "no models enabled" would be false there.
  if (status === 'todo') return m['dashboard.providers.editor.hint_models_todo']();
  const exposure = exposureText(input);
  const aliases = input.aliasCount ?? 0;
  return aliases === 0 ? exposure : `${exposure} · ${aliasText(aliases)}`;
};

export const routingHint = (input: SectionStatusInput, status: SectionStatus): string => {
  // First and unconditionally: a disabled provider is never materialized, so every other thing this
  // badge could say — its weight, or a tie inside an attempt queue it never joins — describes routing
  // it takes no part in.
  if (input.enabled === false) return m['dashboard.providers.editor.hint_routing_disabled']();
  if (status === 'attention') return m['dashboard.providers.editor.hint_routing_weight_tie']();
  // Absent coalesces to 0 at the single ordering point, config.ts:185 — but that is ordering, not
  // readout. The attempt-order queue beside this badge renders a dash for an absent weight, so
  // printing `0` here would have the same screen state two things at once, and would make a stored
  // `0` indistinguishable from a key that was never written.
  if (input.weight === undefined) return m['dashboard.providers.editor.hint_routing_no_weight']();
  return m['dashboard.providers.editor.hint_routing_weight']({ weight: input.weight });
};

const headerText = (count: number): string =>
  count === 1
    ? m['dashboard.providers.editor.hint_advanced_header']({ count })
    : m['dashboard.providers.editor.hint_advanced_headers']({ count });

const transformText = (count: number): string =>
  count === 1
    ? m['dashboard.providers.editor.hint_advanced_transform']({ count })
    : m['dashboard.providers.editor.hint_advanced_transforms']({ count });

export const advancedHint = (input: SectionStatusInput, status: SectionStatus): string => {
  // Unparseable transforms JSON leaves `transformCount` on the last valid value, so the counts alone
  // would read "All defaults" beside a save-blocking dot.
  if (status === 'todo') return m['dashboard.providers.editor.hint_advanced_todo']();
  const headers = input.headerCount ?? 0;
  const transforms = input.transformCount ?? 0;
  const parts = [
    headers > 0 ? headerText(headers) : '',
    input.proxyCustom === true ? m['dashboard.providers.editor.hint_advanced_proxy']() : '',
    transforms > 0 ? transformText(transforms) : '',
  ].filter((part) => part !== '');
  // Punctuation, not copy: the separator is identical in every locale.
  return parts.length === 0 ? m['dashboard.providers.editor.hint_advanced_defaults']() : parts.join(' · ');
};
