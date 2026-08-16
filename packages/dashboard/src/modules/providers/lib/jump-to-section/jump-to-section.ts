import type { SectionId } from '../section-status';

/**
 * Scroll a section of the provider editor into view and move keyboard focus into it.
 *
 * The editor has two jump surfaces — the nav strip and the save footer — and they must behave
 * identically, so the sequence lives here once rather than being kept in step by hand.
 *
 * Focus travels with the viewport deliberately. This is the error-recovery path ("take me to the field
 * blocking my save"), and scrolling alone leaves the next Tab where it started: in the footer on
 * Cancel/Save, or back in the nav strip. The nav strip additionally needs it because it calls
 * `preventDefault` on its own anchor, which suppresses the browser's native focus move onto the
 * fragment target.
 *
 * The scroll is manual rather than a bare `#hash` because the section ids live inside PageContainer's
 * scroll container, not the document, so a fragment jump does not reliably land on them.
 */
export const jumpToSection = (id: SectionId): void => {
  const target = document.getElementById(`editor-${id}`);
  target?.scrollIntoView({ behavior: 'smooth' });
  target?.focus({ preventScroll: true });
};
