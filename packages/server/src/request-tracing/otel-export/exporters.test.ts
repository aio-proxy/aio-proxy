import { expect, test } from 'bun:test';

// A fresh process is necessary: the diagnostic bridge deliberately installs only once.
test('automatic batches and malformed success responses protect existing diagnostics', async () => {
  const script = `
    import assert from 'node:assert/strict';
    import { inspect } from 'node:util';
    import { diag, DiagLogLevel } from ${JSON.stringify(import.meta.resolve('@opentelemetry/api'))};
    import { NodeTracerProvider } from ${JSON.stringify(import.meta.resolve('@opentelemetry/sdk-trace-node'))};
    import { createOtelExportDelegator } from ${JSON.stringify(import.meta.resolve('./delegator'))};
    import { createDestinationProcessor } from ${JSON.stringify(import.meta.resolve('./exporters'))};
    const diagnostics = [];
    const logs = [];
    diag.setLogger({
      error: (...args) => diagnostics.push(args),
      warn: (...args) => diagnostics.push(args),
      info() {}, debug() {}, verbose() {},
    }, { logLevel: DiagLogLevel.WARN });
    let status = 400;
    let requests = 0;
    const secret = 'sentinel-collector-response-secret';
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        await request.arrayBuffer();
        requests++;
        return new Response(secret, { status });
      },
    });
    const delegator = createOtelExportDelegator({ logger: (log) => logs.push(log), createProcessor: createDestinationProcessor });
    const provider = new NodeTracerProvider({ spanProcessors: [delegator] });
    const tracer = provider.getTracer('@aio-proxy/server');
    const destination = {
      url: 'http://127.0.0.1:' + server.port + '/secret-path?secret-query=1',
      contentType: 'json', headers: { Authorization: 'secret-header' },
    };
    try {
      delegator.sync([destination]);
      for (let index = 0; index < 512; index++) tracer.startSpan('automatic-batch').end();
      const deadline = Date.now() + 4000;
      while (!diagnostics.some((args) => inspect(args).includes('OTLP trace export failed')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(requests, 1);
      assert.ok(diagnostics.some((args) => inspect(args).includes('OTLP trace export failed')));
      assert.deepEqual(logs, [{ event: 'otel.export', category: 'export_failed', index: 0,
        origin: 'http://127.0.0.1:' + server.port, statusCode: 400 }]);
      status = 200;
      for (const contentType of ['json', 'protobuf']) {
        delegator.sync([{ ...destination, contentType }]);
        tracer.startSpan('malformed-success').end();
        await delegator.forceFlush();
      }
      assert.equal(requests, 3);
      assert.equal(diagnostics.filter((args) => args[0] === 'Failed to parse trace export response').length, 2);
      diag.warn('unrelated-warning', { detail: 'preserved' });
      diag.error('unrelated-error', { detail: 'preserved' });
      assert.deepEqual(diagnostics.slice(-2), [
        ['unrelated-warning', { detail: 'preserved' }],
        ['unrelated-error', { detail: 'preserved' }],
      ]);
      const output = inspect([diagnostics, logs], { depth: 20 });
      for (const value of [secret, 'secret-path', 'secret-query', 'secret-header']) assert.ok(!output.includes(value), output);
    } finally {
      await provider.shutdown();
      server.stop(true);
    }
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
}, 10_000);
