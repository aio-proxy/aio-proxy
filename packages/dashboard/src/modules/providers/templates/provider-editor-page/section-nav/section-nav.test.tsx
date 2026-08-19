import { m } from '@aio-proxy/i18n';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { STATUS_CLASS } from '../../../components/provider-editor/status-dot';
import { SECTION_ORDER, type SectionId, type SectionSummary } from '../../../lib/section-status';
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
// word back in the pill reds on the exact-name lookup. The fixture spans all three statuses, so the
// dot's class is asserted per status — presence alone still passed when every dot shared one colour.
test('every section is a pill labelled by its title alone, with a dot in its own status colour', () => {
  render(<SectionNav summaries={summaries} activeId="identity" />);

  for (const [id, label] of PILLS) {
    const pill = screen.getByRole('link', { name: label });
    expect(pill).toHaveAttribute('href', `#editor-${id}`);
    const dot = pill.querySelector('span[aria-hidden="true"].rounded-full');
    expect(dot?.className).toContain(STATUS_CLASS[summaries[id].status]);
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

// The strip is a list of sections, not the page: `edit_title` ("Edit Provider") named it after the
// route and was plainly false on the create route, where the same nav renders.
test('the strip is labelled as a section list, not as the edit page', () => {
  render(<SectionNav summaries={summaries} activeId="identity" />);

  const nav = screen.getByRole('navigation');
  expect(nav).toHaveAttribute('aria-label', m['dashboard.providers.editor.section_nav_label']());
  expect(nav.getAttribute('aria-label')).not.toBe(m['dashboard.providers.edit_title']());
});

// `preventDefault()` suppresses the one native behaviour that matters here — the browser moving focus
// to the fragment target — because the sections live in PageContainer's scroll container and a bare
// hash jump does not reliably land on them. Both halves have to be replaced, so both are asserted:
// dropping `focus` leaves the keyboard user's next Tab back at the nav strip, and dropping
// `scrollIntoView` puts the section behind the sticky header on the platforms the manual scroll exists for.
test('activating a pill scrolls to the section AND moves focus into it', () => {
  const scrollIntoView = rs.fn();
  render(
    <>
      <SectionNav summaries={summaries} activeId="identity" />
      {/* Stands in for SectionShell's rendered `<section>`; its own test pins the tabIndex. */}
      <section id="editor-models" tabIndex={-1} />
    </>,
  );
  const target = document.getElementById('editor-models') as HTMLElement;
  target.scrollIntoView = scrollIntoView;

  fireEvent.click(screen.getByRole('link', { name: m['dashboard.providers.editor.section_models']() }));

  expect(scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement).toBe(target);
});

// The pills set `outline-none`, so without the ring a keyboard user tabbing the strip sees nothing at
// all. The prototype pairs the two; keeping only the first half is the mutant this kills.
test('a pill that suppresses the native outline supplies a focus-visible ring', () => {
  render(<SectionNav summaries={summaries} activeId="identity" />);

  const pill = screen.getByRole('link', { name: m['dashboard.providers.editor.section_identity']() });
  expect(pill.className).toContain('outline-none');
  expect(pill.className).toContain('focus-visible:ring-3');
});

// One registry (`lib/section-status`) or five copies: the nav used to re-declare its own order and
// label map, so a sixth SectionId compiled fine here and rendered five tabs.
test('the strip renders exactly the shared section registry, in its order', () => {
  render(<SectionNav summaries={summaries} activeId="identity" />);

  const labels = screen.getAllByRole('link').map((pill) => pill.textContent);
  expect(labels).toEqual(PILLS.map(([, label]) => label));
  expect(SECTION_ORDER).toEqual(PILLS.map(([id]) => id));
});
