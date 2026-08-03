import { describe, expect, test } from 'bun:test';

import { createProxyFetch } from './proxy-fetch';

describe('createProxyFetch', () => {
  test('forwards the proxy option to the wrapped fetch call', async () => {
    const calls: unknown[][] = [];
    const spy = (async (...args: unknown[]) => {
      calls.push(args);
      return new Response();
    }) as typeof globalThis.fetch;

    const proxyFetch = createProxyFetch('http://proxy.example:8080', spy);
    await proxyFetch('https://upstream.example/v1', { method: 'POST' });

    expect(calls).toEqual([['https://upstream.example/v1', { method: 'POST', proxy: 'http://proxy.example:8080' }]]);
  });

  test('returns the fetch implementation unchanged when no proxy is configured', () => {
    const spy = (async () => new Response()) as typeof globalThis.fetch;

    expect(createProxyFetch(undefined, spy)).toBe(spy);
  });

  test('defaults to globalThis.fetch when no fetch implementation is injected', () => {
    expect(createProxyFetch(undefined)).toBe(globalThis.fetch);
  });

  test('materializes a ReadableStream request body to bytes when a proxy is set', async () => {
    const calls: Array<{ input: unknown; init: (RequestInit & { proxy?: string }) | undefined }> = [];
    const spy = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response();
    }) as typeof globalThis.fetch;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"hello":'));
        controller.enqueue(new TextEncoder().encode('"world"}'));
        controller.close();
      },
    });

    const proxyFetch = createProxyFetch('http://proxy.example:8080', spy);
    await proxyFetch('https://upstream.example/v1', { method: 'POST', body });

    const forwarded = calls[0]?.init;
    expect(forwarded?.proxy).toBe('http://proxy.example:8080');
    expect(forwarded?.body instanceof ReadableStream).toBe(false);
    const sent = await new Response(forwarded?.body as BodyInit).text();
    expect(sent).toBe('{"hello":"world"}');
  });

  test('buffers a ReadableStream body carried on a Request input when a proxy is set', async () => {
    const calls: Array<{ input: unknown; init: (RequestInit & { proxy?: string }) | undefined }> = [];
    const spy = (async (input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response();
    }) as typeof globalThis.fetch;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"hello":'));
        controller.enqueue(new TextEncoder().encode('"world"}'));
        controller.close();
      },
    });
    const request = new Request('https://upstream.example/v1', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    const proxyFetch = createProxyFetch('http://proxy.example:8080', spy);
    await proxyFetch(request, { headers: new Headers({ 'x-test': '1' }) });

    const forwarded = calls[0]?.init;
    expect(forwarded?.proxy).toBe('http://proxy.example:8080');
    expect(forwarded?.method).toBe('POST');
    expect(forwarded?.body instanceof ReadableStream).toBe(false);
    const sent = await new Response(forwarded?.body as BodyInit).text();
    expect(sent).toBe('{"hello":"world"}');
    const headers = forwarded?.headers as Headers;
    expect(headers.get('x-test')).toBe('1');
  });

  test('forwards a non-stream body unchanged when a proxy is set', async () => {
    const calls: Array<(RequestInit & { proxy?: string }) | undefined> = [];
    const spy = (async (_input: unknown, init?: RequestInit) => {
      calls.push(init);
      return new Response();
    }) as typeof globalThis.fetch;

    const proxyFetch = createProxyFetch('http://proxy.example:8080', spy);
    await proxyFetch('https://upstream.example/v1', { method: 'POST', body: '{"a":1}' });

    expect(calls[0]?.body).toBe('{"a":1}');
    expect(calls[0]?.proxy).toBe('http://proxy.example:8080');
  });
});
