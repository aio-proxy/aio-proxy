import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { defaultPreset } from '@dnd-kit/dom';
import { move } from '@dnd-kit/helpers';
import { DragDropProvider } from '@dnd-kit/react';
import { useMemo, useRef, useState } from 'react';

import type { RoutingFormProviderRow, useRoutingForm } from '../hooks/use-routing-form';
import {
  ROUTING_BOARD_HIGH,
  ROUTING_BOARD_UNUSED,
  applyRoutingBoardMove,
  buildRoutingBoard,
  listsFromBoard,
  sameListMembership,
  routingBoardAfterListId,
  routingBoardTierListId,
  type RoutingBoardItem as RoutingBoardItemModel,
} from '../lib/routing-board';
import { RoutingBoardList } from './routing-board-list';

interface RoutingBoardCanvasProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly rows: readonly RoutingFormProviderRow[];
  readonly writable: boolean;
}

export const RoutingBoardCanvas: React.FC<RoutingBoardCanvasProps> = ({ form, model, rows, writable }) => {
  const board = useMemo(() => buildRoutingBoard(model.providers, rows), [model.providers, rows]);
  const derivedLists = useMemo(() => listsFromBoard(board), [board]);
  const [dragLists, setDragLists] = useState<ReturnType<typeof listsFromBoard> | null>(null);
  const dragListsRef = useRef<ReturnType<typeof listsFromBoard> | null>(null);
  const snapshot = useRef(derivedLists);
  const lists = dragLists ?? derivedLists;

  const providersById = useMemo(
    () => new Map(model.providers.map((provider) => [provider.id, provider])),
    [model.providers],
  );
  const rowsById = useMemo(
    () =>
      new Map(
        rows.map((row, index) => [
          row.providerId,
          { index, hasOverride: row.priority !== undefined || row.weight !== undefined },
        ]),
      ),
    [rows],
  );
  const itemMeta = useMemo(() => {
    const meta = new Map<string, RoutingBoardItemModel>();
    for (const item of [...board.tiers.flatMap((tier) => tier.items), ...board.unused, ...board.blocked]) {
      meta.set(item.providerId, item);
    }
    return meta;
  }, [board]);

  const itemsFor = (ids: readonly string[]): RoutingBoardItemModel[] =>
    ids.map((id) => itemMeta.get(id) ?? { providerId: id, draggable: true, share: null, weight: 0 });

  return (
    <DragDropProvider
      plugins={defaultPreset.plugins}
      sensors={defaultPreset.sensors}
      onDragStart={() => {
        snapshot.current = lists;
        dragListsRef.current = lists;
        setDragLists(lists);
      }}
      onDragOver={(event) => {
        const current = dragListsRef.current ?? lists;
        const next = move(current, event);
        if (sameListMembership(current, next)) return;
        dragListsRef.current = next;
        setDragLists(next);
      }}
      onDragEnd={(event) => {
        const next = dragListsRef.current ?? lists;
        dragListsRef.current = null;
        setDragLists(null);
        if (event.canceled) return;
        form.setFieldValue(
          'providers',
          applyRoutingBoardMove({
            providers: model.providers,
            previousRows: rows,
            previousLists: snapshot.current,
            nextLists: next,
          }),
        );
      }}
    >
      <div className="space-y-2" data-testid="routing-board">
        <p className="text-sm text-muted-foreground">{m['dashboard.routing.editor.board_help']()}</p>
        {writable ? (
          <RoutingBoardList
            form={form}
            listId={ROUTING_BOARD_HIGH}
            ariaLabel={m['dashboard.routing.editor.new_priority']()}
            items={itemsFor(lists[ROUTING_BOARD_HIGH] ?? [])}
            providersById={providersById}
            rowsById={rowsById}
            variant="slot"
            unused={false}
            writable={writable}
            droppable
          />
        ) : null}
        {board.tiers.map((tier) => (
          <div key={tier.priority}>
            <RoutingBoardList
              form={form}
              listId={routingBoardTierListId(tier.priority)}
              label={m['dashboard.routing.editor.tier']({ value: tier.priority })}
              ariaLabel={m['dashboard.routing.editor.tier']({ value: tier.priority })}
              items={itemsFor(lists[routingBoardTierListId(tier.priority)] ?? [])}
              providersById={providersById}
              rowsById={rowsById}
              variant="tier"
              unused={false}
              writable={writable}
              droppable
            />
            {writable ? (
              <RoutingBoardList
                form={form}
                listId={routingBoardAfterListId(tier.priority)}
                ariaLabel={m['dashboard.routing.editor.new_priority']()}
                items={itemsFor(lists[routingBoardAfterListId(tier.priority)] ?? [])}
                providersById={providersById}
                rowsById={rowsById}
                variant="slot"
                unused={false}
                writable={writable}
                droppable
              />
            ) : null}
          </div>
        ))}
        <RoutingBoardList
          form={form}
          listId={ROUTING_BOARD_UNUSED}
          label={m['dashboard.routing.editor.unused']()}
          ariaLabel={m['dashboard.routing.editor.unused']()}
          items={itemsFor(lists[ROUTING_BOARD_UNUSED] ?? [])}
          providersById={providersById}
          rowsById={rowsById}
          variant="unused"
          unused
          writable={writable}
          droppable={writable}
        />
        {board.blocked.length === 0 ? null : (
          <RoutingBoardList
            form={form}
            listId="blocked"
            label={m['dashboard.routing.editor.blocked']()}
            ariaLabel={m['dashboard.routing.editor.blocked']()}
            items={board.blocked}
            providersById={providersById}
            rowsById={rowsById}
            variant="unused"
            unused
            writable={writable}
            droppable={false}
          />
        )}
      </div>
    </DragDropProvider>
  );
};
