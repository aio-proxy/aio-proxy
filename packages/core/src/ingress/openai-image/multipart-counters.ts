import { RequestBodyTooLargeError } from '../../protocol/request';

export const EDITS_MULTIPART_ENCODED_LIMIT = 851_048_559;
export const EDITS_MULTIPART_PER_FILE_LIMIT = 50_000_000;
export const EDITS_MULTIPART_AGGREGATE_LIMIT = 849_999_983;
export const EDITS_MULTIPART_NON_FILE_LIMIT = 1_048_576;
export const EDITS_MULTIPART_MAX_IMAGES = 16;
export const EDITS_MULTIPART_MAX_MASKS = 1;

export function assertEditsMultipartCounters(input: {
  readonly imageCount?: number;
  readonly maskCount?: number;
  readonly fileByteLength?: number;
  readonly aggregateDecoded?: number;
  readonly nonFileFormBytes?: number;
}): void {
  if ((input.imageCount ?? 0) > EDITS_MULTIPART_MAX_IMAGES) throw tooLarge();
  if ((input.maskCount ?? 0) > EDITS_MULTIPART_MAX_MASKS) throw tooLarge();
  if ((input.fileByteLength ?? 0) >= EDITS_MULTIPART_PER_FILE_LIMIT) throw tooLarge();
  if ((input.aggregateDecoded ?? 0) > EDITS_MULTIPART_AGGREGATE_LIMIT) throw tooLarge();
  if ((input.nonFileFormBytes ?? 0) > EDITS_MULTIPART_NON_FILE_LIMIT) throw tooLarge();
}

export function tooLarge(): RequestBodyTooLargeError {
  return new RequestBodyTooLargeError('Request body too large');
}
