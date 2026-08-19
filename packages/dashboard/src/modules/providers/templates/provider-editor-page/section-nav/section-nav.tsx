import { m } from '@aio-proxy/i18n';

import { StatusDot } from '../../../components/provider-editor/status-dot';
import { jumpToSection } from '../../../lib/jump-to-section';
import { SECTION_LABEL, SECTION_ORDER, type SectionId, type SectionSummary } from '../../../lib/section-status';

interface SectionNavProps {
  readonly summaries: Readonly<Record<SectionId, SectionSummary>>;
  readonly activeId: SectionId;
}

// A horizontal strip, never breakpoint-gated: the column version vanished under 1024px and took every
// section's status with it. `overflow-x-auto` lets it scroll sideways instead. The wrapper is what pins
// and what carries the translucent backdrop, not the `<nav>` itself: a strip narrow enough to scroll
// sideways would otherwise drag its own background and bottom edge out from under the pills. Its ~37px
// height is the top `rootMargin` inset in `use-active-section`; change one and the active pill starts
// naming a section hidden behind the strip.
export const SectionNav: React.FC<SectionNavProps> = ({ summaries, activeId }) => (
  <div className="sticky top-0 z-20 mb-6 border-b bg-page-background/85 pb-2 backdrop-blur-md">
    <nav aria-label={m['dashboard.providers.editor.section_nav_label']()} className="flex gap-1 overflow-x-auto">
      {SECTION_ORDER.map((id) => (
        <a
          key={id}
          href={`#${id}`}
          // `'true'`, not `'location'`: these link to the sections of the page the user is already on, so
          // the active pill is the current *item* of a set. `location` says "this link points at the
          // current page", which is what a site-wide nav says about the entry for the page you are on.
          aria-current={activeId === id ? 'true' : undefined}
          className={`flex shrink-0 items-center gap-1.5 rounded-2xl px-2.5 py-1 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 ${
            activeId === id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60'
          }`}
          // `preventDefault` because a bare hash jump does not reliably land on ids that live inside
          // PageContainer's scroll container rather than the document; `jumpToSection` does that scroll
          // and restores the focus move `preventDefault` suppressed. Shared with the save footer so the
          // two jump surfaces cannot drift.
          onClick={(event) => {
            event.preventDefault();
            jumpToSection(id);
          }}
        >
          <StatusDot status={summaries[id].status} />
          {m[SECTION_LABEL[id]]()}
        </a>
      ))}
    </nav>
  </div>
);
