import type { AttemptResponseSnapshot } from './response-observation';

type ContentEncoding = NonNullable<AttemptResponseSnapshot['contentEncoding']>;

export function normalizeContentEncoding(value: string | null): ContentEncoding {
  const encodings = (value ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  if (encodings.length === 0) return 'identity';
  if (encodings.length > 1) return 'multiple';
  const encoding = encodings[0];
  return encoding === 'identity' ||
    encoding === 'gzip' ||
    encoding === 'deflate' ||
    encoding === 'br' ||
    encoding === 'zstd'
    ? encoding
    : 'other';
}
