import { m } from '@aio-proxy/i18n';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';

import { aliasEditorIssues, type AliasRow } from '../../../lib/alias-editor';
import { aliasRow } from '../../../lib/alias-editor/alias-editor.test-support';
import { ModelAliases } from './model-aliases';

const models = ['model-a', 'model-b'];

const aliases = (value: readonly AliasRow[], onAliasChange: (next: readonly AliasRow[]) => void): ReactElement => (
  <ModelAliases
    alias={value}
    issues={aliasEditorIssues(value, models)}
    targetOptions={models}
    onAliasChange={onAliasChange}
  />
);

/** The editor page owns the alias, so the component only ever sees the value it was handed back. */
const renderAliases = (initial: readonly AliasRow[]) => {
  const onAliasChange = rs.fn((next: readonly AliasRow[]) => rerender(aliases(next, onAliasChange)));
  const { rerender } = render(aliases(initial, onAliasChange));
  return onAliasChange;
};

const latestAlias = (onAliasChange: ReturnType<typeof rs.fn>) =>
  onAliasChange.mock.calls.at(-1)?.[0] as readonly AliasRow[];

const nameBox = () => screen.getByLabelText(m['dashboard.providers.form.alias_name']());

const named = (name: string, model: string, id = name) => aliasRow(name, { model, preserve: false }, id);

// The name used to be committed on blur, through a staged draft. Typing writes the row directly
// now, so the row's React key cannot be the name — a name-derived key remounts the input on the first
// keystroke and takes the caret with it.
test('renaming writes the record per keystroke without unmounting the row', () => {
  const onAliasChange = renderAliases([named('mini', 'model-a')]);
  const before = nameBox();

  fireEvent.change(before, { target: { value: 'mini2' } });

  expect(latestAlias(onAliasChange)).toEqual([named('mini2', 'model-a', 'mini')]);
  expect(nameBox()).toBe(before);
  expect(nameBox()).toHaveValue('mini2');
});

// The drawer is gone: Add Alias appends an ordinary row, edited in place, that reports its own missing
// name rather than staging itself somewhere off screen.
test('Add Alias appends an unnamed row that reports itself', () => {
  const onAliasChange = renderAliases([]);

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_alias']() }));

  const added = latestAlias(onAliasChange);
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({ name: '', config: { model: 'model-a', preserve: false } });
  expect(added[0]?.id).toEqual(expect.any(String));
  const card = screen.getByTestId('provider-alias-card');
  expect(within(card).getByLabelText(m['dashboard.providers.form.alias_name']())).toHaveAttribute(
    'aria-invalid',
    'true',
  );
});

// A colliding name is still a value: it has to land in the row so the list-level alert can see it
// and so Save can refuse it. The old record-keyed editor rejected the write, which left the box
// showing one name and the stored row another.
test('a name another row already owns is written and marks every colliding row', () => {
  const onAliasChange = renderAliases([named('mini', 'model-a', 'r1'), named('fast', 'model-b', 'r2')]);
  const boxes = screen.getAllByLabelText(m['dashboard.providers.form.alias_name']());
  const box = boxes[1]!;

  fireEvent.change(box, { target: { value: 'mini' } });

  expect(latestAlias(onAliasChange)).toEqual([named('mini', 'model-a', 'r1'), named('mini', 'model-b', 'r2')]);
  expect(box).toHaveValue('mini');
  expect(boxes[0]).toHaveAttribute('aria-invalid', 'true');
  expect(box).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent(m['dashboard.providers.form.alias_name_duplicate']());
});

// Two legal `mini` rows must not share a DOM id. Each name input points at the one list-level
// alert; if `aliasControlId` keyed on the name, both boxes would be `provider-alias-mini`.
test('two rows sharing a name keep distinct control ids and share the list-level alert', () => {
  renderAliases([named('mini', 'model-a', 'r1'), named('mini', 'model-b', 'r2')]);

  const boxes = screen.getAllByLabelText(m['dashboard.providers.form.alias_name']());
  expect(boxes[0]?.id).not.toBe(boxes[1]?.id);
  const alert = screen.getByRole('alert');
  expect(alert).toHaveAttribute('id', 'alias-name-duplicate-error');
  expect(boxes[0]).toHaveAttribute('aria-describedby', alert.id);
  expect(boxes[1]).toHaveAttribute('aria-describedby', alert.id);
});

// Clicking Add twice used to overwrite the first unnamed row because both lived at the '' key.
test('Add Alias twice keeps both unnamed rows', () => {
  const onAliasChange = renderAliases([]);

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_alias']() }));
  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_alias']() }));

  const added = latestAlias(onAliasChange);
  expect(added).toHaveLength(2);
  expect(added[0]?.id).not.toBe(added[1]?.id);
  expect(added.every((row) => row.name === '')).toBe(true);
  expect(screen.getAllByTestId('provider-alias-card')).toHaveLength(2);
});

test('the inherit toggle stays off screen unless the parent owns inherit', () => {
  render(aliases([], () => {}));

  expect(screen.queryByTestId('inherit-plugin-aliases')).toBeNull();
});

test('the inherit toggle reports the current draft inherit state', () => {
  const onInherit = rs.fn();
  render(
    <ModelAliases
      alias={[]}
      issues={[]}
      targetOptions={models}
      onAliasChange={() => {}}
      inheritPluginAliases
      onInheritPluginAliasesChange={onInherit}
    />,
  );

  expect(screen.getByTestId('inherit-plugin-aliases')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('inherit-plugin-aliases-checkbox'));
  expect(onInherit).toHaveBeenCalled();
});
