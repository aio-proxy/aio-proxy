#!/usr/bin/env bun
export {};
const mode = Bun.argv.find((value) => value.startsWith('--mode='))?.slice('--mode='.length) ?? 'ok';
const values = new Map<string, { valueBase64: string; version: string }>();

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
    if (request.op === 'cancel') continue;
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
      if (mode === 'oversized') {
        Bun.stdout.write(`${'x'.repeat(16 * 1024 * 1024 + 1)}\n`);
        process.exit(0);
      }
      if (mode === 'partial-frame') {
        Bun.stdout.write('{"id":"partial"');
        process.exit(0);
      }
      continue;
    }
    if (request.op === 'cas') {
      const key = String(request.input.key);
      values.set(key, { valueBase64: String(request.input.valueBase64), version: 'v1' });
      if (mode === 'exit-after-write') process.exit(0);
      emit({ id: request.id, ok: true, result: { kind: 'written', version: 'v1', modifiedAt: 1 } });
      continue;
    }
    if (request.op === 'read') {
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
