import { m } from '@aio-proxy/i18n';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import type { SectionId, SectionSummary } from '../../../lib/section-status';
import { EditorFooter } from './editor-footer';

const summaries = (overrides: Partial<Record<SectionId, SectionSummary>> = {}): Record<SectionId, SectionSummary> => ({
  identity: { status: 'ok', hint: 'demo-api' },
  connection: { status: 'ok', hint: 'x.example/v1' },
  models: { status: 'ok', hint: '3 models' },
  routing: { status: 'ok', hint: 'weight 40' },
  advanced: { status: 'ok', hint: 'all defaults' },
  ...overrides,
});

const props = {
  primaryLabel: 'Save',
  onPrimary: () => {},
  onCancel: () => {},
  pending: false,
};

const renderFooter = (overrides: Partial<Record<SectionId, SectionSummary>>) =>
  render(
    <>
      <EditorFooter {...props} summaries={summaries(overrides)} />
      {/* Stands in for SectionShell's rendered `<section>`; its own test pins the tabIndex. */}
      <section id="models" tabIndex={-1} />
    </>,
  );

// This is the error-recovery path: the one control whose whole job is "take me to the field blocking my
// save". Scrolling without focusing means the next Tab continues from the footer into Cancel/Save —
// away from the section the user just asked for — and a screen reader reports nothing happened.
test('a jump link scrolls to its section AND moves focus into it', () => {
  const scrollIntoView = rs.fn();
  renderFooter({ models: { status: 'todo', hint: 'no models enabled' } });
  const target = document.getElementById('models') as HTMLElement;
  target.scrollIntoView = scrollIntoView;

  fireEvent.click(screen.getByRole('link', { name: m['dashboard.providers.editor.section_models']() }));

  expect(scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(target);
});

// The sentence and the section names it points at are one announcement: "still missing" alone names
// nothing. They were split so that the live region held the lead-in only, which is what read aloud on
// every keystroke — the fix is that the names change only when the list does.
test('the live region is the whole sentence, section names included', () => {
  renderFooter({ models: { status: 'todo', hint: 'no models enabled' } });

  const jump = screen.getByRole('link', { name: m['dashboard.providers.editor.section_models']() });
  const live = jump.closest('[aria-live]');
  expect(live).not.toBeNull();
  expect(live?.textContent).toBe(
    `${m['dashboard.providers.editor.footer_blocking']()} ${m['dashboard.providers.editor.section_models']()}`,
  );
});

// A section link is a link, not a button: it carries the section's fragment, so it can be copied,
// middle-clicked or read out of the status bar. `preventDefault` handles the in-page jump (the ids live
// in PageContainer's scroll container), but the `href` is the part a `<button>` could never have.
test('a jump link is a real link to the section anchor', () => {
  renderFooter({ models: { status: 'todo', hint: 'no models enabled' } });

  expect(screen.getByRole('link', { name: m['dashboard.providers.editor.section_models']() })).toHaveAttribute(
    'href',
    '#models',
  );
});

// X9: `attention` is no longer a softer `todo` — it is reserved for a draft that genuinely cannot be
// persisted (an unauthorized oauth account), so it is named AND it gates.
test('an attention section is listed and jumpable, and it gates the save', () => {
  renderFooter({ connection: { status: 'attention', hint: 'missing API key' } });

  expect(screen.getByRole('link', { name: m['dashboard.providers.editor.section_connection']() })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('a todo section blocks the save', () => {
  renderFooter({ models: { status: 'todo', hint: 'no models enabled' } });

  expect(screen.getByText(m['dashboard.providers.editor.footer_blocking']())).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

// The lead-in describes the whole list, so it can only promise a missing field when every listed section
// is one. Keying it off `blocking.length > 0` (the gate) instead of the `todo` count told a user whose
// account merely needs authorizing that something was "still missing" from the form.
test('a mixed list reads as pending, because not everything listed is missing', () => {
  renderFooter({
    models: { status: 'todo', hint: 'no models enabled' },
    connection: { status: 'attention', hint: 'missing API key' },
  });

  expect(screen.getByText(m['dashboard.providers.editor.footer_attention']())).toBeTruthy();
  expect(screen.queryByText(m['dashboard.providers.editor.footer_blocking']())).toBeNull();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('nothing outstanding reads as ready inside the live region', () => {
  renderFooter({});

  const ready = screen.getByText(m['dashboard.providers.editor.footer_ready']());
  expect(ready).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

// The footer lists sections in rail order regardless of how the caller's map was built; taking
// `Object.keys(summaries)` back would let that order be reshuffled by the caller. The separator sits
// between the names for the same reason the order does: the sentence has to read as a list.
test('listed sections come back in rail order, separated', () => {
  renderFooter({
    advanced: { status: 'todo', hint: 'invalid JSON' },
    identity: { status: 'todo', hint: 'needs an ID' },
  });

  const live = screen.getByText(m['dashboard.providers.editor.footer_blocking']());
  expect(live.textContent).toBe(
    [
      `${m['dashboard.providers.editor.footer_blocking']()} ${m['dashboard.providers.editor.section_identity']()}`,
      m['dashboard.providers.editor.section_advanced'](),
    ].join(m['dashboard.providers.editor.footer_section_separator']()),
  );
});
