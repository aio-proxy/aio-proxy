import { describe, expect, it } from 'bun:test';

import { EvaluationDistributionError } from './egress';
import { systemOneErrors } from './errors';
import { parseSystemOneBody, SystemOneParseError } from './parse';

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

  it('declines an internal error and never writes its message to the caller', async () => {
    const internal = new Error('internal boom');
    const responses = [systemOneErrors.requestError(internal), systemOneErrors.provider(internal)];
    expect(responses).toEqual([undefined, undefined]);

    const bodies = await Promise.all(responses.map((response) => response?.text() ?? Promise.resolve('')));
    expect(bodies.join('')).not.toContain('internal boom');
  });
});
