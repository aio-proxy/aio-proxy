import { m } from '@aio-proxy/i18n';
import { Label } from '@aio-proxy/ui/components/label';
import { describe, expect, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { PROVIDER_AI_SDK_DEFAULT_PACKAGE } from '../../lib/constants';
import { ProviderPackageCombobox } from './provider-package-combobox';

// Mirrors provider-form-fields-ai-sdk.tsx: a visible <Label htmlFor> paired with the combobox's own
// id, and a value that is never empty because the field falls back to the bundled package. Rendering
// the real fields component would need a QueryClientProvider and the package-status endpoint, which
// says nothing extra about the label association or the pointer affordance.
const PackageHarness: React.FC = () => {
  const [value, setValue] = useState<string>(PROVIDER_AI_SDK_DEFAULT_PACKAGE);
  return (
    <>
      <Label htmlFor="packageName">{m['dashboard.providers.form.label_package_name']()}</Label>
      <ProviderPackageCombobox id="packageName" value={value} onValueChange={setValue} onCommit={setValue} />
    </>
  );
};

// Base UI's trigger toggles on mousedown (`useClick({ event: 'mousedown' })`), and it is the only
// button in the group carrying aria-expanded.
const expandButton = () => screen.getByRole('button', { expanded: false });

describe('ProviderPackageCombobox', () => {
  test('keeps a usable chevron beside the clear button and opens the curated list from it', async () => {
    render(<PackageHarness />);

    const trigger = expandButton();
    // happy-dom loads no Tailwind, so a `hidden` utility on the chevron is invisible to layout and to
    // toBeVisible(); the class list is the only evidence that nothing display-hides the one pointer
    // affordance while the clear button is mounted.
    expect(trigger.className).not.toMatch(/(?:^|[\s:])hidden(?:\s|$)/u);

    fireEvent.mouseDown(trigger);

    expect(await screen.findByRole('option', { name: '@ai-sdk/anthropic' })).toBeTruthy();
  });

  test('names the clear button so it is not an anonymous icon button', () => {
    render(<PackageHarness />);

    expect(screen.getByRole('button', { name: m['common.clear']() })).toBeTruthy();
  });

  test('lets the visible field label name the input, with no aria-label shadowing it', () => {
    render(<PackageHarness />);

    const input = screen.getByRole('combobox', { name: m['dashboard.providers.form.label_package_name']() });
    expect(input).not.toHaveAttribute('aria-label');
  });
});
