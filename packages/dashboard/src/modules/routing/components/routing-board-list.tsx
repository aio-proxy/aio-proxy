import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { useDroppable } from '@dnd-kit/react';

import type { useRoutingForm } from '../hooks/use-routing-form';
import { applyRoutingShare, type RoutingBoardItem as RoutingBoardItemModel } from '../lib/routing-board';
import { RoutingBoardItem } from './routing-board-item';

interface RoutingBoardListProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly listId: string;
  readonly label?: string;
  readonly ariaLabel: string;
  readonly items: readonly RoutingBoardItemModel[];
  readonly providersById: ReadonlyMap<string, DashboardRoutingProvider>;
  readonly rowsById: ReadonlyMap<string, { index: number; hasOverride: boolean }>;
  readonly variant: 'tier' | 'slot' | 'unused';
  readonly unused: boolean;
  readonly writable: boolean;
  readonly droppable: boolean;
}

export const RoutingBoardList: React.FC<RoutingBoardListProps> = ({
  form,
  listId,
  label,
  ariaLabel,
  items,
  providersById,
  rowsById,
  variant,
  unused,
  writable,
  droppable,
}) => {
  const { ref, isDropTarget } = useDroppable({ id: listId, accept: 'provider', type: 'list', disabled: !droppable });
  const slotClass =
    items.length === 0
      ? 'h-2 rounded-md data-drop-target:border data-drop-target:border-dashed data-drop-target:border-border'
      : 'space-y-2 rounded-xl border border-dashed p-2 data-drop-target:border-primary';

  return (
    <section
      ref={ref}
      aria-label={ariaLabel}
      data-testid={`routing-list-${listId}`}
      data-drop-target={isDropTarget || undefined}
      className={
        variant === 'slot' ? slotClass : 'space-y-2 rounded-xl border bg-muted/40 p-3 data-drop-target:border-primary'
      }
    >
      {label === undefined ? null : (
        <h3 className={variant === 'tier' ? 'font-heading text-sm font-medium' : 'text-sm'}>{label}</h3>
      )}
      {items.length === 0 ? null : (
        <div className="space-y-2">
          {items.map((item) => {
            const provider = providersById.get(item.providerId);
            const row = rowsById.get(item.providerId);
            return provider === undefined || row === undefined ? null : (
              <RoutingBoardItem
                key={item.providerId}
                form={form}
                provider={provider}
                index={row.index}
                share={item.share}
                unused={unused}
                writable={writable}
                draggable={item.draggable}
                hasOverride={row.hasOverride}
                onShareChange={
                  unused || items.length < 2
                    ? undefined
                    : (percent) => {
                        form.setFieldValue(
                          'providers',
                          applyRoutingShare({
                            providers: [...providersById.values()],
                            rows: form.getFieldValue('providers') ?? [],
                            memberIds: items.map((entry) => entry.providerId),
                            providerId: item.providerId,
                            percent,
                          }),
                        );
                      }
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
};
