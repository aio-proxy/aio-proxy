import { m } from "@aio-proxy/i18n";

import type { AliasEditorIssue, AliasEditResult, AliasSummary } from "./alias-editor";

export type VisibleEditError = Exclude<Extract<AliasEditResult, { readonly ok: false }>["code"], "alias-missing">;

export function aliasEditErrorMessage(code: VisibleEditError): string {
  switch (code) {
    case "name-duplicate":
      return m["dashboard.providers.form.error_name_duplicate"]();
    case "name-required":
      return m["dashboard.providers.form.error_name_required"]();
    case "target-required":
      return m["dashboard.providers.form.error_target_required"]();
  }
}

export function aliasIssueMessage(issue: AliasEditorIssue): string {
  switch (issue.code) {
    case "alias-name-duplicate":
    case "variant-name-duplicate":
      return m["dashboard.providers.form.error_name_duplicate"]();
    case "alias-name-required":
    case "variant-name-required":
      return m["dashboard.providers.form.error_name_required"]();
    case "preserved-route-conflict":
      return m["dashboard.providers.form.error_preserved_route_conflict"]();
    case "target-missing":
      return m["dashboard.providers.form.error_target_missing"]();
  }
}

export function aliasSummaryMessage(summary: AliasSummary): string {
  const aliases =
    summary.aliases === 1
      ? m["dashboard.providers.form.aliases_summary_alias"]({ count: summary.aliases })
      : m["dashboard.providers.form.aliases_summary_aliases"]({ count: summary.aliases });
  const variants =
    summary.variants === 1
      ? m["dashboard.providers.form.aliases_summary_variant"]({ count: summary.variants })
      : m["dashboard.providers.form.aliases_summary_variants"]({ count: summary.variants });
  return `${aliases} · ${variants}`;
}
