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
  const target = document.getElementById(id);
  // One check instead of two `?.`: with no element there is nothing to scroll to and no fragment worth
  // putting in the address bar either.
  if (target === null) return;
  target.scrollIntoView({ behavior: 'smooth' });
  target.focus({ preventScroll: true });
  // shell7: the nav and footer are real `<a href>` links now, but both call `preventDefault` because the
  // scroll container is not the document. Writing the hash back keeps the address bar, and so copying
  // or bookmarking a section link, equivalent to the prototype's native fragment jump.
  // The current state is passed back through rather than dropped: TanStack Router keeps its own key and
  // history index in `history.state`, and replacing that with `null` leaves it unable to tell a back from
  // a forward — which is what drives its scroll restoration.
  history.replaceState(history.state, '', `#${id}`);
};
