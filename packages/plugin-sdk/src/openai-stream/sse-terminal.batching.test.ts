import { describe, expect, test } from 'bun:test';

import { createOpenAISseBody } from './sse-terminal';
import { decodedFromChunks, encoder, readBody, readBodyResult, sourceFromText } from './sse-terminal.test-support';

describe('createOpenAISseBody terminals', () => {
  test('forwards bytes only through the first terminal frame when later events share the same batch', async () => {
    const first = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const later = 'data: should-not-forward\n\n';
    const text = await readBody(
      createOpenAISseBody(
        decodedFromChunks([{ chunks: [encoder.encode(first + later)], done: false }]),
        'openai-response',
      ),
    );
    expect(text).toBe(first);
    expect(text).not.toContain('should-not-forward');
  });

  test('lets a terminal frame win over a decoder error returned with the same batch', async () => {
    const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const { text, error } = await readBodyResult(
      createOpenAISseBody(
        decodedFromChunks([
          {
            chunks: [encoder.encode(terminal)],
            done: false,
            error: new Error('same-batch decoder failure'),
          },
        ]),
        'openai-response',
      ),
    );
    expect(text).toBe(terminal);
    expect(error).toBeUndefined();
  });

  test('rejects Responses clean EOF and an incomplete terminal frame at EOF', async () => {
    const clean = await readBodyResult(createOpenAISseBody(sourceFromText('data: hello\n\n'), 'openai-response'));
    expect(clean.error).toBeInstanceOf(Error);
    expect(String(clean.error)).toMatch(/ended before a terminal event/i);

    const incomplete = await readBodyResult(
      createOpenAISseBody(sourceFromText('event: response.completed\ndata: {'), 'openai-response'),
    );
    expect(incomplete.error).toBeInstanceOf(Error);
    expect(String(incomplete.error)).toMatch(/ended before a terminal event/i);
  });

  test('allows OpenAI-compatible clean EOF without [DONE], forwards an unterminated final frame unchanged, but does not hide an error before [DONE]', async () => {
    const clean = await readBodyResult(createOpenAISseBody(sourceFromText('data: hello\n\n'), 'openai-compatible'));
    expect(clean.error).toBeUndefined();
    expect(clean.text).toBe('data: hello\n\n');

    const unterminated = 'data: trailing-without-delimiter';
    const trailing = await readBodyResult(createOpenAISseBody(sourceFromText(unterminated), 'openai-compatible'));
    expect(trailing.error).toBeUndefined();
    expect(trailing.text).toBe(unterminated);

    const beforeDone = await readBodyResult(
      createOpenAISseBody(
        decodedFromChunks([
          {
            chunks: [encoder.encode('data: partial\n\n')],
            done: false,
            error: new Error('decoder failed before DONE'),
          },
        ]),
        'openai-compatible',
      ),
    );
    expect(beforeDone.text).toBe('data: partial\n\n');
    expect(beforeDone.error).toBeInstanceOf(Error);
    expect(String(beforeDone.error)).toMatch(/decoder failed before DONE/);
  });
});
