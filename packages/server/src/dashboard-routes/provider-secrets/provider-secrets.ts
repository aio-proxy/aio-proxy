import { resolveConfigTemplates } from '@aio-proxy/core';
import { mapValues } from 'es-toolkit/object';
import { isPlainObject } from 'es-toolkit/predicate';

const OPENAI_SECRET_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/;
const BEARER_SECRET_PATTERN = /^Bearer\s+.+$/i;
const TOKEN_SECRET_PATTERN = /^Token\s+.+$/i;
const API_KEY_TEXT_PATTERN = /("?apiKey"?\s*:\s*")[^"]*(")/gi;
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/i;
const MUSTACHE_PATTERN = /\{\{[\s\S]*\}\}/u;

const isSecretBoundaryKey = (key: string): boolean =>
  SENSITIVE_KEY_PATTERN.test(key) || key.toLowerCase() === 'headers' || key.toLowerCase() === 'proxy';

const maskSecret = (key: string, value: string): string => {
  if (OPENAI_SECRET_PATTERN.test(value)) {
    return 'sk-****';
  }

  if (BEARER_SECRET_PATTERN.test(value) || TOKEN_SECRET_PATTERN.test(value)) {
    return '****';
  }

  if (isSecretBoundaryKey(key)) {
    return '****';
  }

  return value.replace(API_KEY_TEXT_PATTERN, '$1****$2');
};

export const redactSecrets = (value: unknown, key = '', insideSecretBoundary = false): unknown => {
  if (typeof value === 'string') {
    return insideSecretBoundary ? '****' : maskSecret(key, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, key, insideSecretBoundary));
  }

  if (isPlainObject(value)) {
    return mapValues(value, (entryValue, entryKey) => {
      const keyStr = typeof entryKey === 'string' ? entryKey : '';
      return redactSecrets(
        entryValue,
        keyStr,
        insideSecretBoundary || keyStr.toLowerCase() === 'headers' || keyStr.toLowerCase() === 'proxy',
      );
    });
  }

  return value;
};

export function retainAuthoredTemplateStrings(
  authored: unknown,
  submitted: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): unknown {
  if (typeof submitted === 'string') {
    if (typeof authored === 'string' && MUSTACHE_PATTERN.test(authored)) {
      const expanded = resolveConfigTemplates(authored, env);
      if (submitted === expanded) return authored;
    }
    return submitted;
  }

  if (Array.isArray(submitted)) {
    const previousItems = Array.isArray(authored) ? authored : [];
    return submitted.map((value, index) => retainAuthoredTemplateStrings(previousItems[index], value, env));
  }

  if (isPlainObject(submitted)) {
    const previous = isPlainObject(authored) ? authored : {};
    return mapValues(submitted, (value, key) => retainAuthoredTemplateStrings(previous[key], value, env));
  }

  return submitted;
}
