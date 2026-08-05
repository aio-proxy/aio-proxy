import type { Locale as DateFnsLocale } from 'date-fns';
import { enUS, ja, ko, zhCN, zhTW } from 'date-fns/locale';

import { getLocale } from './paraglide/runtime';
import type { Locale } from './resolve';

const DATE_FNS_LOCALES = {
  en: enUS,
  'zh-Hans': zhCN,
  'zh-Hant': zhTW,
  ja,
  ko,
} as const satisfies Record<Locale, DateFnsLocale>;

export const dateFnsLocale = (locale: Locale = getLocale()): DateFnsLocale => DATE_FNS_LOCALES[locale];
