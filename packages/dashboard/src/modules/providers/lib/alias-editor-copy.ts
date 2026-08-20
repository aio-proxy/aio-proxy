import { m } from '@aio-proxy/i18n';

import type { AliasEditorIssue, AliasSummary } from './alias-editor';

export function aliasIssueMessage(issue: AliasEditorIssue): string {
  switch (issue.code) {
    case 'alias-name-duplicate':
      return m['dashboard.providers.form.error_name_duplicate']();
    case 'alias-name-required':
      return m['dashboard.providers.form.error_name_required']();
    case 'preserved-route-conflict':
      return m['dashboard.providers.form.error_preserved_route_conflict']();
    case 'target-missing':
      return m['dashboard.providers.form.error_target_missing']();
    case 'variant-when-duplicate':
      return m['dashboard.providers.form.variant_when_duplicate']();
    case 'variant-when-required':
      return m['dashboard.providers.form.variant_when_required']();
  }
}

export function aliasSummaryMessage(summary: AliasSummary): string {
  const aliases =
    summary.aliases === 1
      ? m['dashboard.providers.form.aliases_summary_alias']({ count: summary.aliases })
      : m['dashboard.providers.form.aliases_summary_aliases']({ count: summary.aliases });
  const variants =
    summary.variants === 1
      ? m['dashboard.providers.form.aliases_summary_variant']({ count: summary.variants })
      : m['dashboard.providers.form.aliases_summary_variants']({ count: summary.variants });
  return `${aliases} · ${variants}`;
}
