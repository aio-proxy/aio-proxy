import { describe, expect, test } from 'bun:test';

import { resolveLocale, resolveLocaleFromArgv } from '../src/resolve';

describe('resolveLocale', () => {
  test('uses explicit lang before process environment when both exist', () => {
    // Given
    process.env.AIO_PROXY_LANG = 'zh-CN';

    try {
      // When / Then
      expect(resolveLocale({ lang: 'en' })).toBe('en');
    } finally {
      delete process.env.AIO_PROXY_LANG;
    }
  });

  test('uses environment chain before Intl fallback when requested', () => {
    // Given
    process.env.AIO_PROXY_LANG = 'bad';
    process.env.LC_ALL = 'zh_CN.UTF-8';

    try {
      // When / Then
      expect(resolveLocale()).toBe('zh-Hans');
    } finally {
      delete process.env.AIO_PROXY_LANG;
      delete process.env.LC_ALL;
    }
  });

  test('normalizes zh-Hans and zh to zh-Hans', () => {
    // Given / When / Then
    expect(resolveLocale({ lang: 'zh-Hans' })).toBe('zh-Hans');
    expect(resolveLocale({ lang: 'zh' })).toBe('zh-Hans');
  });

  test('normalizes Traditional Chinese region tags to zh-Hant', () => {
    // Given / When / Then
    expect(resolveLocale({ lang: 'zh-Hant' })).toBe('zh-Hant');
    expect(resolveLocale({ lang: 'zh-TW' })).toBe('zh-Hant');
    expect(resolveLocale({ lang: 'zh-HK' })).toBe('zh-Hant');
    expect(resolveLocale({ lang: 'zh-Hant-TW' })).toBe('zh-Hant');
  });

  test('normalizes Japanese and Korean tags to ja and ko', () => {
    // Given / When / Then
    expect(resolveLocale({ lang: 'ja' })).toBe('ja');
    expect(resolveLocale({ lang: 'ja-JP' })).toBe('ja');
    expect(resolveLocale({ lang: 'ko' })).toBe('ko');
    expect(resolveLocale({ lang: 'ko-KR' })).toBe('ko');
  });

  test('falls back to en for malformed input', () => {
    // Given / When / Then
    expect(resolveLocale({ lang: 'not-a-locale' })).toBe('en');
  });
});

describe('resolveLocaleFromArgv', () => {
  test('reads --lang value forms before environment fallback', () => {
    // Given / When / Then
    expect(resolveLocaleFromArgv(['run', '--lang', 'zh_CN.UTF-8'])).toBe('zh-Hans');
    expect(resolveLocaleFromArgv(['run', '--lang=en'])).toBe('en');
  });
});
