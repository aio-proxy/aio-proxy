import { describe, expect, test } from 'bun:test';

import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import type { GoogleAntigravityCredential } from '../schema';
import { createCcaEnvelope, wireSessionId } from './envelope';

describe('CCA envelope identity', () => {
  test('derives a stable negative decimal wire session id', () => {
    const input = {
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      context: logicalContext('00000000-0000-4000-8000-000000000001', 'sha256:abc'),
      credential: credentialFixture(),
      modelId: 'gemini-3-flash-agent',
      requestType: 'agent' as const,
    };

    const envelope = createCcaEnvelope(input);
    expect(envelope.request.sessionId).toMatch(/^-[1-9][0-9]*$/u);
    expect(createCcaEnvelope(input).request.sessionId).toBe(envelope.request.sessionId);
    expect(wireSessionId('sha256:def')).not.toBe(envelope.request.sessionId);
  });

  test('builds a native hub request id and session labels', () => {
    const envelope = createCcaEnvelope({
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: { parts: [{ text: 'sys' }] } },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'gemini-3-flash-agent',
      requestType: 'agent',
      sessionState: {
        agentId: 'agent-1',
        trajectoryId: 'traj-1',
        stepIndex: 2,
        lastExecutionId: 'exec-9',
      },
      ...knownWireLookups(),
    });

    expect(envelope.requestId).toMatch(/^agent\/agent-1\/\d+\/traj-1\/2$/u);
    expect(envelope.request.sessionId).toBe(wireSessionId('sha256:abc'));
    expect(envelope.request.systemInstruction).toEqual({ role: 'user', parts: [{ text: 'sys' }] });
    expect(envelope.request.labels).toMatchObject({
      model_enum: 'MODEL_PLACEHOLDER_M132',
      last_step_index: '1',
      trajectory_id: 'traj-1',
      last_execution_id: 'exec-9',
      used_claude: 'false',
      used_claude_conservative: 'false',
    });
  });

  test('defaults omitted sessionState stepIndex to 2 without last_execution_id', () => {
    const envelope = createCcaEnvelope({
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'gemini-3-flash-agent',
      requestType: 'agent',
      ...knownWireLookups(),
    });
    expect(envelope.requestId).toMatch(/^agent\/[^/]+\/\d+\/[^/]+\/2$/u);
    expect(envelope.request.labels).toMatchObject({ last_step_index: '1' });
    expect(envelope.request.labels).not.toHaveProperty('last_execution_id');
  });

  test('defaults Gemini tools to VALIDATED without clobbering explicit AUTO', () => {
    const withTools = createCcaEnvelope({
      body: {
        tools: [{ functionDeclarations: [{ name: 'weather', parameters: { type: 'object', properties: {} } }] }],
      },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'gemini-3-flash-agent',
      requestType: 'agent',
      ...knownWireLookups(),
    });
    expect(withTools.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } });

    const explicit = createCcaEnvelope({
      body: {
        tools: [{ functionDeclarations: [{ name: 'weather', parameters: { type: 'object', properties: {} } }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'gemini-3-flash-agent',
      requestType: 'agent',
      ...knownWireLookups(),
    });
    expect(explicit.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });

  test('forces VALIDATED for Claude even without tools', () => {
    const envelope = createCcaEnvelope({
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'claude-sonnet-4-6',
      requestType: 'agent',
      ...knownWireLookups(),
    });
    expect(envelope.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } });
    expect(envelope.request.labels).toMatchObject({ used_claude: 'true', used_claude_conservative: 'true' });
  });

  test('cleans Gemini-only fields, preserves inline data, and applies the wire profile', () => {
    const inlineData = { mimeType: 'image/png', data: 'image-base64-marker' };
    const body = {
      contents: [{ role: 'user', parts: [{ inlineData }] }],
      safetySettings: [{ category: 'unsafe-marker' }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.4, maxOutputTokens: 99_999 },
    };

    const envelope = createCcaEnvelope({
      body,
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'gemini-3-flash-agent',
      requestType: 'agent',
      ...knownWireLookups(),
    });

    expect(envelope).toMatchObject({
      model: 'gemini-3-flash-agent',
      project: 'project-1',
      userAgent: 'antigravity',
      requestType: 'agent',
      request: {
        contents: [{ role: 'user', parts: [{ inlineData }] }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: 0.4, maxOutputTokens: 65_536 },
        labels: { model_enum: 'MODEL_PLACEHOLDER_M132' },
      },
    });
    expect(envelope.request).not.toHaveProperty('safetySettings');
    expect(body).toHaveProperty('safetySettings');
  });

  test('never increases a lower explicit output limit', () => {
    const envelope = createCcaEnvelope({
      body: { generationConfig: { maxOutputTokens: 512 } },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'gemini-pro-agent',
      requestType: 'agent',
      ...knownWireLookups(),
    });

    expect(envelope.request.generationConfig).toEqual({ maxOutputTokens: 512 });
    expect(envelope.request.labels).toMatchObject({ model_enum: 'MODEL_PLACEHOLDER_M16' });
  });

  test('normalizes declaration domains and enables validated tools only for Claude wire models', () => {
    const body = {
      tools: [
        { functionDeclarations: [] },
        {
          functionDeclarations: [
            { name: 'weather', parametersJsonSchema: { type: 'object', properties: { days: { const: 3 } } } },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    };

    const envelope = createCcaEnvelope({
      body,
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'claude-sonnet-4-6',
      requestType: 'agent',
      ...knownWireLookups(),
    });

    expect(body.tools).toHaveLength(2);
    expect(envelope.request).toMatchObject({
      tools: [
        {
          functionDeclarations: [
            {
              name: 'weather',
              parameters: {
                type: 'object',
                properties: { days: { type: 'string', enum: ['3'] } },
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
    });
    expect(JSON.stringify(envelope.request)).not.toContain('parametersJsonSchema');
  });

  test('applies modelEnum and maxOutputTokens from a catalog-only wire', () => {
    const envelope = createCcaEnvelope({
      body: { generationConfig: { temperature: 0.2 } },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'gemini-4.0-flash-preview',
      requestType: 'agent',
      descriptorById: descriptorMap([
        {
          id: 'gemini-4.0-flash-preview',
          extra: { antigravity: { modelEnum: 'MODEL_GEMINI_4_FLASH', maxOutputTokens: 8192 } },
        },
      ]),
      familyByWireId: () => undefined,
    });

    expect(envelope.request.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 8192 });
    expect(envelope.request.labels).toMatchObject({ model_enum: 'MODEL_GEMINI_4_FLASH' });
  });

  test('does not inject maxOutputTokens when the catalog wire omits it', () => {
    const envelope = createCcaEnvelope({
      body: { generationConfig: { temperature: 0.1 } },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'claude-sonnet-4-6',
      requestType: 'agent',
      descriptorById: descriptorMap([
        {
          id: 'claude-sonnet-4-6',
          extra: { antigravity: { apiProvider: 'anthropic', modelEnum: 'MODEL_CLAUDE_ONLY' } },
        },
      ]),
      familyByWireId: () => undefined,
    });

    expect(envelope.request.generationConfig).toEqual({ temperature: 0.1 });
    expect(envelope.request.generationConfig).not.toHaveProperty('maxOutputTokens');
    expect(envelope.request.labels).toMatchObject({ model_enum: 'MODEL_CLAUDE_ONLY' });
  });

  test('sets VALIDATED tool mode for a non-picker Claude wire', () => {
    const envelope = createCcaEnvelope({
      body: {
        tools: [
          {
            functionDeclarations: [
              { name: 'weather', parametersJsonSchema: { type: 'object', properties: { days: { const: 3 } } } },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      },
      context: logicalContext(),
      credential: credentialFixture(),
      modelId: 'claude-haiku-direct',
      requestType: 'agent',
      descriptorById: descriptorMap([
        {
          id: 'claude-haiku-direct',
          extra: { antigravity: { apiProvider: 'anthropic' } },
        },
      ]),
      familyByWireId: () => undefined,
    });

    expect(envelope.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } });
  });
});

function logicalContext(
  requestId = '00000000-0000-4000-8000-000000000001',
  key: `sha256:${string}` = 'sha256:abc',
): LogicalRequestContext {
  return { requestId, session: { key, source: 'transcript' } };
}

function credentialFixture(): GoogleAntigravityCredential {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1_900_000_000_000,
    email: 'person@example.com',
    projectId: 'project-1',
  };
}

function descriptorMap(descriptors: readonly { readonly id: string; readonly extra: unknown }[]) {
  return new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
}

function knownWireLookups() {
  return {
    descriptorById: descriptorMap([
      {
        id: 'gemini-3-flash-agent',
        extra: { antigravity: { modelEnum: 'MODEL_PLACEHOLDER_M132', maxOutputTokens: 65_536 } },
      },
      {
        id: 'gemini-pro-agent',
        extra: { antigravity: { modelEnum: 'MODEL_PLACEHOLDER_M16', maxOutputTokens: 65_535 } },
      },
      {
        id: 'claude-sonnet-4-6',
        extra: { antigravity: { apiProvider: 'anthropic' } },
      },
    ]),
    familyByWireId: (modelId: string) =>
      modelId === 'claude-sonnet-4-6' ? { thinking: { mode: 'claude' as const } } : undefined,
  };
}
