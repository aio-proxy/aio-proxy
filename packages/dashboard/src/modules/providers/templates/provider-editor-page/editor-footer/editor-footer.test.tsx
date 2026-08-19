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
      <section id="editor-models" tabIndex={-1} />
    </>,
  );

// This is the error-recovery path: the one control whose whole job is "take me to the field blocking my
// save". Scrolling without focusing means the next Tab continues from the footer into Cancel/Save —
// away from the section the user just asked for — and a screen reader reports nothing happened.
test('a jump link scrolls to its section AND moves focus into it', () => {
  const scrollIntoView = rs.fn();
  renderFooter({ models: { status: 'todo', hint: 'no models enabled' } });
  const target = document.getElementById('editor-models') as HTMLElement;
  target.scrollIntoView = scrollIntoView;

  fireEvent.click(screen.getByRole('button', { name: m['dashboard.providers.editor.section_models']() }));

  expect(scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(target);
});

// `aria-live` used to sit on the `<p>` that *contains* the jump links, so every status flip re-announced
// the sentence and every link label — typing in a field made the footer read itself aloud.
test('the live region announces the summary sentence and never the jump links', () => {
  renderFooter({ models: { status: 'todo', hint: 'no models enabled' } });

  const live = screen.getByText(m['dashboard.providers.editor.footer_blocking']());
  expect(live.closest('[aria-live]')).not.toBeNull();
  const jump = screen.getByRole('button', { name: m['dashboard.providers.editor.section_models']() });
  expect(jump.closest('[aria-live]')).toBeNull();
});

// X9: `attention` is no longer a softer `todo` — it is reserved for a draft that genuinely cannot be
// persisted (an unauthorized oauth account), so it is named AND it gates.
test('an attention section is listed and jumpable, and it gates the save', () => {
  renderFooter({ connection: { status: 'attention', hint: 'missing API key' } });

  expect(screen.getByRole('button', { name: m['dashboard.providers.editor.section_connection']() })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('a todo section blocks the save', () => {
  renderFooter({ models: { status: 'todo', hint: 'no models enabled' } });

  expect(screen.getByText(m['dashboard.providers.editor.footer_blocking']())).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

// Mixed list: the sentence must not soften while Save is still gated. The lead-in keys off
// `blocking.length > 0`, so one `todo` beside an `attention` keeps "complete these before saving" —
// telling the user to fix something while a disabled Save contradicts it is the defect this pins.
// The `attention`-only test above is the other half: `listed.length > 0` would redden it.
test('a mixed list keeps the blocking sentence because the todo still gates the save', () => {
  renderFooter({
    models: { status: 'todo', hint: 'no models enabled' },
    connection: { status: 'attention', hint: 'missing API key' },
  });

  expect(screen.getByText(m['dashboard.providers.editor.footer_blocking']())).toBeTruthy();
  expect(screen.queryByText(m['dashboard.providers.editor.footer_attention']())).toBeNull();
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('nothing outstanding reads as ready inside the live region', () => {
  renderFooter({});

  const ready = screen.getByText(m['dashboard.providers.editor.footer_ready']());
  expect(ready).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});

// The footer lists sections in rail order regardless of how the caller's map was built; taking
// `Object.keys(summaries)` back would let that order be reshuffled by the caller.
test('listed sections come back in rail order', () => {
  renderFooter({
    advanced: { status: 'todo', hint: 'invalid JSON' },
    identity: { status: 'todo', hint: 'needs an ID' },
  });

  const labels = screen
    .getAllByRole('button')
    .map((button) => button.textContent)
    .filter(
      (label) =>
        label === m['dashboard.providers.editor.section_identity']() ||
        label === m['dashboard.providers.editor.section_advanced'](),
    );
  expect(labels).toEqual([
    m['dashboard.providers.editor.section_identity'](),
    m['dashboard.providers.editor.section_advanced'](),
  ]);
});
