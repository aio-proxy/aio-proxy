import { m } from '@aio-proxy/i18n';
import { ProviderKind } from '@aio-proxy/types';
import { describe, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { ProviderFormMode } from '../../../lib/constants';
import { KindCard } from './kind-card';

const renderKind = (mode: ProviderFormMode, value: ProviderKind) => {
  const onChange = rs.fn();
  render(<KindCard value={value} mode={mode} onChange={onChange} />);
  return onChange;
};

const kindCard = (name: RegExp) => screen.getByRole('radio', { name });

describe('KindCard', () => {
  test('offers all three kind cards with their hints and reports the picked kind', () => {
    const onChange = renderKind(ProviderFormMode.Create, ProviderKind.Api);

    // Named by the card heading, not a repeated `aria-label`: a group whose name is also rendered
    // above it must borrow that text, or it is announced twice.
    expect(screen.getByRole('radiogroup', { name: m['dashboard.providers.editor.kind_label']() })).toBeTruthy();
    expect(kindCard(/API/u)).toHaveAttribute('aria-checked', 'true');
    expect(kindCard(/OAuth/u)).toHaveAttribute('aria-checked', 'false');
    expect(kindCard(/AI SDK/u)).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(m['dashboard.providers.editor.kind_api_hint']())).toBeTruthy();
    expect(screen.getByText(m['dashboard.providers.editor.kind_oauth_hint']())).toBeTruthy();
    expect(screen.getByText(m['dashboard.providers.editor.kind_ai_sdk_hint']())).toBeTruthy();

    fireEvent.click(kindCard(/AI SDK/u));

    expect(onChange).toHaveBeenCalledWith(ProviderKind.AiSdk);
  });

  test('walks the cards with either arrow axis, wraps at the ends, and keeps one tab stop', () => {
    const onChange = renderKind(ProviderFormMode.Create, ProviderKind.Api);
    const group = screen.getByRole('radiogroup');

    // Roving tabindex: Tab enters the group at the selected card, not at all three.
    expect(kindCard(/API/u)).toHaveAttribute('tabindex', '0');
    expect(kindCard(/OAuth/u)).toHaveAttribute('tabindex', '-1');
    expect(kindCard(/AI SDK/u)).toHaveAttribute('tabindex', '-1');

    // `false` means the handler called preventDefault, so arrows do not also scroll the page.
    expect(fireEvent.keyDown(group, { key: 'ArrowRight' })).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(ProviderKind.OAuth);
    expect(document.activeElement).toBe(kindCard(/OAuth/u));

    fireEvent.keyDown(group, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith(ProviderKind.OAuth);

    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(ProviderKind.AiSdk);

    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith(ProviderKind.AiSdk);

    fireEvent.keyDown(group, { key: 'a' });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  // The description says what the choice governs, so it belongs only where a choice is still open. The
  // settled line stays: the kind is immutable, and nothing else on the screen says so.
  test('states the locked kind instead of a picker when editing, and drops the choice description', () => {
    renderKind(ProviderFormMode.Edit, ProviderKind.AiSdk);

    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByTestId('provider-editor-kind-locked')).toHaveTextContent(
      m['dashboard.providers.editor.kind_ai_sdk'](),
    );
    expect(screen.getByText(m['dashboard.providers.editor.kind_locked_note']())).toBeTruthy();
    expect(screen.queryByText(m['dashboard.providers.editor.kind_description']())).toBeNull();
  });
});
