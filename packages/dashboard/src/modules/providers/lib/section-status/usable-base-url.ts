/**
 * The body the editor dispatches parses `baseURL` with `z.url()`, so an unparseable string is rejected
 * on save exactly as an empty one is, and has to read the same here — the form has no validators, so
 * this is the only gate. Deliberately stricter than `z.url()` on the scheme, which accepts any: the
 * proxy calls an upstream over http(s) only. `{{...}}` templates are authoring-only and are NOT in the
 * mutation body's union, so they belong on the `todo` side too.
 *
 * Private to this directory: both `section-status.ts` (for the status) and `section-hint.ts` (for the
 * hint that explains it) need it, and the barrel is `export * from './section-status'`, so keeping it
 * there would have leaked it onto the module's public surface (D-F12).
 */
export const usableBaseURL = (baseURL: string): boolean =>
  URL.canParse(baseURL) && ['http:', 'https:'].includes(new URL(baseURL).protocol);
