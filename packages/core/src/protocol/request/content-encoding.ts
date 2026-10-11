import { UnsupportedContentEncodingError } from './errors';

export type ContentEncoding = 'br' | 'deflate' | 'gzip' | 'x-gzip' | 'zstd';

export function requestContentEncoding(header: string | null): ContentEncoding | undefined {
  const encodings = (header ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== '' && encoding !== 'identity');
  const [first] = encodings;
  if (first === undefined) return undefined;
  const encoding = encodings.join(', ');
  if (encodings.length > 1 || !isContentEncoding(first)) {
    console.warn('request.content_encoding.unsupported', { encoding: 'unsupported' });
    throw new UnsupportedContentEncodingError(encoding);
  }
  return first;
}

function isContentEncoding(value: string): value is ContentEncoding {
  return value === 'br' || value === 'deflate' || value === 'gzip' || value === 'x-gzip' || value === 'zstd';
}
