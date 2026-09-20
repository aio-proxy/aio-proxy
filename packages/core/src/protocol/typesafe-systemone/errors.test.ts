import { describe, expect, it } from 'bun:test';

import {
  InvalidCompressedRequestBodyError,
  RequestBodyTooLargeError,
  UnsupportedContentEncodingError,
} from '../request';
import { EvaluationDistributionError } from './egress';
import { systemOneErrors } from './errors';
import { parseSystemOneBody, SystemOneParseError } from './parse';

const valid = { model: 'jev-latest', state: 's', questions: { q: { type: 'noul', instructions: 'i' } } };

// Provoked through the real parser rather than constructed by hand: a hand-built
// error can drift from what the parser actually throws and then assert nothing.
const parseFailure = async (): Promise<unknown> => {
  try {
    await parseSystemOneBody(
      new Request('https://proxy.test/v1/systemone', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: '', state: 's', questions: {} }),
      }),
    );
  } catch (error) {
    return error;
  }
  throw new Error('expected the parser to reject this body');
};

// A body that declares gzip and carries bytes that are not a complete gzip
// member. Taken from the real parser too, so the test tracks whichever class
// `readRequestText` actually raises for it rather than one we assumed.
const corruptEncodingFailure = async (): Promise<unknown> => {
  const truncated = Bun.gzipSync(new TextEncoder().encode(JSON.stringify(valid))).slice(0, 10);
  try {
    await parseSystemOneBody(
      new Request('https://proxy.test/v1/systemone', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: truncated,
      }),
    );
  } catch (error) {
    return error;
  }
  throw new Error('expected the parser to reject a body that is not the gzip it declared');
};

describe('systemOneErrors.requestError', () => {
  it('answers an inbound parse failure with a 400 the client can read', async () => {
    const error = await parseFailure();
    expect(error).toBeInstanceOf(SystemOneParseError);

    const response = systemOneErrors.requestError(error);
    expect(response?.status).toBe(400);
    expect(response?.headers.get('content-type')).toBe('application/json');
    expect(await response?.json()).toEqual({
      message: (error as SystemOneParseError).message,
      error_type: 'invalid_request_error',
    });
  });

  // The regression that matters: this error is thrown during egress, after a
  // successful upstream call. Declining it here is what leaves it free to be
  // mapped to 501 and fall back, instead of a 400 blaming the caller.
  it('declines an egress distribution failure so a later handler can own it', () => {
    const error = new EvaluationDistributionError('Answer c is a choice without probabilities');
    expect(systemOneErrors.requestError(error)).toBeUndefined();
  });

  // A body whose bytes do not match the encoding it declared is the caller's
  // fault, so it must be answered, not rethrown: an unmapped throw here reaches
  // the pipeline's rethrow and turns an unambiguously bad request into a 5xx.
  it('answers a malformed compressed body with a 400 rather than letting it become a 5xx', async () => {
    const error = await corruptEncodingFailure();
    expect(error).toBeInstanceOf(InvalidCompressedRequestBodyError);

    const response = systemOneErrors.requestError(error);
    expect(response?.status).toBe(400);
    expect(response?.headers.get('content-type')).toBe('application/json');
    expect(await response?.json()).toEqual({
      message: 'Invalid compressed request body',
      error_type: 'invalid_request_error',
    });
  });

  // The other two body-read rejections must keep escaping: the pipeline owns
  // them, and answering 400 here would shadow its 415 and 413.
  it('declines the encoding and size rejections the pipeline maps to 415 and 413', () => {
    const declined = [
      systemOneErrors.requestError(new UnsupportedContentEncodingError('compress')),
      systemOneErrors.requestError(new RequestBodyTooLargeError('Request body too large')),
    ];
    expect(declined).toEqual([undefined, undefined]);
  });

  it('declines an internal error and never writes its message to the caller', async () => {
    const internal = new Error('internal boom');
    const responses = [systemOneErrors.requestError(internal), systemOneErrors.provider(internal)];
    expect(responses).toEqual([undefined, undefined]);

    const bodies = await Promise.all(responses.map((response) => response?.text() ?? Promise.resolve('')));
    expect(bodies.join('')).not.toContain('internal boom');
  });
});
