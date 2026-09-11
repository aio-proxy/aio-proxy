#!/usr/bin/env bun
export {};
const mode = Bun.argv.find((value) => value.startsWith('--mode='))?.slice('--mode='.length) ?? 'ok';
const values = new Map<string, { valueBase64: string; version: string }>();
let withheldReadId: string | undefined;
let withholdNextRead = mode === 'late-cancel-reply';

function emit(value: unknown): void {
  Bun.stdout.write(`${JSON.stringify(value)}\n`);
}

const input = Bun.stdin.stream();
let buffered = '';
for await (const chunk of input) {
  buffered += new TextDecoder().decode(chunk);
  const lines = buffered.split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines) {
    let request: { id: string; op: string; input: Record<string, unknown> };
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    if (request.op === 'dispose') {
      emit({ id: request.id, ok: true, result: null });
      process.exit(0);
    }
    if (request.op === 'cancel') {
      // The real bridge cancels the task but its in-flight CloudKit callback still answers the
      // original id, so the parent sees a reply for a request it already gave up on.
      if (mode === 'late-cancel-reply' && withheldReadId !== undefined) {
        emit({ id: withheldReadId, ok: true, result: { kind: 'absent' } });
        withheldReadId = undefined;
      }
      continue;
    }
    if (request.op === 'connect') {
      emit({
        id: request.id,
        ok: true,
        result: { identityId: 'fake', spaceId: 'default', maxValueBytes: 1024, protocol: 1, version: 'fake' },
      });
      if (mode === 'identity-change') emit({ event: 'identity-changed' });
      if (mode === 'duplicate')
        emit({
          id: request.id,
          ok: true,
          result: { identityId: 'fake', spaceId: 'default', maxValueBytes: 1024, protocol: 1, version: 'fake' },
        });
      if (mode === 'unexpected') emit({ id: 'unexpected', ok: true, result: null });
      // Exiting straight after a write can drop it, and the point of both modes is that the
      // bytes reach the parent before the process dies.
      if (mode === 'oversized') {
        await Bun.stdout.write(`${'x'.repeat(16 * 1024 * 1024 + 1)}\n`);
        process.exit(0);
      }
      if (mode === 'partial-frame') {
        await Bun.stdout.write('{"id":"partial"');
        process.exit(0);
      }
      continue;
    }
    if (request.op === 'cas') {
      const key = String(request.input.key);
      values.set(key, { valueBase64: String(request.input.valueBase64), version: 'v1' });
      if (mode === 'exit-after-write') process.exit(0);
      if (mode === 'malformed') {
        Bun.stdout.write('not-json\n');
        continue;
      }
      emit({ id: request.id, ok: true, result: { kind: 'written', version: 'v1', modifiedAt: 1 } });
      continue;
    }
    if (request.op === 'read') {
      if (withholdNextRead) {
        withholdNextRead = false;
        withheldReadId = request.id;
        continue;
      }
      const stored = values.get(String(request.input.key));
      emit({
        id: request.id,
        ok: true,
        result: stored ? { kind: 'present', ...stored, modifiedAt: 1 } : { kind: 'absent' },
      });
      continue;
    }
    if (request.op === 'list') {
      emit({ id: request.id, ok: true, result: { keys: [...values.keys()] } });
      continue;
    }
    if (request.op === 'remove') {
      emit({
        id: request.id,
        ok: true,
        result: { kind: values.delete(String(request.input.key)) ? 'removed' : 'conflict' },
      });
    }
  }
  if (mode === 'hold') continue;
}
