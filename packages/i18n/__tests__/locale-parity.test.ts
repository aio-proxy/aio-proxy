import { expect, test } from 'bun:test';

const LOCALES = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko'] as const;

const flatten = (value: unknown, prefix = ''): string[] => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value)
    .filter(([key]) => key !== '$schema')
    .flatMap(([key, child]) => flatten(child, prefix === '' ? key : `${prefix}.${key}`));
};

test('all five locales share one key set', async () => {
  const keySets = await Promise.all(
    LOCALES.map(async (locale) => {
      const data = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url).pathname).json();
      return [locale, new Set(flatten(data))] as const;
    }),
  );
  const [, enKeys] = keySets[0]!;
  for (const [locale, keys] of keySets.slice(1)) {
    expect({ locale, missing: [...enKeys].filter((key) => !keys.has(key)).sort() }).toEqual({ locale, missing: [] });
    expect({ locale, extra: [...keys].filter((key) => !enKeys.has(key)).sort() }).toEqual({ locale, extra: [] });
  }
});
