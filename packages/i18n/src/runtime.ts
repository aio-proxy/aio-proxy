import { setLocale as setParaglideLocale } from "./paraglide/runtime";
import type { Locale } from "./resolve";

export function setLocale(locale: Locale): void | Promise<void> {
  return setParaglideLocale(locale, { reload: false });
}
