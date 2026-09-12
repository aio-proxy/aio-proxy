import type { EntityBody } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { SyncPreviewRow } from '@aio-proxy/types';

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

function sensitive(value: JsonValue | null, secretKeys: ReadonlySet<string> = new Set()): Record<string, JsonValue> {
  // Keyed by an authored path, so `__proto__` is reachable here too — see `redact`.
  const found = new Map<string, JsonValue>();
  const visit = (entry: JsonValue, path: string): void => {
    if (entry === null || typeof entry !== 'object') {
      if (SECRET_KEY.test(path) || secretKeys.has(path) || secretKeys.has(path.split('.').at(-1) ?? ''))
        found.set(path, entry);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(entry)) visit(child, path === '' ? key : `${path}.${key}`);
  };
  if (value !== null) visit(value, '');
  return Object.fromEntries(found);
}

export function secretChange(
  local: JsonValue | null,
  cloud: JsonValue | null,
  secretKeys?: ReadonlySet<string>,
): SyncPreviewRow['secretChange'] {
  const safeKeys = secretKeys ?? new Set<string>();
  const left = sensitive(local, safeKeys);
  const right = sensitive(cloud, safeKeys);
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length === 0 && rightKeys.length === 0) return 'none';
  if (leftKeys.length === 0) return 'added';
  if (rightKeys.length === 0) return 'removed';
  return JSON.stringify(left) === JSON.stringify(right) ? 'none' : 'changed';
}
