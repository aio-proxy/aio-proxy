import { useEffect, useRef, useState } from 'react';

// Watches a zero-height sentinel at the top of the page; once it scrolls out of view the page counts as scrolled.
export function useScrolled<T extends Element>() {
  const sentinelRef = useRef<T>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return { sentinelRef, scrolled };
}
