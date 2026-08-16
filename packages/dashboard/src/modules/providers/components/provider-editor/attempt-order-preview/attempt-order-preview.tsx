import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { FieldDescription, FieldLabel } from '@aio-proxy/ui/components/field';
import { cn } from '@aio-proxy/ui/lib/utils';

type ProviderRow = Pick<DashboardProviderSummary, 'id' | 'weight' | 'clientModels' | 'enabled'>;

/**
 * What `attemptOrder` needs, and deliberately no more. `selfEnabled` is a display-only flag, so it is
 * absent here: `hasWeightTie` feeds `sectionStatuses` and must stay unmovable by anything the preview
 * merely renders.
 */
interface AttemptOrderInput {
  readonly selfId: string;
  readonly selfWeight: number | undefined;
  readonly exposedAliases: readonly string[];
  readonly others: readonly ProviderRow[];
}

interface AttemptOrderPreviewProps extends AttemptOrderInput {
  /** The live switch value. `undefined` is the switch's own default, so only `false` reads as off. */
  readonly selfEnabled: boolean | undefined;
}

interface AttemptOrderCandidate {
  id: string;
  weight: number;
  self: boolean;
}

interface AttemptOrderRow {
  alias: string;
  candidates: AttemptOrderCandidate[];
  tie: boolean;
}

// Absent coalesces to 0 at the single ordering point, config.ts:185.
const effectiveWeight = (weight: number | undefined): number => weight ?? 0;

/**
 * Attempt order for every alias this provider exposes. `others` comes from `providersQueryOptions()`,
 * which is already config-sorted, so a stable descending sort over it IS attempt order.
 */
export const attemptOrder = ({ selfId, selfWeight, exposedAliases, others }: AttemptOrderInput): AttemptOrderRow[] => {
  // No `enabled` gate on self: `enabled` is an editable field of the form being previewed, so self
  // stays listed whatever the switch says and the row is dimmed and relabelled instead. A disabled
  // OTHER is never materialized (materialize.ts:133-138 records a summary and continues), so
  // previewing it would be a lie.
  const self: ProviderRow = { id: selfId, weight: selfWeight, clientModels: exposedAliases, enabled: true };
  // Self's stored summary row is stale against the edits being previewed; substitute it in place so
  // it neither appears twice nor loses its configured position.
  const substituted = others.map((provider) => (provider.id === selfId ? self : provider));
  const candidates = others.some((provider) => provider.id === selfId) ? substituted : [...substituted, self];

  return exposedAliases.map((alias) => {
    const serving = candidates.filter((provider) => provider.enabled && provider.clientModels.includes(alias));
    return {
      alias,
      candidates: [...serving]
        .sort((left, right) => effectiveWeight(right.weight) - effectiveWeight(left.weight))
        .map((provider) => ({
          id: provider.id,
          weight: effectiveWeight(provider.weight),
          self: provider.id === selfId,
        })),
      tie: serving.some(
        (provider) => provider.id !== selfId && effectiveWeight(provider.weight) === effectiveWeight(selfWeight),
      ),
    };
  });
};

/** Task 18 feeds this to `sectionStatuses` as `weightTie`; the predicate must exist exactly once. */
export const hasWeightTie = (input: AttemptOrderInput): boolean => attemptOrder(input).some((row) => row.tie);

export const AttemptOrderPreview: React.FC<AttemptOrderPreviewProps> = (props) => {
  const rows = attemptOrder(props);
  const hasOtherProvider = rows.some((row) => row.candidates.some((candidate) => !candidate.self));
  const selfEnabled = props.selfEnabled !== false;

  return (
    <div className="space-y-2" data-testid="attempt-order-preview">
      <FieldLabel>{m['dashboard.providers.editor.preview_title']()}</FieldLabel>
      {hasOtherProvider ? (
        <div className="space-y-3 rounded-lg border p-3 text-sm">
          {rows.map((row) => (
            <div key={row.alias} data-testid={`attempt-order-row-${row.alias}`} className="space-y-1">
              <span className="font-medium">{row.alias}</span>
              {/* Rank restarts per alias: each alias has its own independent attempt order. */}
              <ol className="space-y-1">
                {row.candidates.map((candidate, index) => (
                  <li
                    key={candidate.id}
                    className={cn(
                      'flex items-center gap-3 rounded-2xl px-3 py-2 text-sm',
                      candidate.self && selfEnabled ? 'bg-primary/5 ring-1 ring-primary/25' : 'bg-muted/40',
                      candidate.self && !selfEnabled ? 'opacity-50' : '',
                    )}
                  >
                    <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{candidate.id}</span>
                    {candidate.self ? (
                      <span className="shrink-0 text-xs text-muted-foreground" data-testid="attempt-order-self-tag">
                        {selfEnabled
                          ? m['dashboard.providers.editor.preview_rank_self']()
                          : m['dashboard.providers.editor.preview_rank_disabled']()}
                      </span>
                    ) : null}
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{candidate.weight}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : (
        <FieldDescription data-testid="attempt-order-empty">
          {m['dashboard.providers.editor.preview_empty']()}
        </FieldDescription>
      )}
      <FieldDescription>{m['dashboard.providers.editor.preview_affinity_note']()}</FieldDescription>
    </div>
  );
};
