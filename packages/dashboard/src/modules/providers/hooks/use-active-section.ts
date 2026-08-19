import { useEffect, useState } from 'react';

import { SECTION_ORDER, type SectionId } from '../lib/section-status';

const KNOWN = new Set<string>(SECTION_ORDER);

export function useActiveSection(ids: readonly SectionId[] = SECTION_ORDER): SectionId {
  const [activeId, setActiveId] = useState<SectionId>(ids[0] ?? 'identity');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        const id = visible[0]?.target.id;
        // A membership test over the shared registry, not a hand-rolled `||` chain: the chain silently
        // stopped matching a section that was added to `SECTION_ORDER`, leaving the active pill stale.
        if (id !== undefined && KNOWN.has(id)) setActiveId(id as SectionId);
      },
      // The top inset is the sticky nav strip's own height (`section-nav.tsx`: py-2.5 around a 28px
      // pill, 48px): without it the active pill names the section hidden behind the strip.
      { rootMargin: '-48px 0px -55% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);

  return activeId;
}
