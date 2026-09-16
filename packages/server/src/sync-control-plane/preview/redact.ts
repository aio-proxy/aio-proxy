import type { EntityBody } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncPreviewRow } from '@aio-proxy/types';
import { isEqual } from 'es-toolkit';

// `headers` and `account` are listed as whole records: any child name can carry a credential
// (`Authorization`, `Cookie`, a vendor-specific name, an OAuth refresh token), so the map is
// redacted wholesale rather than matched key by key. The bare `secret`/`credential` alternatives
// already cover `secrets`, `pluginSecret`, and `credentials` by substring.
export const SECRET_KEY =
  /(?:secret|password|passwd|token|credential|api[-_]?key|refresh|access[-_]?key|^(?:headers|account)$|(?:^|\.)(?:headers|account)\.)/iu;

function redact(value: JsonValue, key = '', secretKeys: ReadonlySet<string> = new Set()): JsonValue {
  if (SECRET_KEY.test(key) || secretKeys.has(key)) return '[redacted]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, '', secretKeys)) as JsonValue;
  // A key of the authored body is user data, so it can be `__proto__`. `fromEntries` creates an own
  // property where plain assignment would reach the legacy prototype setter and drop the key from
  // the preview, while Apply still used the original body — approving a change never shown.
  return Object.fromEntries(
    Object.entries(value).map(([childKey, entry]) => [childKey, redact(entry, childKey, secretKeys)]),
  ) as JsonValue;
}

export function redactEntityValue(body: EntityBody, secretKeys: ReadonlySet<string>): JsonValue {
  const wholeRecord = body.kind === 'plugin-business' && /(?:secret|credential)/iu.test(body.logicalKey);
  if (wholeRecord) return '[redacted]';
  return redact(structuredClone(body.value), '', secretKeys);
}

function sensitive(value: JsonValue | null, secretKeys: ReadonlySet<string> = new Set()): Map<string, JsonValue> {
  // Keyed by an authored path, so `__proto__` is reachable here too — see `redact`. The key is the
  // segment list rather than its dotted join because an authored key may itself contain a dot:
  // `{'a.b': {apiKey}}` and `{a: {b: {apiKey}}}` both join to `a.b.apiKey`, and the second leaf
  // would overwrite the first — a change to the loser then compares equal and reports no secret
  // change while the preview redacts both. Matching still uses the dotted form.
  const found = new Map<string, JsonValue>();
  const visit = (entry: JsonValue, path: readonly string[]): void => {
    if (entry === null || typeof entry !== 'object') {
      const dotted = path.join('.');
      if (SECRET_KEY.test(dotted) || secretKeys.has(dotted) || secretKeys.has(path.at(-1) ?? ''))
        found.set(JSON.stringify(path), entry);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, [...path, `[${index}]`]));
      return;
    }
    for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
  };
  if (value !== null) visit(value, []);
  return found;
}

export function secretChange(
  local: JsonValue | null,
  cloud: JsonValue | null,
  secretKeys?: ReadonlySet<string>,
): SyncPreviewRow['secretChange'] {
  const safeKeys = secretKeys ?? new Set<string>();
  const left = sensitive(local, safeKeys);
  const right = sensitive(cloud, safeKeys);
  if (left.size === 0 && right.size === 0) return 'none';
  if (left.size === 0) return 'added';
  if (right.size === 0) return 'removed';
  // Compared by key rather than by serialization: two devices that authored the same credentials
  // in a different key order hold the same secrets, and reporting that as a change would ask the
  // user to resolve a conflict that does not exist.
  return isEqual(left, right) ? 'none' : 'changed';
}
