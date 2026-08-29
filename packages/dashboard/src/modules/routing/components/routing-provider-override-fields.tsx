import { m } from '@aio-proxy/i18n';
import { ModelLimitSchema, type ModelCostInput, type ModelLimitInput } from '@aio-proxy/types';

import type { RoutingProviderOverrideDraft } from '../lib/routing-metadata-draft';
import { ModelMetadataNumberField } from './model-metadata-visual-tab';

const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
const LIMIT_FIELDS = ['context', 'input', 'output'] as const;

const COST_LABEL: Readonly<Record<(typeof COST_FIELDS)[number], () => string>> = {
  input: m['dashboard.routing.editor.metadata_cost_label_input'],
  output: m['dashboard.routing.editor.metadata_cost_label_output'],
  cacheRead: m['dashboard.routing.editor.metadata_cost_label_cache_read'],
  cacheWrite: m['dashboard.routing.editor.metadata_cost_label_cache_write'],
  reasoning: m['dashboard.routing.editor.metadata_cost_label_reasoning'],
};

const LIMIT_LABEL: Readonly<Record<(typeof LIMIT_FIELDS)[number], () => string>> = {
  context: m['dashboard.routing.editor.metadata_limit_label_context'],
  input: m['dashboard.routing.editor.metadata_limit_label_input'],
  output: m['dashboard.routing.editor.metadata_limit_label_output'],
};

/** Setting a key to `undefined` clears it; a record with no keys left collapses to `undefined`. */
const withNumber = <T extends Readonly<Record<string, unknown>>>(
  source: T | undefined,
  key: string,
  next: number | undefined,
): T | undefined => {
  const merged: Record<string, unknown> = { ...source };
  if (next === undefined) delete merged[key];
  else merged[key] = next;
  return Object.keys(merged).length === 0 ? undefined : (merged as T);
};

const numberValue = (value: unknown) => (typeof value === 'number' ? value : undefined);

interface RoutingProviderOverrideFieldsProps {
  readonly providerId: string;
  readonly value: RoutingProviderOverrideDraft;
  readonly onChange: (next: RoutingProviderOverrideDraft) => void;
}

/**
 * The drawer's per-provider cost/limit editors. These are the ONLY inputs that ever put cost/limit
 * keys into the PUT body — the board rows stay priority/weight-only — and each group turns into a
 * tri-state draft: untouched groups are omitted, a group cleared to no fields sends `null`.
 */
export const RoutingProviderOverrideFields: React.FC<RoutingProviderOverrideFieldsProps> = ({
  providerId,
  value,
  onChange,
}) => {
  const inherit = m['dashboard.routing.editor.metadata_inherit_placeholder']();
  const cost = value.cost.value as Readonly<Record<string, unknown>> | undefined;
  const limit = value.limit.value as Readonly<Record<string, unknown>> | undefined;
  const limitParsed =
    limit === undefined || Object.keys(limit).length === 0
      ? { success: true as const }
      : ModelLimitSchema.safeParse(limit);
  const limitIssues = limitParsed.success ? [] : limitParsed.error.issues;

  return (
    <div className="space-y-3 rounded-2xl border p-3" data-testid={`routing-overrides-${providerId}`}>
      <p className="font-mono text-sm">{providerId}</p>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          {m['dashboard.routing.editor.provider_cost_overrides']()}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {COST_FIELDS.map((key) => (
            <ModelMetadataNumberField
              key={key}
              id={`routing-cost-${providerId}-${key}`}
              label={COST_LABEL[key]()}
              min={0}
              step="any"
              placeholder={inherit}
              value={numberValue(cost?.[key])}
              onValueChange={(next) =>
                onChange({
                  ...value,
                  cost: { touched: true, value: withNumber(cost, key, next) as ModelCostInput | undefined },
                })
              }
            />
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          {m['dashboard.routing.editor.provider_limit_overrides']()}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {LIMIT_FIELDS.map((key) => (
            <ModelMetadataNumberField
              key={key}
              id={`routing-limit-${providerId}-${key}`}
              label={LIMIT_LABEL[key]()}
              min={1}
              step={1}
              placeholder={inherit}
              value={numberValue(limit?.[key])}
              onValueChange={(next) =>
                onChange({
                  ...value,
                  limit: { touched: true, value: withNumber(limit, key, next) as ModelLimitInput | undefined },
                })
              }
            />
          ))}
        </div>
        {limitIssues.length === 0 ? null : (
          <ul className="space-y-1" data-testid={`routing-overrides-${providerId}-limit-errors`}>
            {limitIssues.map((issue) => {
              const path = issue.path[0];
              const field =
                path === 'input'
                  ? LIMIT_LABEL.input()
                  : path === 'output'
                    ? LIMIT_LABEL.output()
                    : path === 'context'
                      ? LIMIT_LABEL.context()
                      : String(path ?? '');
              return (
                <li key={`${String(path)}:${issue.message}`} role="alert" className="text-xs text-destructive">
                  {m['dashboard.routing.editor.metadata_schema_error']({ path: field })}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};
