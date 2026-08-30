import { expect, test } from 'bun:test';
const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko'] as const;

const flatten = (value: unknown, prefix = ''): [string, unknown][] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [[prefix, value]];
  return Object.entries(value)
    .filter(([key]) => key !== '$schema')
    .flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

const placeholders = (value: unknown): string =>
  typeof value === 'string'
    ? [...value.matchAll(/\{(\w+)\}/g)]
        .map((match) => match[1]!)
        .sort()
        .join(',')
    : '';

test('all five locales share one key set and one placeholder set per key', async () => {
  const catalogs = await Promise.all(
    LOCALES.map(async (locale) => {
      const data = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
      return [locale, new Map(flatten(data))] as const;
    }),
  );
  const [, en] = catalogs[0]!;
  for (const [locale, messages] of catalogs.slice(1)) {
    expect({ locale, missing: [...en.keys()].filter((key) => !messages.has(key)).sort() }).toEqual({
      locale,
      missing: [],
    });
    expect({ locale, extra: [...messages.keys()].filter((key) => !en.has(key)).sort() }).toEqual({ locale, extra: [] });
    // A renamed or dropped placeholder is invisible to everything else in the
    // toolchain: paraglide unions the placeholder sets across locales, so the
    // generated signature still typechecks and the value renders `undefined`.
    // The key-set assertions above cannot see it either — the key is present.
    const drift = [...en]
      .filter(([key, value]) => placeholders(messages.get(key)) !== placeholders(value))
      .map(([key]) => key)
      .sort();
    expect({ locale, placeholderDrift: drift }).toEqual({ locale, placeholderDrift: [] });
  }
});
