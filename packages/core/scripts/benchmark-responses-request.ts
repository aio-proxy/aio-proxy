import { createReadStream, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import { openAIResponsesAdapter } from '../src/protocol/openai-responses';

// Run each sample in a fresh process so resourceUsage().maxRSS is comparable.
// Generate with --write-fixture PATH [compact], then run PATH [rewrite|noop|compact].
const [fixturePath, mode = 'rewrite'] = process.argv.slice(2);

if (fixturePath === '--write-fixture') {
  const destination = process.argv[3];
  if (destination === undefined) throw new Error('Expected a fixture path');
  const input: unknown[] = [{ role: 'user', content: 'Describe these synthetic screenshots.' }];
  for (let index = 0; index < 100; index += 1) {
    const callId = `call_${index}`;
    input.push({ type: 'custom_tool_call', call_id: callId, name: 'screenshot', input: '{}' });
    input.push({
      type: 'custom_tool_call_output',
      call_id: callId,
      output:
        index < 29
          ? [
              { type: 'input_text', text: `Synthetic screenshot ${index}` },
              {
                type: 'input_image',
                image_url: `data:image/png;base64,${String.fromCharCode(65 + (index % 26)).repeat(1_637_240)}`,
              },
            ]
          : 'Synthetic tool result.',
    });
  }
  writeFileSync(
    destination,
    JSON.stringify({ model: 'benchmark-model', input, stream: process.argv[4] !== 'compact' }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ fixture: destination, images: 29 }));
} else {
  if (fixturePath === undefined || !['rewrite', 'noop', 'compact'].includes(mode)) {
    throw new Error('Usage: benchmark-responses-request.ts PATH [rewrite|noop|compact]');
  }
  const context = mode === 'compact' ? ({ operation: 'compact' } as const) : {};
  const raw = new Request('http://benchmark.test/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Match an HTTP upload's streamed chunks rather than preloading a string.
    // node:stream and Bun declare separate types for the same Web Stream.
    body: Readable.toWeb(
      createReadStream(fixturePath, { highWaterMark: 65_536 }),
    ) as unknown as ReadableStream<Uint8Array>,
  });
  const startedAt = performance.now();
  const parsed = await openAIResponsesAdapter.parse(raw, context);
  const parsedAt = performance.now();
  const forwarded = await openAIResponsesAdapter.rawRequest(
    raw,
    parsed,
    mode === 'noop' ? 'benchmark-model' : 'benchmark-upstream',
    new Set(),
    context,
  );
  const rewrittenAt = performance.now();
  // The server retains an unread branch for a possible provider retry.
  const retrySource = forwarded.clone();
  let forwardedBytes = 0;
  const reader = forwarded.body?.getReader();
  if (reader !== undefined) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      forwardedBytes += chunk.value.byteLength;
    }
    reader.releaseLock();
  }
  await retrySource.body?.cancel();
  await raw.body?.cancel();
  const usage = process.resourceUsage();
  console.log(
    JSON.stringify({
      mode,
      bun: Bun.version,
      platform: process.platform,
      parseMs: parsedAt - startedAt,
      rewriteMs: rewrittenAt - parsedAt,
      totalMs: performance.now() - startedAt,
      maxRssKiB: usage.maxRSS,
      cpuMs: (usage.userCPUTime + usage.systemCPUTime) / 1000,
      forwardedBytes,
    }),
  );
}
