import { m } from '@aio-proxy/i18n';
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import type { SectionId, SectionSummary } from '../../../lib/section-status';
import { SectionNav } from './section-nav';

const summaries: Readonly<Record<SectionId, SectionSummary>> = {
  identity: { status: 'ok', hint: 'demo-api' },
  connection: { status: 'attention', hint: 'missing API key' },
  models: { status: 'todo', hint: 'no models enabled' },
  routing: { status: 'ok', hint: 'weight 40' },
  advanced: { status: 'ok', hint: 'all defaults' },
};

const PILLS = [
  ['identity', m['dashboard.providers.editor.section_identity']()],
  ['connection', m['dashboard.providers.editor.section_connection']()],
  ['models', m['dashboard.providers.editor.section_models']()],
  ['routing', m['dashboard.providers.editor.section_routing']()],
  ['advanced', m['dashboard.providers.editor.section_advanced']()],
] as const;

// The label is the bare section title and the dot carries the status: an ordinal prefix or a status
// word back in the pill reds on the exact-name lookup.
test('every section is a pill labelled by its title alone, with a status dot', () => {
  render(<SectionNav summaries={summaries} activeId="identity" />);

  for (const [id, label] of PILLS) {
    const pill = screen.getByRole('link', { name: label });
    expect(pill).toHaveAttribute('href', `#editor-${id}`);
    expect(pill.querySelector('span[aria-hidden="true"].rounded-full')).toBeTruthy();
  }
});

// The nav used to be a `hidden w-48 lg:block` third column, so below 1024px there was no section nav
// and no per-section status at all. jsdom applies no media queries, so the class list is the only
// thing that can see that mutant come back.
test('the pill strip is never hidden at a breakpoint', () => {
  render(<SectionNav summaries={summaries} activeId="identity" />);

  const nav = screen.getByRole('navigation');
  expect(nav.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/u);
  expect(nav.className).not.toMatch(/\blg:(?:block|flex|hidden|inline)/u);
  expect(nav.className).toContain('overflow-x-auto');
});

test('only the active section pill is marked current', () => {
  render(<SectionNav summaries={summaries} activeId="models" />);

  expect(screen.getByRole('link', { name: m['dashboard.providers.editor.section_models']() })).toHaveAttribute(
    'aria-current',
  );
  expect(screen.getByRole('link', { name: m['dashboard.providers.editor.section_identity']() })).not.toHaveAttribute(
    'aria-current',
  );
});
