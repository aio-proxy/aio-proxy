import { m } from '@aio-proxy/i18n';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import type { ProviderAlias } from '../../lib/alias-editor';
import { aliasEditorIssues } from '../../lib/alias-editor';
import { ProviderAliasVariants } from './provider-alias-variants';

const models = ['claude-sonnet-4', 'claude-sonnet-4-thinking', 'claude-sonnet-4-fast'];

const alias: ProviderAlias = {
  sonnet: {
    model: 'claude-sonnet-4',
    preserve: false,
    variants: [{ when: { thinking: true }, model: 'claude-sonnet-4-thinking', preserve: false }],
  },
};

const variants = (value: ProviderAlias, onAliasChange: (next: ProviderAlias) => void): ReactElement => (
  <ProviderAliasVariants
    alias={value}
    aliasName="sonnet"
    config={value['sonnet']!}
    models={models}
    issues={aliasEditorIssues(value).filter((issue) => issue.variant !== undefined)}
    onAliasChange={onAliasChange}
  />
);

/** The editor page owns the alias, so the component only ever sees the value it was handed back. */
const renderVariants = (initial: ProviderAlias) => {
  const onAliasChange = rs.fn((next: ProviderAlias) => rerender(variants(next, onAliasChange)));
  const { rerender } = render(variants(initial, onAliasChange));
  return onAliasChange;
};

const selectOption = async (trigger: HTMLElement, name: string) => {
  fireEvent.click(trigger);
  fireEvent.keyDown(await screen.findByRole('option', { name }), { key: 'Enter' });
};

const latestAlias = (onAliasChange: ReturnType<typeof rs.fn>) => onAliasChange.mock.calls.at(-1)?.[0] as ProviderAlias;

// The editor used to write variants back through `Object.entries`, which turns an array into
// `{ "0": row }` and re-reads `when: { thinking: true }` as `when: { effort: '0' }`. Editing any other
// field on the row is what triggered it, so the target select is the guard that matters.
test('keeps a thinking condition when its target model is changed', async () => {
  const onAliasChange = renderVariants(alias);

  await selectOption(screen.getByLabelText(m['dashboard.providers.form.variant_target']()), 'claude-sonnet-4');

  expect(latestAlias(onAliasChange)).toEqual({
    sonnet: {
      model: 'claude-sonnet-4',
      preserve: false,
      variants: [{ when: { thinking: true }, model: 'claude-sonnet-4', preserve: false }],
    },
  });
});

// An added row has no condition yet, so the alias must say so rather than silently saving a row that
// `matchAliasRows` can never pick.
test('reports the missing condition on a freshly added row', () => {
  const onAliasChange = renderVariants(alias);

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_variant']() }));

  expect(onAliasChange).toHaveBeenCalledTimes(1);
  expect(screen.getAllByTestId('provider-variant-row')).toHaveLength(2);
  expect(screen.getByRole('alert').textContent).toBe(m['dashboard.providers.form.variant_when_required']());
});

// Removing a row renumbers every row after it. While each row held its own form, the row that shifted
// into the removed row's index inherited its state — so the survivor rendered the deleted row's
// condition, and its next edit wrote that condition over its own.
test('the row surviving a removal keeps its own condition and edits it', async () => {
  const twoRows: ProviderAlias = {
    sonnet: {
      model: 'claude-sonnet-4',
      preserve: false,
      variants: [
        { when: { effort: 'high' }, model: 'claude-sonnet-4-fast', preserve: false },
        { when: { thinking: true }, model: 'claude-sonnet-4-thinking', preserve: false },
      ],
    },
  };
  const onAliasChange = renderVariants(twoRows);
  // Rank orders the display, so the thinking row reads first and the effort row is the one at stored 0.
  const effortRow = () => screen.getAllByTestId('provider-variant-row')[1]!;

  fireEvent.click(within(effortRow()).getByRole('switch'));
  fireEvent.click(within(effortRow()).getByRole('button', { name: m['dashboard.providers.form.remove_variant']() }));

  const survivor = screen.getByTestId('provider-variant-row');
  expect(screen.getAllByTestId('provider-variant-row')).toHaveLength(1);
  expect(within(survivor).getByLabelText(m['dashboard.providers.form.variant_effort_label']())).toHaveValue('');
  expect(within(survivor).getByLabelText(m['dashboard.providers.form.variant_thinking_label']())).toHaveTextContent(
    m['dashboard.providers.form.variant_thinking_on'](),
  );
  expect(within(survivor).getByRole('switch')).not.toBeChecked();

  await selectOption(
    within(survivor).getByLabelText(m['dashboard.providers.form.variant_target']()),
    'claude-sonnet-4-fast',
  );

  expect(latestAlias(onAliasChange)['sonnet']?.variants).toEqual([
    { when: { thinking: true }, model: 'claude-sonnet-4-fast', preserve: false },
  ]);
});
