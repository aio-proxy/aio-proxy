import { MULTIPART_ENCODED_LIMIT } from '../multipart';

// Images defines the widest multipart envelope aio-proxy accepts, so its encoded
// ceiling is the process-wide spool ceiling. A protocol wanting a wider envelope
// has to raise MULTIPART_ENCODED_LIMIT, or the spool would 413 before this does.
export const EDITS_MULTIPART_ENCODED_LIMIT = MULTIPART_ENCODED_LIMIT;
export const EDITS_MULTIPART_PER_FILE_LIMIT = 50_000_000;
export const EDITS_MULTIPART_AGGREGATE_LIMIT = 849_999_983;
export const EDITS_MULTIPART_NON_FILE_LIMIT = 1_048_576;
export const EDITS_MULTIPART_MAX_IMAGES = 16;
export const EDITS_MULTIPART_MAX_MASKS = 1;
