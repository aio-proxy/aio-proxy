import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';

type ProviderRow = Pick<DashboardProviderSummary, 'id' | 'weight' | 'clientModels' | 'enabled'>;

interface AttemptOrderPreviewProps {
  readonly selfId: string;
  readonly selfWeight: number | undefined;
  readonly exposedAliases: readonly string[];
  readonly others: readonly ProviderRow[];
}

interface AttemptOrderRow {
  alias: string;
  providerIds: string[];
  tie: boolean;
}

// Absent coalesces to 0 at the single ordering point, config.ts:185.
const effectiveWeight = (weight: number | undefined): number => weight ?? 0;

/**
 * Attempt order for every alias this provider exposes. `others` comes from `providersQueryOptions()`,
 * which is already config-sorted, so a stable descending sort over it IS attempt order.
 */
export const attemptOrder = ({
  selfId,
  selfWeight,
  exposedAliases,
  others,
}: AttemptOrderPreviewProps): AttemptOrderRow[] => {
  // No `enabled` gate on self: `enabled` is an editable field of the form being previewed, and the
  // rail's exposure_disabled_note states that consequence. A disabled OTHER is never materialized
  // (materialize.ts:133-138 records a summary and continues), so previewing it would be a lie.
  const self: ProviderRow = { id: selfId, weight: selfWeight, clientModels: exposedAliases, enabled: true };
  // Self's stored summary row is stale against the edits being previewed; substitute it in place so
  // it neither appears twice nor loses its configured position.
  const substituted = others.map((provider) => (provider.id === selfId ? self : provider));
  const candidates = others.some((provider) => provider.id === selfId) ? substituted : [...substituted, self];

  return exposedAliases.map((alias) => {
    const serving = candidates.filter((provider) => provider.enabled && provider.clientModels.includes(alias));
    return {
      alias,
      providerIds: [...serving]
        .sort((left, right) => effectiveWeight(right.weight) - effectiveWeight(left.weight))
        .map((provider) => provider.id),
      tie: serving.some(
        (provider) => provider.id !== selfId && effectiveWeight(provider.weight) === effectiveWeight(selfWeight),
      ),
    };
  });
};

/** Task 18 feeds this to `sectionStatuses` as `weightTie`; the predicate must exist exactly once. */
export const hasWeightTie = (props: AttemptOrderPreviewProps): boolean => attemptOrder(props).some((row) => row.tie);

export const AttemptOrderPreview: React.FC<AttemptOrderPreviewProps> = (props) => {
  const rows = attemptOrder(props);
  const hasOtherProvider = rows.some((row) => row.providerIds.some((id) => id !== props.selfId));

  return (
    <div className="space-y-2" data-testid="attempt-order-preview">
      <FieldLabel>{m['dashboard.providers.editor.preview_title']()}</FieldLabel>
      {hasOtherProvider ? (
        <ul className="space-y-1 rounded-lg border p-3 text-sm">
          {rows.map((row) => (
            <li key={row.alias} data-testid={`attempt-order-row-${row.alias}`} className="flex flex-wrap gap-2">
              <span className="font-medium">{row.alias}</span>
              <span className="text-muted-foreground">{row.providerIds.join(' → ')}</span>
            </li>
          ))}
        </ul>
      ) : (
        <FieldDescription data-testid="attempt-order-empty">
          {m['dashboard.providers.editor.preview_empty']()}
        </FieldDescription>
      )}
      <FieldDescription>{m['dashboard.providers.editor.preview_affinity_note']()}</FieldDescription>
    </div>
  );
};
