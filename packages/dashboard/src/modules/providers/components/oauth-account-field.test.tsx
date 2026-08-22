import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { useOAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { OAuthAccountFields } from './oauth-account-fields';

// Rendered through OAuthAccountFields so the real form field APIs feed the branches, which is what
// makes the delete-on-undefined assertions below mean anything.
const Harness: React.FC<{
  readonly fields: readonly DashboardOAuthFormField[];
  readonly initialPublic?: Record<string, unknown>;
}> = ({ fields, initialPublic }) => {
  const form = useOAuthProviderForm(
    () => undefined,
    initialPublic === undefined ? undefined : { publicValues: initialPublic },
  );
  return (
    <>
      <OAuthAccountFields fields={fields} form={form} />
      <button type="button" onClick={() => publish(form.getFieldValue('publicValues'))}>
        publish
      </button>
    </>
  );
};

let published: Record<string, unknown> = {};
const publish = (values: Record<string, unknown>) => {
  published = values;
};
const publishedValues = () => {
  fireEvent.click(screen.getByRole('button', { name: 'publish' }));
  return published;
};

const DESCRIPTION = 'What this field is for';
const describedField = (extra: DashboardOAuthFormField) => ({ ...extra, description: DESCRIPTION });

// One field per schema variant, each carrying the base schema's `description`.
const variants: readonly { readonly name: string; readonly field: DashboardOAuthFormField }[] = [
  { name: 'text', field: describedField({ type: 'text', key: 'tenant', label: 'Tenant' }) },
  { name: 'number', field: describedField({ type: 'number', key: 'seats', label: 'Seats' }) },
  { name: 'secret', field: describedField({ type: 'secret', key: 'token', label: 'Token', configured: false }) },
  { name: 'boolean', field: describedField({ type: 'boolean', key: 'beta', label: 'Beta' }) },
  {
    name: 'select',
    field: describedField({
      type: 'select',
      key: 'host',
      label: 'Host',
      options: [
        { value: 'github.com', label: 'GitHub' },
        { value: 'ghe.internal', label: 'Enterprise' },
      ],
    }),
  },
  { name: 'json', field: describedField({ type: 'json', key: 'extra', label: 'Extra' }) },
];

describe('OAuthAccountField', () => {
  test.each(variants)('renders the description and points the $name control at it', ({ field }) => {
    render(<Harness fields={[field]} />);

    const description = screen.getByText(DESCRIPTION);
    expect(description.id).toBe(`oauth-${field.key}-description`);

    // The label names the control and the control names the description, in both directions, because
    // `description` lives on the base schema and every variant can carry one. `getAllBy` because the
    // switch primitive exposes a labelled role=switch element beside its hidden input.
    expect(screen.getByText(field.label as string)).toHaveAttribute('for', `oauth-${field.key}`);
    const described = screen
      .getAllByLabelText(field.label as string)
      .some((control) => control.getAttribute('aria-describedby')?.split(' ').includes(description.id) === true);
    expect(described).toBe(true);
  });

  test('shows the selected option label on the trigger rather than its JSON value', () => {
    const [selectVariant] = variants.filter((variant) => variant.name === 'select');
    render(<Harness fields={[selectVariant!.field]} initialPublic={{ host: 'github.com' }} />);

    const trigger = screen.getByLabelText('Host');
    expect(trigger.textContent).toContain('GitHub');
    // The trigger used to render the raw JSON value, quotes included.
    expect(trigger.textContent).not.toContain('"');
  });

  test('shows the localized placeholder when nothing is selected', () => {
    const [selectVariant] = variants.filter((variant) => variant.name === 'select');
    render(<Harness fields={[selectVariant!.field]} />);

    expect(screen.getByLabelText('Host').textContent).toContain(
      m['dashboard.providers.oauth.account_select_placeholder'](),
    );
  });

  test('honours the json variant placeholder and default value', () => {
    render(
      <Harness
        fields={[{ type: 'json', key: 'extra', label: 'Extra', placeholder: '{}', defaultValue: { scope: 'repo' } }]}
      />,
    );

    const textarea = screen.getByLabelText('Extra');
    expect(textarea).toHaveAttribute('placeholder', '{}');
    expect(textarea).toHaveValue(JSON.stringify({ scope: 'repo' }));
  });

  test('wires the json error message into the control instead of leaving it orphaned', () => {
    render(<Harness fields={[{ type: 'json', key: 'extra', label: 'Extra' }]} />);

    fireEvent.change(screen.getByLabelText('Extra'), { target: { value: '{' } });

    const error = screen.getByRole('alert');
    expect(error.id).toBe('oauth-extra-error');
    expect(screen.getByLabelText('Extra').getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
  });

  test('clearing a value removes its key instead of writing undefined', () => {
    render(
      <Harness
        fields={[{ type: 'number', key: 'seats', label: 'Seats' }]}
        initialPublic={{ seats: 4, tenant: 'acme' }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Seats'), { target: { value: '' } });

    // The key set, not `toEqual`: an explicit `seats: undefined` survives into the OAuth session
    // start body as a present key, and `toEqual` treats an undefined-valued key as absent, so it
    // cannot tell the two apart.
    const values = publishedValues();
    expect(Object.keys(values).sort()).toEqual(['tenant']);
    expect(values['tenant']).toBe('acme');
  });

  test('emptying a json field removes its key instead of writing undefined', () => {
    render(
      <Harness
        fields={[{ type: 'json', key: 'extra', label: 'Extra' }]}
        initialPublic={{ extra: { scope: 'repo' }, tenant: 'acme' }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Extra'), { target: { value: '' } });

    const values = publishedValues();
    expect(Object.keys(values).sort()).toEqual(['tenant']);
    expect(values['tenant']).toBe('acme');
  });
});
