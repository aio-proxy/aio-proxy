import { openAIVideosAdapter, RequestBodyTooLargeError, UnsupportedContentEncodingError } from '@aio-proxy/core';

/** Maps a Videos pre-parse failure to a client response. Unmapped errors
 *  (spool I/O, unexpected exceptions) stay `undefined` so the caller rethrows
 *  onto the 5xx path — the same contract as `parseProtocolRequest`. */
export function videosParseErrorResponse(error: unknown): Response | undefined {
  if (error instanceof RequestBodyTooLargeError) return openAIVideosAdapter.errors.tooLarge();
  if (error instanceof UnsupportedContentEncodingError) {
    return openAIVideosAdapter.errors.unsupportedContentEncoding();
  }
  return openAIVideosAdapter.errors.requestError(error);
}
