import { m } from '@aio-proxy/i18n';

import { StatusDot } from '../../../components/provider-editor/status-dot';
import { jumpToSection } from '../../../lib/jump-to-section';
import { SECTION_LABEL, SECTION_ORDER, type SectionId, type SectionSummary } from '../../../lib/section-status';

interface SectionNavProps {
  readonly summaries: Readonly<Record<SectionId, SectionSummary>>;
  readonly activeId: SectionId;
}

// A horizontal strip, never breakpoint-gated: the column version vanished under 1024px and took every
// section's status with it. `overflow-x-auto` lets it scroll sideways instead. The translucent
// background and `py-2.5` are load-bearing, not decoration — this pins to the top of PageContainer's
// scroll container with live form fields sliding under it. Its 48px height is the top `rootMargin`
// inset in `use-active-section`; change one and the active pill starts naming a hidden section.
export const SectionNav: React.FC<SectionNavProps> = ({ summaries, activeId }) => (
  <nav
    aria-label={m['dashboard.providers.editor.section_nav_label']()}
    className="sticky top-0 z-20 mb-6 flex gap-1 overflow-x-auto bg-page-background/85 py-2.5 backdrop-blur-md"
  >
    {SECTION_ORDER.map((id) => (
      <a
        key={id}
        href={`#editor-${id}`}
        aria-current={activeId === id ? 'location' : undefined}
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
);
