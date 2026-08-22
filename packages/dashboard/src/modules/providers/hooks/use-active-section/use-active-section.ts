import { useEffect, useRef, useState } from 'react';

import { SECTION_ORDER, type SectionId } from '../../lib/section-status';

const KNOWN = new Set<string>(SECTION_ORDER);

export function useActiveSection(): SectionId {
  const [activeId, setActiveId] = useState<SectionId>(SECTION_ORDER[0] ?? 'identity');
  // An IntersectionObserver callback carries only the sections whose visibility *changed*, so the whole
  // visible set has to be remembered between callbacks. Deciding from one callback's entries alone handed
  // the pill to whichever section changed last: scrolling down past Models fired one entry for Routing
  // entering, with Models still on screen and absent from that batch, so the pill skipped ahead.
  const visible = useRef(new Map<SectionId, boolean>());

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // A membership test over the shared registry, not a hand-rolled `||` chain: the chain silently
          // stopped matching a section that was added to `SECTION_ORDER`, leaving the active pill stale.
          if (KNOWN.has(entry.target.id)) visible.current.set(entry.target.id as SectionId, entry.isIntersecting);
        }
        // Ranked by the registry rather than `boundingClientRect.top`: a remembered entry's rect is a
        // snapshot from the callback that delivered it and is stale by the next scroll. The sections are
        // rendered in `SECTION_ORDER`, which is what comparing rects was standing in for.
        const first = SECTION_ORDER.find((id) => visible.current.get(id) === true);
        if (first !== undefined) setActiveId(first);
      },
      // The top inset is the sticky strip the nav sits in (`section-nav.tsx`: a 28px pill row over
      // `pb-2` and a border, ~37px) plus ~11px of deliberate slack — a section should count as active
      // once it is properly clear of the strip, not the moment its first pixel emerges from under it.
      // Without any inset the active pill names the section hidden behind the strip.
      { rootMargin: '-48px 0px -55% 0px', threshold: 0 },
    );
    for (const id of SECTION_ORDER) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  return activeId;
}
