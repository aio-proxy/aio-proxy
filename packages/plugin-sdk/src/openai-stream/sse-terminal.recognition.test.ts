import { describe, expect, test } from 'bun:test';

import { createContentDecodedReader } from './content-decoding';
import { createOpenAISseBody } from './sse-terminal';
import { encoder, readBody, readBodyResult, sourceFromText } from './sse-terminal.test-support';

describe('createOpenAISseBody terminals', () => {
  test('normalizes a top-level Responses error after response.created into response.failed', async () => {
    const created =
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress"}}\n\n';
    const inProgress = 'event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n';
    const failed =
      'event: error\ndata: {"type":"error","code":"context_too_large","message":"Your input exceeds the context window of this model.","param":null,"sequence_number":0}\n\n';

    const text = await readBody(createOpenAISseBody(sourceFromText(created + inProgress + failed), 'openai-response'));
    const frames = text.trim().split('\n\n');
    const lines = frames.at(-1)!.split('\n');
    expect(lines[0]).toBe('event: response.failed');
    const payload = JSON.parse(lines[1]!.slice('data: '.length));
    expect(payload).toEqual({
      type: 'response.failed',
      sequence_number: 0,
      response: {
        id: 'resp_1',
        object: 'response',
        status: 'failed',
        error: {
          type: 'error',
          code: 'context_too_large',
          message: 'Your input exceeds the context window of this model.',
          param: null,
        },
      },
    });
  });

  test('recognizes every OpenAI Responses terminal type from event name or data.type', async () => {
    const terminals = [
      'response.completed',
      'response.incomplete',
      'response.failed',
      'response.cancelled',
      'response.done',
      'error',
    ] as const;

    for (const type of terminals) {
      const byEvent = `event: ${type}\ndata: {"ok":true}\n\n`;
      const byDataType = `data: ${JSON.stringify({ type })}\n\n`;
      for (const frame of [byEvent, byDataType]) {
        const text = await readBody(createOpenAISseBody(sourceFromText(frame), 'openai-response'));
        expect(text).toBe(frame);
      }
    }
  });

  test('recognizes only exact [DONE] as the OpenAI-compatible terminal', async () => {
    const done = 'data: [DONE]\n\n';
    expect(await readBody(createOpenAISseBody(sourceFromText(done), 'openai-compatible'))).toBe(done);

    const nearMisses = ['data: [DONE] \n\n', 'data: done\n\n', 'data: [done]\n\n', 'data:DONE\n\n'];
    for (const frame of nearMisses) {
      const { text, error } = await readBodyResult(createOpenAISseBody(sourceFromText(frame), 'openai-compatible'));
      expect(error).toBeUndefined();
      expect(text).toBe(frame);
    }
  });

  test('preserves LF, CRLF, bare CR, mixed line endings, split delimiters, and split UTF-8 bytes', async () => {
    const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const cases = [
      'data: one\n\nevent: response.completed\ndata: {}\n\n',
      'data: one\r\n\r\nevent: response.completed\r\ndata: {}\r\n\r\n',
      'data: one\r\revent: response.completed\rdata: {}\r\r',
      'data: one\r\n\nevent: response.completed\ndata: {}\n\n',
    ];

    for (const payload of cases) {
      expect(await readBody(createOpenAISseBody(sourceFromText(payload), 'openai-response'))).toBe(payload);
    }

    const mid = Math.floor(terminal.length / 2);
    const splitText = await readBody(
      createOpenAISseBody(sourceFromText(terminal.slice(0, mid), terminal.slice(mid)), 'openai-response'),
    );
    expect(splitText).toBe(terminal);

    const snowman = 'data: ☃\n\nevent: response.completed\ndata: {}\n\n';
    const snowmanBytes = encoder.encode(snowman);
    // Split inside the 3-byte UTF-8 snowman (U+2603).
    const snowmanOffset = snowmanBytes.indexOf(0xe2) + 1;
    const decoded = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(snowmanBytes.subarray(0, snowmanOffset));
          controller.enqueue(snowmanBytes.subarray(snowmanOffset));
          controller.close();
        },
      }),
      null,
    );
    expect(await readBody(createOpenAISseBody(decoded, 'openai-response'))).toBe(snowman);
  });
});
