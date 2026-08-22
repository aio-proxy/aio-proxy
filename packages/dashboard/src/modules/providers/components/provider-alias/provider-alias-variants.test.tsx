import { m } from '@aio-proxy/i18n';
import type { AliasConfig } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import type { AliasRow } from '../../lib/alias-editor';
import { aliasEditorIssues } from '../../lib/alias-editor';
import { aliasRow } from '../../lib/alias-editor/alias-editor.test-support';
import { ProviderAliasVariants } from './provider-alias-variants';

const models = ['claude-sonnet-4', 'claude-sonnet-4-thinking', 'claude-sonnet-4-fast'];

const sonnet = (config: AliasConfig): readonly AliasRow[] => [aliasRow('sonnet', config)];

const variants = (value: readonly AliasRow[], onAliasChange: (next: readonly AliasRow[]) => void): ReactElement => (
  <ProviderAliasVariants
    alias={value}
    row={value[0]!}
    models={models}
    issues={aliasEditorIssues(value).filter((issue) => issue.variant !== undefined)}
    onAliasChange={onAliasChange}
  />
);

/** The editor page owns the alias, so the component only ever sees the value it was handed back. */
const renderVariants = (initial: readonly AliasRow[]) => {
  const onAliasChange = rs.fn((next: readonly AliasRow[]) => rerender(variants(next, onAliasChange)));
  const { rerender } = render(variants(initial, onAliasChange));
  return onAliasChange;
};

const selectOption = async (trigger: HTMLElement, name: string) => {
  fireEvent.click(trigger);
  fireEvent.keyDown(await screen.findByRole('option', { name }), { key: 'Enter' });
};

const latestAlias = (onAliasChange: ReturnType<typeof rs.fn>) =>
  onAliasChange.mock.calls.at(-1)?.[0] as readonly AliasRow[];

const latestConfig = (onAliasChange: ReturnType<typeof rs.fn>) => latestAlias(onAliasChange)[0]?.config;

const thinkingConfig: AliasConfig = {
  model: 'claude-sonnet-4',
  preserve: false,
  variants: [{ when: { thinking: true }, model: 'claude-sonnet-4-thinking', preserve: false }],
};

// The editor used to write variants back through `Object.entries`, which turns an array into
// `{ "0": row }` and re-reads `when: { thinking: true }` as `when: { effort: '0' }`. Editing any other
// field on the row is what triggered it, so the target select is the guard that matters.
test('keeps a thinking condition when its target model is changed', async () => {
  const onAliasChange = renderVariants(sonnet(thinkingConfig));

  await selectOption(screen.getByLabelText(m['dashboard.providers.form.variant_target']()), 'claude-sonnet-4');

  expect(latestConfig(onAliasChange)).toEqual({
    model: 'claude-sonnet-4',
    preserve: false,
    variants: [{ when: { thinking: true }, model: 'claude-sonnet-4', preserve: false }],
  });
});

// An added row has no condition yet, so the alias must say so rather than silently saving a row that
// `matchAliasRows` can never pick.
test('reports the missing condition on a freshly added row', () => {
  const onAliasChange = renderVariants(sonnet(thinkingConfig));

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_variant']() }));

  expect(onAliasChange).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId('provider-variant-row')).toHaveLength(2);
  expect(screen.getByRole('alert').textContent).toBe(m['dashboard.providers.form.variant_when_required']());
});

// A new row used to start on `models[0]`, a coin flip the user had to correct on nearly every add.
test('a new condition row starts on the alias own target', () => {
  const onAliasChange = renderVariants(sonnet({ model: 'claude-sonnet-4-fast', preserve: false }));

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_variant']() }));

  expect(latestConfig(onAliasChange)?.variants).toEqual([{ when: {}, model: 'claude-sonnet-4-fast', preserve: false }]);
});

// The alias-level preserve switch shares the add-variant row now. It sits among per-row switches, so
// the guard that matters is which config it writes. Clicked through its label text, not the switch
// itself: jsdom forwards a click on the switch to Base UI's hidden input as well, which the HTML spec
// exempts for interactive descendants, so clicking the control double-toggles here but not in a browser.
test('the alias preserve switch writes the alias, not a variant row', () => {
  const onAliasChange = renderVariants(sonnet({ model: 'claude-sonnet-4-fast', preserve: false }));

  fireEvent.click(screen.getByText(m['dashboard.providers.form.alias_preserve']()));

  expect(latestConfig(onAliasChange)).toEqual({ model: 'claude-sonnet-4-fast', preserve: true });
});

// Rows were keyed by stored index, so removing one renumbered the rest and React handed the removed
// row's instance to its successor. State that never reaches `row` — DOM focus, an open condition
// dropdown — then belonged to the wrong row. Keys have to follow the row.
test('a row keeps its own focus when an earlier row is removed', () => {
  const threeRows = sonnet({
    model: 'claude-sonnet-4',
    preserve: false,
    variants: [
      { when: { effort: 'low' }, model: 'claude-sonnet-4', preserve: false },
      { when: { effort: 'high' }, model: 'claude-sonnet-4-fast', preserve: false },
      { when: { thinking: true }, model: 'claude-sonnet-4-thinking', preserve: false },
    ],
  });
  renderVariants(threeRows);
  const effortOf = (position: number) =>
    within(screen.getAllByTestId('provider-variant-row')[position]!).getByLabelText(
      m['dashboard.providers.form.variant_effort_label']({ alias: 'sonnet' }),
    );

  const working = effortOf(2);
  working.focus();
  fireEvent.click(
    within(screen.getAllByTestId('provider-variant-row')[0]!).getByRole('button', {
      name: m['dashboard.providers.form.remove_variant'](),
    }),
  );

  // The row the user was working in is now at position 1, and it is still the focused one.
  expect(screen.getAllByTestId('provider-variant-row')).toHaveLength(2);
  expect(effortOf(1)).toBe(working);
  expect(document.activeElement).toBe(working);
});

// A config can carry an unnamed alias (that is its own reported issue), and an empty name would leave
// the condition controls announced as " 's effort condition". The fallback noun is i18n copy too.
test('an unnamed alias falls back to the alias noun in the condition labels', () => {
  const unnamed = [aliasRow('', thinkingConfig, 'new')];
  const onAliasChange = rs.fn();
  render(
    <ProviderAliasVariants
      alias={unnamed}
      row={unnamed[0]!}
      models={models}
      issues={[]}
      onAliasChange={onAliasChange}
    />,
  );

  const alias = m['dashboard.providers.form.variant_condition_alias_fallback']();
  expect(screen.getByLabelText(m['dashboard.providers.form.variant_effort_label']({ alias }))).toBeInTheDocument();
  expect(screen.getByLabelText(m['dashboard.providers.form.variant_speed_label']({ alias }))).toBeInTheDocument();
});

// Display used to follow `whenRank`, so making a row's condition more specific moved it up the list
// while the user was still working in it. Stored order is the only order now.
test('a row stays in place when its own condition becomes more specific', async () => {
  const twoRows = sonnet({
    model: 'claude-sonnet-4',
    preserve: false,
    variants: [
      { when: { effort: 'high' }, model: 'claude-sonnet-4-fast', preserve: false },
      { when: { speed: 'fast' }, model: 'claude-sonnet-4-thinking', preserve: false },
    ],
  });
  const onAliasChange = renderVariants(twoRows);
  const rowAt = (position: number) => screen.getAllByTestId('provider-variant-row')[position]!;
  const thinkingLabel = m['dashboard.providers.form.variant_thinking_label']({ alias: 'sonnet' });

  // The second row is the one rank would promote: `whenRank` scores thinking 4 / effort 2 / speed 1,
  // so switching thinking on takes it from 1 to 5, past the first row's 2.
  await selectOption(
    within(rowAt(1)).getByLabelText(thinkingLabel),
    m['dashboard.providers.form.variant_thinking_on'](),
  );

  expect(latestConfig(onAliasChange)?.variants).toEqual([
    { when: { effort: 'high' }, model: 'claude-sonnet-4-fast', preserve: false },
    { when: { thinking: true, speed: 'fast' }, model: 'claude-sonnet-4-thinking', preserve: false },
  ]);
  // Rank order would now read this row first. It is still second, and the first row is still its own.
  expect(within(rowAt(1)).getByLabelText(thinkingLabel)).toHaveTextContent(
    m['dashboard.providers.form.variant_thinking_on'](),
  );
  expect(
    within(rowAt(0)).getByLabelText(m['dashboard.providers.form.variant_effort_label']({ alias: 'sonnet' })),
  ).toHaveValue('high');
});

// The effort field is free text over a curated list, so the typed text — not a list selection — is
// what has to reach the draft, including when the user finishes with Enter while the popup is open.
// `autoHighlight` used to sit on this combobox, which pre-highlights an option Enter then commits over
// the typed value; `none` being a legal effort meant the substituted condition saved with no error.
test('the popup stays open on Enter and the typed effort is what gets committed', async () => {
  const onAliasChange = renderVariants(
    sonnet({
      model: 'claude-sonnet-4',
      preserve: false,
      variants: [{ when: {}, model: 'claude-sonnet-4-fast', preserve: false }],
    }),
  );
  const effort = () => screen.getByLabelText(m['dashboard.providers.form.variant_effort_label']({ alias: 'sonnet' }));

  // Clicking the input opens the list (`openOnInputClick`), which is the state Enter is ambiguous in.
  // Base UI opens on pointerdown, so a bare `click` leaves the popup shut.
  fireEvent.pointerDown(effort());
  fireEvent.mouseDown(effort());
  fireEvent.click(effort());
  await screen.findAllByRole('option');
  fireEvent.change(effort(), { target: { value: 'high' } });
  fireEvent.keyDown(effort(), { key: 'Enter' });

  // `variants` serializes to the effort-keyed shorthand when effort is the only condition.
  expect(latestConfig(onAliasChange)?.variants).toEqual({
    high: { model: 'claude-sonnet-4-fast', preserve: false },
  });
  expect(effort()).toHaveValue('high');
});

// Removing a row renumbers every row after it. While each row held its own form, the row that shifted
// into the removed row's index inherited its state — so the survivor rendered the deleted row's
// condition, and its next edit wrote that condition over its own.
test('the row surviving a removal keeps its own condition and edits it', async () => {
  const twoRows = sonnet({
    model: 'claude-sonnet-4',
    preserve: false,
    variants: [
      { when: { effort: 'high' }, model: 'claude-sonnet-4-fast', preserve: false },
      { when: { thinking: true }, model: 'claude-sonnet-4-thinking', preserve: false },
    ],
  });
  const onAliasChange = renderVariants(twoRows);
  // Rows render in stored order, so the effort row is both first on screen and stored 0.
  const effortRow = () => screen.getAllByTestId('provider-variant-row')[0]!;

  fireEvent.click(within(effortRow()).getByRole('switch'));
  fireEvent.click(within(effortRow()).getByRole('button', { name: m['dashboard.providers.form.remove_variant']() }));

  const survivor = screen.getByTestId('provider-variant-row');
  expect(screen.getAllByTestId('provider-variant-row')).toHaveLength(1);
  expect(
    within(survivor).getByLabelText(m['dashboard.providers.form.variant_effort_label']({ alias: 'sonnet' })),
  ).toHaveValue('');
  expect(
    within(survivor).getByLabelText(m['dashboard.providers.form.variant_thinking_label']({ alias: 'sonnet' })),
  ).toHaveTextContent(m['dashboard.providers.form.variant_thinking_on']());
  expect(within(survivor).getByRole('switch')).not.toBeChecked();

  await selectOption(
    within(survivor).getByLabelText(m['dashboard.providers.form.variant_target']()),
    'claude-sonnet-4-fast',
  );

  expect(latestConfig(onAliasChange)?.variants).toEqual([
    { when: { thinking: true }, model: 'claude-sonnet-4-fast', preserve: false },
  ]);
});
