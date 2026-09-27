import { m } from '@aio-proxy/i18n';
import { ModelLimitSchema, type ModelCostInput, type ModelLimitInput } from '@aio-proxy/types';
import { TableCell, TableRow } from '@aio-proxy/ui/components/table';

import type { RoutingProviderOverrideDraft } from '../lib/routing-metadata-draft';
import { ModelMetadataNumberField } from './model-metadata-visual-tab';

export const COST_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
export const LIMIT_FIELDS = ['context', 'input', 'output'] as const;

export const COST_LABEL: Readonly<Record<(typeof COST_FIELDS)[number], () => string>> = {
  input: m['dashboard.routing.editor.metadata_cost_label_input'],
  output: m['dashboard.routing.editor.metadata_cost_label_output'],
  cacheRead: m['dashboard.routing.editor.metadata_cost_label_cache_read'],
  cacheWrite: m['dashboard.routing.editor.metadata_cost_label_cache_write'],
  reasoning: m['dashboard.routing.editor.metadata_cost_label_reasoning'],
};

export const LIMIT_LABEL: Readonly<Record<(typeof LIMIT_FIELDS)[number], () => string>> = {
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

interface RoutingProviderOverrideRowProps {
  readonly providerId: string;
  readonly value: RoutingProviderOverrideDraft;
  readonly onChange: (next: RoutingProviderOverrideDraft) => void;
}

/**
 * One Provider's cost and limit overrides as a row of the overrides grid.
 *
 * These are the ONLY inputs that ever put cost/limit keys into the PUT body — the board rows stay
 * priority/weight-only — and each group turns into a tri-state draft: untouched groups are omitted,
 * a group cleared to no fields sends `null`.
 *
 * Field names live in the grid's column headers, so every input here hides its own label rather than
 * repeating it in the cell.
 */
export const RoutingProviderOverrideRow: React.FC<RoutingProviderOverrideRowProps> = ({
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
    <>
      <TableRow data-testid={`routing-overrides-${providerId}`}>
        <TableCell className="font-mono text-xs whitespace-nowrap">{providerId}</TableCell>
        {COST_FIELDS.map((key) => (
          <TableCell key={`cost-${key}`}>
            <ModelMetadataNumberField
              id={`routing-cost-${providerId}-${key}`}
              label={COST_LABEL[key]()}
              labelHidden
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
          </TableCell>
        ))}
        {LIMIT_FIELDS.map((key) => (
          <TableCell key={`limit-${key}`}>
            <ModelMetadataNumberField
              id={`routing-limit-${providerId}-${key}`}
              label={LIMIT_LABEL[key]()}
              labelHidden
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
          </TableCell>
        ))}
      </TableRow>
      {limitIssues.length === 0 ? null : (
        <TableRow data-testid={`routing-overrides-${providerId}-limit-errors`}>
          <TableCell colSpan={1 + COST_FIELDS.length + LIMIT_FIELDS.length} className="pt-0">
            <ul className="space-y-1">
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
          </TableCell>
        </TableRow>
      )}
    </>
  );
};
