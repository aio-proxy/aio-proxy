import { m } from '@aio-proxy/i18n';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import { aliasEditorIssues, type ProviderAlias } from '../../../lib/alias-editor';
import { ModelAliases } from './model-aliases';

const models = ['model-a', 'model-b'];

const aliases = (value: ProviderAlias, onAliasChange: (next: ProviderAlias) => void): ReactElement => (
  <ModelAliases
    alias={value}
    issues={aliasEditorIssues(value, models)}
    targetOptions={models}
    onAliasChange={onAliasChange}
  />
);

/** The editor page owns the alias, so the component only ever sees the value it was handed back. */
const renderAliases = (initial: ProviderAlias) => {
  const onAliasChange = rs.fn((next: ProviderAlias) => rerender(aliases(next, onAliasChange)));
  const { rerender } = render(aliases(initial, onAliasChange));
  return onAliasChange;
};

const latestAlias = (onAliasChange: ReturnType<typeof rs.fn>) => onAliasChange.mock.calls.at(-1)?.[0] as ProviderAlias;

const nameBox = () => screen.getByLabelText(m['dashboard.providers.form.alias_name']());

// The name used to be committed on blur, through a staged draft. Typing writes the record directly
// now, so the row's React key cannot be the name — a name-derived key remounts the input on the first
// keystroke and takes the caret with it.
test('renaming writes the record per keystroke without unmounting the row', () => {
  const onAliasChange = renderAliases({ mini: { model: 'model-a', preserve: false } });
  const before = nameBox();

  fireEvent.change(before, { target: { value: 'mini2' } });

  expect(latestAlias(onAliasChange)).toEqual({ mini2: { model: 'model-a', preserve: false } });
  expect(nameBox()).toBe(before);
  expect(nameBox()).toHaveValue('mini2');
});

// The drawer is gone: Add Alias appends an ordinary row, edited in place, that reports its own missing
// name rather than staging itself somewhere off screen.
test('Add Alias appends an unnamed row that reports itself', () => {
  const onAliasChange = renderAliases({});

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_alias']() }));

  expect(latestAlias(onAliasChange)).toEqual({ '': { model: 'model-a', preserve: false } });
  const card = screen.getByTestId('provider-alias-card');
  expect(within(card).getByLabelText(m['dashboard.providers.form.alias_name']())).toHaveAttribute(
    'aria-invalid',
    'true',
  );
});

// A rename the record cannot take must leave the typed text in the box — clearing it back to the
// stored name mid-word is how the user loses what they were typing. The record never holds the
// collision (a rejected rename writes nothing), so the card's own error is the one that reports it.
test('a name another row already owns is reported and leaves the typed text alone', () => {
  const onAliasChange = renderAliases({
    mini: { model: 'model-a', preserve: false },
    fast: { model: 'model-b', preserve: false },
  });
  const box = screen.getAllByLabelText(m['dashboard.providers.form.alias_name']())[1]!;

  fireEvent.change(box, { target: { value: 'mini' } });

  expect(onAliasChange).not.toHaveBeenCalled();
  expect(box).toHaveValue('mini');
  expect(box).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByText(m['dashboard.providers.form.error_name_duplicate']())).toBeInTheDocument();
});
