import { useEffect, useState } from 'react';

import type { SectionId } from '../lib/section-status';

const SECTION_IDS: readonly SectionId[] = ['identity', 'connection', 'models', 'routing', 'advanced'];

export function useActiveSection(ids: readonly SectionId[] = SECTION_IDS): SectionId {
  const [activeId, setActiveId] = useState<SectionId>(ids[0] ?? 'identity');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        const id = visible[0]?.target.id.replace(/^editor-/u, '');
        if (id === 'identity' || id === 'connection' || id === 'models' || id === 'routing' || id === 'advanced') {
          setActiveId(id);
        }
      },
      { rootMargin: '-20% 0px -55% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const element = document.getElementById(`editor-${id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ids]);

  return activeId;
}
