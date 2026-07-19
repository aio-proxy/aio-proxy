import type { Locale } from "./resolve";

import { setLocale as setParaglideLocale } from "./paraglide/runtime";

export function setLocale(locale: Locale): void | Promise<void> {
  return setParaglideLocale(locale, { reload: false });
}
