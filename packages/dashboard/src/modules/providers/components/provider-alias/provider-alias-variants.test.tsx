import { m } from '@aio-proxy/i18n';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

import type { ProviderAlias } from '../../lib/alias-editor';
import { aliasEditorIssues } from '../../lib/alias-editor';
import { ProviderAliasVariants } from './provider-alias-variants';

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
    models={['claude-sonnet-4', 'claude-sonnet-4-thinking']}
    issues={aliasEditorIssues(value).filter((issue) => issue.variant !== undefined)}
    onAliasChange={onAliasChange}
  />
);

// The editor used to write variants back through `Object.entries`, which turns an array into
// `{ "0": row }` and re-reads `when: { thinking: true }` as `when: { effort: '0' }`. Editing any other
// field on the row is what triggered it, so the target select is the guard that matters.
test('keeps a thinking condition when its target model is changed', async () => {
  const onAliasChange = rs.fn();
  render(variants(alias, onAliasChange));

  fireEvent.click(screen.getByLabelText(m['dashboard.providers.form.variant_target']()));
  const option = await screen.findByRole('option', { name: 'claude-sonnet-4' });
  fireEvent.pointerDown(option, { pointerType: 'mouse' });
  fireEvent.click(option);

  expect(onAliasChange).toHaveBeenCalledWith({
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
  const onAliasChange = rs.fn();
  const { rerender } = render(variants(alias, onAliasChange));

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.form.add_variant']() }));
  rerender(variants(onAliasChange.mock.calls[0]?.[0] as ProviderAlias, onAliasChange));

  expect(screen.getAllByTestId('provider-variant-row')).toHaveLength(2);
  expect(screen.getByRole('alert').textContent).toBe(m['dashboard.providers.form.variant_when_required']());
});
