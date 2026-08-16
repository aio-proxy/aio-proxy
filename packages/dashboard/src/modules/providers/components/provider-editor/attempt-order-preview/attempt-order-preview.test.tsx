import { m } from '@aio-proxy/i18n';
import { describe, expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { AttemptOrderPreview, attemptOrder, hasWeightTie } from './attempt-order-preview';

const other = (
  id: string,
  weight: number | undefined,
  clientModels: readonly string[],
  enabled = true,
): { id: string; weight?: number | undefined; clientModels: readonly string[]; enabled: boolean } => ({
  id,
  weight,
  clientModels,
  enabled,
});

describe('attemptOrder', () => {
  test('orders every provider serving an exposed alias by descending weight, self at its edited weight', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: 7,
        exposedAliases: ['smart'],
        others: [other('high', 10, ['smart']), other('low', 5, ['smart'])],
      }),
    ).toEqual([
      {
        alias: 'smart',
        candidates: [
          { id: 'high', weight: 10, self: false },
          { id: 'self', weight: 7, self: true },
          { id: 'low', weight: 5, self: false },
        ],
        tie: false,
      },
    ]);
  });

  // `tie: true` is not incidental: absent coalesces to 0 at the single ordering point, so three
  // unweighted providers genuinely share a weight and the section must say so.
  test('absent weights keep configuration order and still count as a tie', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: undefined,
        exposedAliases: ['smart'],
        others: [other('first', undefined, ['smart']), other('second', undefined, ['smart'])],
      }),
    ).toEqual([
      {
        alias: 'smart',
        candidates: [
          { id: 'first', weight: 0, self: false },
          { id: 'second', weight: 0, self: false },
          { id: 'self', weight: 0, self: true },
        ],
        tie: true,
      },
    ]);
  });

  test('an equal weight keeps configuration order and reports a tie', () => {
    const input = {
      selfId: 'self',
      selfWeight: 10,
      exposedAliases: ['smart'],
      others: [other('peer', 10, ['smart'])],
    };

    expect(attemptOrder(input)).toEqual([
      {
        alias: 'smart',
        candidates: [
          { id: 'peer', weight: 10, self: false },
          { id: 'self', weight: 10, self: true },
        ],
        tie: true,
      },
    ]);
    expect(hasWeightTie(input)).toBe(true);
  });

  // materialize.ts:133-138 records a config summary and `continue`s for a disabled provider, so it is
  // never built into a runtime instance. Previewing it as the first attempt would state something the
  // router will never do, and reporting a tie against it would flag a conflict that cannot happen.
  test('a disabled provider is neither previewed nor counted as a tie', () => {
    const input = {
      selfId: 'self',
      selfWeight: 100,
      exposedAliases: ['smart'],
      others: [other('off', 100, ['smart'], false)],
    };

    expect(attemptOrder(input)).toEqual([
      { alias: 'smart', candidates: [{ id: 'self', weight: 100, self: true }], tie: false },
    ]);
    expect(hasWeightTie(input)).toBe(false);
  });

  // The summaries query includes the provider being edited; its stored row must not appear next to
  // the edited one, and the edited weight must win over the persisted one.
  test('self is substituted in place when the summaries list already contains it', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: 20,
        exposedAliases: ['smart'],
        others: [other('self', 1, ['stale']), other('peer', 10, ['smart'])],
      }),
    ).toEqual([
      {
        alias: 'smart',
        candidates: [
          { id: 'self', weight: 20, self: true },
          { id: 'peer', weight: 10, self: false },
        ],
        tie: false,
      },
    ]);
  });

  // `hasWeightTie` feeds `sectionStatuses` as `weightTie`. The widened row shape is exactly where the
  // tie guard would silently move, so pin both branches: a tie against another provider, and no tie
  // at all. `selfEnabled` is deliberately absent from its input type — a display flag must not be
  // able to reach this predicate.
  test('hasWeightTie is unmoved by the widened row shape', () => {
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 10,
        exposedAliases: ['smart'],
        others: [other('peer', 10, ['smart'])],
      }),
    ).toBe(true);
    expect(
      hasWeightTie({
        selfId: 'self',
        selfWeight: 10,
        exposedAliases: ['smart'],
        others: [other('peer', 20, ['smart'])],
      }),
    ).toBe(false);
  });
});

describe('AttemptOrderPreview', () => {
  test('ranks every candidate 1..n in descending weight, with its weight and a self tag', () => {
    render(
      <AttemptOrderPreview
        selfId="self"
        selfWeight={7}
        selfEnabled
        exposedAliases={['smart']}
        others={[other('high', 10, ['smart']), other('low', 5, ['smart'])]}
      />,
    );

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toBe('1high10');
    expect(rows[1]?.textContent).toBe(`2self${m['dashboard.providers.editor.preview_rank_self']()}7`);
    expect(rows[2]?.textContent).toBe('3low5');
    expect(screen.getByTestId('attempt-order-self-tag').textContent).toBe(
      m['dashboard.providers.editor.preview_rank_self'](),
    );
  });

  // Rank restarts per alias: each alias has its own independent attempt order, so a continuous
  // 1..n across groups would claim an ordering between aliases that the router never applies.
  test('rank numbering restarts inside each alias group', () => {
    render(
      <AttemptOrderPreview
        selfId="self"
        selfWeight={7}
        selfEnabled
        exposedAliases={['smart', 'fast']}
        others={[other('high', 10, ['smart', 'fast'])]}
      />,
    );

    for (const alias of ['smart', 'fast']) {
      const group = screen.getByTestId(`attempt-order-row-${alias}`);
      expect(group.querySelectorAll('li')).toHaveLength(2);
      expect(group.querySelectorAll('li')[0]?.textContent).toContain('1');
      expect(group.querySelectorAll('li')[1]?.textContent).toContain('2');
    }
  });

  // The mutant is filtering self out, which renders as "nothing to preview": `enabled` is an
  // editable field of the form being previewed, so a switched-off self is still a candidate row —
  // dimmed and relabelled, not deleted.
  test('a disabled self is still listed, dimmed and tagged disabled', () => {
    render(
      <AttemptOrderPreview
        selfId="self"
        selfWeight={7}
        selfEnabled={false}
        exposedAliases={['smart']}
        others={[other('high', 10, ['smart'])]}
      />,
    );

    const rows = screen.getAllByRole('listitem');
    const selfRow = rows.find((row) => row.textContent?.includes('self'));
    expect(selfRow).toBeTruthy();
    expect(selfRow?.className).toContain('opacity-50');
    expect(selfRow?.className).not.toContain('ring-primary/25');
    expect(screen.getByTestId('attempt-order-self-tag').textContent).toBe(
      m['dashboard.providers.editor.preview_rank_disabled'](),
    );
  });

  test('the empty state survives the widened row shape', () => {
    render(<AttemptOrderPreview selfId="self" selfWeight={7} selfEnabled exposedAliases={['smart']} others={[]} />);

    expect(screen.getByTestId('attempt-order-empty')).toBeTruthy();
    expect(screen.queryByTestId('attempt-order-row-smart')).toBeNull();
  });
});
