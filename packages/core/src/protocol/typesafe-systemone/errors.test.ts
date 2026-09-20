import { describe, expect, it } from 'bun:test';

import { Experimental_EvaluationUnsupportedQuestionTypeError } from 'ai';

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

  it('declines an internal error so the parse path does not blame the caller', () => {
    expect(systemOneErrors.requestError(new Error('internal boom'))).toBeUndefined();
  });
});

describe('systemOneErrors.provider', () => {
  // The rule this enforces: "On provider failure, try the next candidate for the
  // same model." `handleAttemptError` rethrows whatever it cannot map, and a throw
  // out of the candidate loop skips both the fallback and the cooldown write. So a
  // transport failure has to come back as a response, not as undefined.
  it('maps a transport failure to a 502 the candidate loop can fall back from', async () => {
    const response = systemOneErrors.provider(new Error('socket hang up'));

    expect(response?.status).toBe(502);
    expect(response?.headers.get('content-type')).toBe('application/json');
    expect(await response?.json()).toEqual({
      message: 'Upstream evaluation provider failed',
      error_type: 'upstream_error',
    });
  });

  // An upstream 429 is one provider's verdict, so it maps here and falls back.
  // `rateLimited` is the route-level answer for "every candidate is cooling down",
  // which the pipeline decides before any attempt runs. The two must not overlap.
  it('routes an upstream rate limit through the fallback path, not the route-level 429', async () => {
    const rateLimit = Object.assign(new Error('Too Many Requests'), { statusCode: 429 });

    const response = systemOneErrors.provider(rateLimit);

    expect(response?.status).toBe(502);
    expect(response?.headers.get('retry-after')).toBeNull();
    expect(await response?.json()).toMatchObject({ error_type: 'upstream_error' });
  });

  it('reports an aborted attempt as a cancellation rather than an upstream fault', async () => {
    const response = systemOneErrors.provider(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );

    expect(response?.status).toBe(499);
    expect(await response?.json()).toEqual({ message: 'Evaluation cancelled', error_type: 'cancelled_error' });
  });

  // Mapping everything is what fixes the rethrow, so the two rejections the
  // pipeline answers as 415 and 413 have to be excluded by name or this mapper
  // silently downgrades both to 502.
  it('declines the encoding and size rejections the pipeline maps to 415 and 413', () => {
    const declined = [
      systemOneErrors.provider(new UnsupportedContentEncodingError('compress')),
      systemOneErrors.provider(new RequestBodyTooLargeError('Request body too large')),
    ];
    expect(declined).toEqual([undefined, undefined]);
  });

  // Raised by `experimental_evaluate` itself, before the model is called. Reporting
  // an upstream fault for it tells the caller a provider failed when none was
  // contacted, and hides that the requested evaluation shape is the problem.
  it('reports an unsupported question type as 501, not as an upstream failure', async () => {
    const response = systemOneErrors.provider(
      new Experimental_EvaluationUnsupportedQuestionTypeError({
        questionId: 'q',
        questionType: 'choice',
        provider: 'gateway',
        modelId: 'jev-latest',
      }),
    );

    expect(response?.status).toBe(501);
    expect(await response?.json()).toEqual({
      message: 'Unsupported: evaluation_question_type',
      error_type: 'not_supported_error',
    });
  });

  // The stance that made this mapper decline in the first place: an attempt failure
  // is an upstream fault or a bug of ours, and the caller reads neither. Mapping it
  // must not start echoing internal text back out.
  it('never writes the underlying message to the caller', async () => {
    const response = systemOneErrors.provider(new Error('postgres://user:hunter2@10.0.0.4/internal'));

    expect(await response?.text()).not.toContain('hunter2');
  });
});
