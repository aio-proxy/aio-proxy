import type { locales } from './paraglide/runtime';

export type Locale = (typeof locales)[number];

type LocaleEnv = {
  readonly lang?: string;
  readonly AIO_PROXY_LANG?: string;
  readonly LC_ALL?: string;
  readonly LC_MESSAGES?: string;
  readonly LANG?: string;
  readonly LANGUAGE?: string;
};

declare const process: {
  readonly env: LocaleEnv;
};

function normalizeLocale(value: string | undefined): Locale | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  for (const part of value.split(':')) {
    const tag = part.split('.')[0]?.split('@')[0]?.replaceAll('_', '-');
    const normalized = tag?.toLowerCase();
    if (normalized === 'en' || normalized?.startsWith('en-')) {
      return 'en';
    }
    if (
      normalized === 'zh' ||
      normalized === 'zh-cn' ||
      normalized === 'zh-hans' ||
      normalized?.startsWith('zh-hans-') ||
      normalized?.startsWith('zh-cn-')
    ) {
      return 'zh-Hans';
    }
    if (
      normalized === 'zh-hant' ||
      normalized === 'zh-tw' ||
      normalized === 'zh-hk' ||
      normalized === 'zh-mo' ||
      normalized?.startsWith('zh-hant-') ||
      normalized?.startsWith('zh-tw-') ||
      normalized?.startsWith('zh-hk-') ||
      normalized?.startsWith('zh-mo-')
    ) {
      return 'zh-Hant';
    }
    if (normalized === 'ja' || normalized?.startsWith('ja-')) {
      return 'ja';
    }
    if (normalized === 'ko' || normalized?.startsWith('ko-')) {
      return 'ko';
    }
  }

  return undefined;
}

function intlLocale(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

export function resolveLocale(env: LocaleEnv = process.env): Locale {
  const candidates = [
    env.lang,
    env.AIO_PROXY_LANG,
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANG,
    env.LANGUAGE,
    intlLocale(),
    'en',
  ] as const;

  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale !== undefined) {
      return locale;
    }
  }

  return 'en';
}

export function resolveLocaleFromArgv(argv: readonly string[]): Locale {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lang') {
      const lang = argv[index + 1];
      return resolveLocale(lang === undefined ? {} : { lang });
    }
    if (arg?.startsWith('--lang=')) {
      return resolveLocale({ lang: arg.slice('--lang='.length) });
    }
  }

  return resolveLocale();
}
