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
  // unweighted providers genuinely share a weight and the section must say so. The candidate's own
  // `weight` is display-only and stays absent — `toStrictEqual` so dropping the key is not a pass.
  test('absent weights keep configuration order and still count as a tie without displaying a weight', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: undefined,
        exposedAliases: ['smart'],
        others: [other('first', undefined, ['smart']), other('second', undefined, ['smart'])],
      }),
    ).toStrictEqual([
      {
        alias: 'smart',
        candidates: [
          { id: 'first', weight: undefined, self: false },
          { id: 'second', weight: undefined, self: false },
          { id: 'self', weight: undefined, self: true },
        ],
        tie: true,
      },
    ]);
  });

  // The ordering weight and the displayed weight are different values. An absent weight must still
  // sort as 0 — the mutant is "display-only means display-only everywhere", which would sort absent
  // above an explicit weight (NaN comparison) or below it.
  test('an absent weight still sorts as zero even though it displays as absent', () => {
    expect(
      attemptOrder({
        selfId: 'self',
        selfWeight: undefined,
        exposedAliases: ['smart'],
        others: [other('weighted', 5, ['smart'])],
      }),
    ).toStrictEqual([
      {
        alias: 'smart',
        candidates: [
          { id: 'weighted', weight: 5, self: false },
          { id: 'self', weight: undefined, self: true },
        ],
        tie: false,
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

  // The queue said `0` for a weight the slider calls absent, so one screen told two truths about one
  // field and an explicit 0 was indistinguishable from no weight at all. Ordering still uses 0; only
  // the rendered cell changes. The mutant is re-coalescing at the display point.
  test('an absent weight renders a dash instead of a zero it never stored', () => {
    render(
      <AttemptOrderPreview
        selfId="self"
        selfWeight={undefined}
        selfEnabled
        exposedAliases={['smart']}
        others={[other('peer', 10, ['smart'])]}
      />,
    );

    const selfRow = screen.getAllByRole('listitem').find((row) => row.textContent?.includes('self'));
    expect(selfRow?.textContent).toContain('—');
    expect(selfRow?.textContent).not.toContain('0');
  });

  // `weight || '—'` passes the absent case and silently erases a deliberate 0, which is a real
  // configured weight and the lowest priority in the queue.
  test('an explicit zero weight still renders as zero, never as the absent dash', () => {
    render(
      <AttemptOrderPreview
        selfId="self"
        selfWeight={0}
        selfEnabled
        exposedAliases={['smart']}
        others={[other('peer', 10, ['smart'])]}
      />,
    );

    const selfRow = screen.getAllByRole('listitem').find((row) => row.textContent?.includes('self'));
    expect(selfRow?.textContent).toContain('0');
    expect(selfRow?.textContent).not.toContain('—');
  });

  // One `<ol>` per alias and none of them named, so a screen-reader user heard N identical unnamed
  // ordered lists with no way to tell which alias each ranked.
  test('each alias group exposes its list under the alias as accessible name', () => {
    render(
      <AttemptOrderPreview
        selfId="self"
        selfWeight={7}
        selfEnabled
        exposedAliases={['smart', 'fast']}
        others={[other('high', 10, ['smart', 'fast'])]}
      />,
    );

    expect(screen.getByRole('list', { name: 'smart' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'fast' })).toBeTruthy();
  });

  // It was a `<FieldLabel>`, i.e. a `<label>`, with no `htmlFor` and no control to point at: the
  // preview is a read-only `<div>`. A label that labels nothing is invisible to the outline.
  test('the preview title is a heading rather than a label for a control that does not exist', () => {
    const { container } = render(
      <AttemptOrderPreview
        selfId="self"
        selfWeight={7}
        selfEnabled
        exposedAliases={['smart']}
        others={[other('high', 10, ['smart'])]}
      />,
    );

    expect(screen.getByRole('heading', { name: m['dashboard.providers.editor.preview_title']() })).toBeTruthy();
    expect(container.querySelectorAll('label')).toHaveLength(0);
  });
});
