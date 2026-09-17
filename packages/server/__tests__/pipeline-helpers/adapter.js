import { defineProtocolAdapter as defineCoreProtocolAdapter } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';
export function createProtocolContext() {
  return { modelInvocationCalls: 0, parseCalls: 0, rawRequestCalls: 0 };
}
export function defineProtocolAdapter(protocol = ProviderProtocol.OpenAICompatible, options = {}) {
  return defineCoreProtocolAdapter({
    protocol,
    async parse(raw, context) {
      context.parseCalls += 1;
      if (options.parseError !== undefined) throw options.parseError;
      const value = await raw.clone().json();
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        !('model' in value) ||
        typeof value.model !== 'string'
      ) {
        throw new SyntaxError('invalid test request');
      }
      return {
        model: value.model,
        prompt: 'prompt' in value && typeof value.prompt === 'string' ? value.prompt : 'ping',
        stream: 'stream' in value && value.stream === true,
        ...('service_tier' in value && typeof value.service_tier === 'string'
          ? { service_tier: value.service_tier }
          : {}),
        ...('speed' in value && typeof value.speed === 'string' ? { speed: value.speed } : {}),
      };
    },
    model: (request) => request.model,
    wantsStream: (request) => request.stream,
    async rawRequest(raw, request, resolvedModel, _supportedEfforts, context) {
      context.rawRequestCalls += 1;
      const headers = new Headers(raw.headers);
      headers.delete('content-length');
      return new Request(raw, {
        method: raw.method,
        body: JSON.stringify({ ...request, model: resolvedModel }),
        headers,
      });
    },
    modelInvocation(request, context) {
      context.modelInvocationCalls += 1;
      if (options.modelInvocationError !== undefined) throw options.modelInvocationError;
      return { messages: [{ role: 'user', content: request.prompt }] };
    },
    async modelJson(stream, ...args) {
      options.onModelEgress?.(args[0]);
      return { output: await streamText(stream) };
    },
    modelSse(stream, ...args) {
      options.onModelEgress?.(args[0]);
      const encoder = new TextEncoder();
      const body = stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'text-delta') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: part.text })}\n\n`));
            }
          },
        }),
      );
      return Object.assign(body, { completion: Promise.resolve() });
    },
    errors: {
      requestError: (error) =>
        error instanceof SyntaxError ? errorResponse(400, 'request_error', 'Invalid test request') : undefined,
      modelNotFound: (message) => errorResponse(404, 'model_not_found', message),
      previousResponseConflict: () => errorResponse(409, 'previous_response_conflict', 'ambiguous previous response'),
      tooLarge: () => errorResponse(413, 'too_large', 'Request body too large'),
      unsupported: (feature) => errorResponse(501, 'unsupported', feature),
      provider: (error) => (error instanceof Error ? errorResponse(502, 'provider_error', error.message) : undefined),
      rateLimited: (s) => {
        const r = errorResponse(429, 'rate_limited', 'cooling down');
        r.headers.set('retry-after', String(Math.max(1, Math.trunc(s))));
        return r;
      },
    },
  });
}
async function streamText(stream) {
  let text = '';
  for await (const part of stream) {
    if (part.type === 'text-delta') text += part.text;
  }
  return text;
}
function errorResponse(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}
