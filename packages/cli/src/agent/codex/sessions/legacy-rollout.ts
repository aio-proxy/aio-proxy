import { createHash } from 'node:crypto';

type JsonRecord = { readonly [key: string]: unknown };

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LegacySessionMetadata = {
  readonly id: string;
  readonly providerId: string;
  readonly line: number;
};

export function fingerprintBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Finds the single authoritative legacy session header. Parsing is deliberately
 * strict: a malformed record or a second session_meta is unsafe to rewrite.
 */
export function inspectLegacyMetadata(bytes: Uint8Array): LegacySessionMetadata {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('legacy rollout is not valid UTF-8');
  }
  const lines = text.split('\n');
  let found: LegacySessionMetadata | undefined;
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line]!;
    if (raw.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error('legacy rollout contains malformed JSON');
    }
    if (!isRecord(record) || record['type'] !== 'session_meta') continue;
    const payload = record['payload'];
    if (!isRecord(payload) || typeof payload['id'] !== 'string' || !uuidPattern.test(payload['id']))
      throw new Error('no unique session_meta.payload.id');
    if (typeof payload['model_provider'] !== 'string' || payload['model_provider'].length === 0)
      throw new Error('session_meta.payload.model_provider is missing');
    if (found !== undefined) throw new Error('multiple session_meta records are not supported');
    const keyMatches = raw.match(/"model_provider"\s*:/g) ?? [];
    if (keyMatches.length !== 1) throw new Error('session_meta has duplicate model_provider fields');
    found = { id: payload['id'], providerId: payload['model_provider'], line };
  }
  if (found === undefined) throw new Error('no unique session_meta.payload.id');
  return found;
}

/** Rewrite only the session provider value, preserving every other byte. */
export function rewriteLegacyProvider(bytes: Uint8Array, id: string, source: string, target: string): Uint8Array {
  if (!uuidPattern.test(id) || source.length === 0 || target.length === 0)
    throw new Error('invalid legacy session rewrite arguments');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('legacy rollout is not valid UTF-8');
  }
  const lines = text.split('\n');
  let matchingLine = -1;
  let metadata: LegacySessionMetadata | undefined;
  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line]!;
    if (raw.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error('legacy rollout contains malformed JSON');
    }
    if (!isRecord(record) || record['type'] !== 'session_meta') continue;
    const payload = record['payload'];
    if (!isRecord(payload) || typeof payload['id'] !== 'string' || typeof payload['model_provider'] !== 'string')
      throw new Error('unknown legacy session_meta structure');
    if (metadata !== undefined) throw new Error('multiple conflicting session_meta records');
    const keyMatches = raw.match(/"model_provider"\s*:/g) ?? [];
    if (keyMatches.length !== 1) throw new Error('session_meta has duplicate model_provider fields');
    metadata = { id: payload['id'], providerId: payload['model_provider'], line };
    if (payload['id'] === id) matchingLine = line;
  }
  if (metadata === undefined || matchingLine < 0) throw new Error('session id does not match rollout metadata');
  if (metadata.providerId !== source) throw new Error('session provider does not match source provider');
  if (source === target) return bytes.slice();
  const key = /("model_provider"\s*:\s*)"(?:\\.|[^"\\])*"/;
  const match = lines[matchingLine]!.match(key);
  if (match === null) throw new Error('session provider metadata is not writable');
  lines[matchingLine] = lines[matchingLine]!.replace(key, `$1${JSON.stringify(target)}`);
  return new TextEncoder().encode(lines.join('\n'));
}
