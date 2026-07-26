import { describe, expect, test } from 'bun:test';

import { credentialPort, withFetchMock } from '../../__tests__/test-support';
import { createGitHubCopilotRuntime } from './runtime';
import { catalog, forwardFetch, validCredential } from './runtime.test-support';

describe('GitHub Copilot runtime', () => {
  for (const scenario of [
    {
      name: 'Anthropic Messages',
      modelId: 'claude',
      token: 'anthropic-current-token',
      expectedUrl: 'https://api.githubcopilot.com/v1/messages',
      assertBody(body: Record<string, unknown>) {
        expect(body.model).toBe('claude');
        expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
      },
      response: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      name: 'OpenAI Responses',
      modelId: 'gpt-response',
      token: 'responses-current-token',
      expectedUrl: 'https://api.githubcopilot.com/responses',
      assertBody(body: Record<string, unknown>) {
        expect(body.model).toBe('gpt-response');
        expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
      },
      response: {
        id: 'resp_test',
        object: 'response',
        created_at: 1,
        status: 'completed',
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: 'gpt-response',
        output: [
          {
            id: 'msg_test',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok', annotations: [], logprobs: [] }],
          },
        ],
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: false,
        temperature: 1,
        text: { format: { type: 'text' }, verbosity: 'medium' },
        tool_choice: 'auto',
        tools: [],
        top_p: 1,
        truncation: 'disabled',
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
        user: null,
        metadata: {},
      },
    },
  ] as const) {
    test(`${scenario.name} doGenerate uses the current Copilot credential and protocol request shape`, async () => {
      const credentials = credentialPort(validCredential(scenario.token));
      const runtime = await createGitHubCopilotRuntime({
        credentials: credentials.port,
        options: { deploymentType: 'github.com' },
        catalog: catalog(),
        fetch: forwardFetch,
      });
      const controller = new AbortController();
      let captured: Request | undefined;
      let capturedSignal: AbortSignal | null | undefined;

      await withFetchMock(
        async (input, init) => {
          capturedSignal = init?.signal;
          captured = new Request(input, init);
          return Response.json(scenario.response);
        },
        () =>
          runtime.provider.languageModel(scenario.modelId).doGenerate({
            prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
            abortSignal: controller.signal,
          }),
      );

      expect(captured?.url).toBe(scenario.expectedUrl);
      expect(capturedSignal).toBe(controller.signal);
      expect(captured?.method).toBe('POST');
      expect(captured?.headers.get('authorization')).toBe(`Bearer ${scenario.token}`);
      expect(captured?.headers.get('x-api-key')).toBeNull();
      expect(JSON.stringify([...(captured?.headers ?? new Headers()).entries()])).not.toContain('dynamic-credential');
      scenario.assertBody((await captured?.json()) as Record<string, unknown>);
    });
  }
});
