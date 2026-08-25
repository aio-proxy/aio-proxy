import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';

import { ProviderProtocol } from '@aio-proxy/types';

import { parseGeminiInteractions } from '../../ingress/gemini-interactions/index';
import { geminiInteractionsAdapter } from './gemini-interactions';

function request(body: unknown, init?: RequestInit): Request {
  return new Request('https://x/v1beta/interactions?alt=sse', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init?.headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
    ...init,
  });
}

describe('geminiInteractionsAdapter', () => {
  test('protocol and routing id', async () => {
    expect(geminiInteractionsAdapter.protocol).toBe(ProviderProtocol.GeminiInteractions);
    const parsed = await geminiInteractionsAdapter.parse(
      request({ model: 'models/gemini-3.5-flash', input: 'hi' }),
      {},
    );
    expect(geminiInteractionsAdapter.model(parsed, {})).toBe('gemini-3.5-flash');
    expect(geminiInteractionsAdapter.wantsStream(parsed, {})).toBe(false);
  });

  test('wantsStream reads the body', async () => {
    const parsed = await geminiInteractionsAdapter.parse(request({ model: 'm', input: 'hi', stream: true }), {});
    expect(geminiInteractionsAdapter.wantsStream(parsed, {})).toBe(true);
  });

  test('preserves decoded body text when the XOR id already matches', async () => {
    const body = '{"model":"gemini-3.5-flash","input":"hi","store":false}';
    const forwarded = await geminiInteractionsAdapter.rawRequest(
      request(body),
      parseGeminiInteractions(JSON.parse(body)),
      'gemini-3.5-flash',
      new Set(),
      {},
    );
    expect(await forwarded.text()).toBe(body);
    expect(new URL(forwarded.url).pathname).toBe('/v1beta/interactions');
    expect(new URL(forwarded.url).search).toBe('?alt=sse');
  });

  test('rewrites models/ prefix to the resolved bare id', async () => {
    const parsed = parseGeminiInteractions({ model: 'models/gemini-3.5-flash', input: 'hi' });
    const forwarded = await geminiInteractionsAdapter.rawRequest(
      request({ model: 'models/gemini-3.5-flash', input: 'hi' }),
      parsed,
      'gemini-3.5-flash',
      new Set(),
      {},
    );
    const json = await forwarded.json();
    expect(json).toMatchObject({ model: 'gemini-3.5-flash' });
    expect(json).not.toHaveProperty('agent');
  });

  test('dimensions matches convert without throwing for agent passthrough', () => {
    const convertible = parseGeminiInteractions({
      model: 'm',
      input: 'hi',
      store: false,
      generation_config: { thinking_level: 'low' },
    });
    expect(geminiInteractionsAdapter.dimensions(convertible, {})).toEqual({ thinking: true, effort: 'low' });

    const high = parseGeminiInteractions({
      model: 'm',
      input: 'hi',
      store: false,
      generation_config: { thinking_level: 'HIGH' },
    });
    expect(geminiInteractionsAdapter.dimensions(high, {})).toEqual({ thinking: true, effort: 'high' });

    const agent = parseGeminiInteractions({ agent: 'deep-research-preview-04-2026', input: 'hi' });
    expect(geminiInteractionsAdapter.dimensions(agent, {})).toEqual({});
  });

  test('rewrites agent alias and never writes model', async () => {
    const parsed = parseGeminiInteractions({ agent: 'deep-research-preview-04-2026', input: 'hi' });
    const forwarded = await geminiInteractionsAdapter.rawRequest(
      request({ agent: 'deep-research-preview-04-2026', input: 'hi' }),
      parsed,
      'resolved-agent',
      new Set(),
      {},
    );
    const json = await forwarded.json();
    expect(json).toMatchObject({ agent: 'resolved-agent' });
    expect(json).not.toHaveProperty('model');
  });

  test('forwards gzip decoded text and drops content-encoding', async () => {
    const body = '{"model":"gemini-3.5-flash","input":"hi"}';
    const forwarded = await geminiInteractionsAdapter.rawRequest(
      request(gzipSync(Buffer.from(body)), {
        headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      }),
      parseGeminiInteractions(JSON.parse(body)),
      'gemini-3.5-flash',
      new Set(),
      {},
    );
    expect(await forwarded.text()).toBe(body);
    expect(forwarded.headers.get('content-encoding')).toBeNull();
    expect(forwarded.headers.get('content-length')).toBeNull();
  });
});
