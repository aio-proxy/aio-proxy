import { getLocale } from '@aio-proxy/i18n';
import { type LocalizedText, resolveLocalizedText } from '@aio-proxy/plugin-sdk';

// DashboardLocalizedTextSchema outputs `string | Record<string, string>`; its superRefine
// guarantees the record carries a `default` key, so the value is a valid LocalizedText at runtime.
export const resolveDashboardText = (text: string | Record<string, string>): string =>
  resolveLocalizedText(text as LocalizedText, getLocale());
