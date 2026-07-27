import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, ENDED_AT, rootSpan, rootStart, TRACE_ID } from '../trace-store.test-support';

test('persists nested spans when a child finishes before its parent', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    const parent = attemptSpan({ spanId: 'c'.repeat(16), name: 'parent' });
    const child = attemptSpan({ spanId: 'd'.repeat(16), parentSpanId: parent.spanId, name: 'child' });
    store.startRoot(rootStart());

    expect(store.complete(completion({ spans: [rootSpan(), child, parent] }))).toBe(true);

    const detail = store.find(TRACE_ID);
    expect(detail?.trace.endedAt).toBe(ENDED_AT.toISOString());
    expect(detail?.spans.map(({ spanId, parentSpanId }) => ({ spanId, parentSpanId }))).toEqual(
      expect.arrayContaining([
        { spanId: parent.spanId, parentSpanId: parent.parentSpanId },
        { spanId: child.spanId, parentSpanId: child.parentSpanId },
      ]),
    );
  } finally {
    handle.close();
  }
});
