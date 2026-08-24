const DROPPED_FIELDS = [
  'previous_response_id',
  'prompt_cache_retention',
  'safety_identifier',
  'stream_options',
  'stop',
] as const;

const SAFE_PARAMETERS = { type: 'object', properties: {}, additionalProperties: true } as const;

export function sanitizeXAIGrokResponsesBody(bytes: Uint8Array): Uint8Array {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const body = asRecord(value);
    if (body === undefined) return bytes;
    for (const field of DROPPED_FIELDS) Reflect.deleteProperty(body, field);
    const reasoning = asRecord(body['reasoning']);
    if (reasoning !== undefined) Reflect.deleteProperty(reasoning, 'summary');
    sanitizeTools(body['tools']);
    return new TextEncoder().encode(JSON.stringify(body));
  } catch {
    return bytes;
  }
}

function sanitizeTools(tools: unknown, namespace?: string): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    const record = asRecord(tool);
    if (record === undefined) continue;
    if (record['type'] === 'namespace' && record['name'] === 'codex_app') sanitizeTools(record['tools'], 'codex_app');
    if (isAutomationUpdate(record, namespace)) {
      record['parameters'] = { ...SAFE_PARAMETERS };
      if (record['strict'] === true) record['strict'] = false;
    }
  }
}

function isAutomationUpdate(tool: Record<string, unknown>, namespace?: string): boolean {
  return (
    tool['type'] === 'function' &&
    (tool['name'] === 'codex_app__automation_update' ||
      (tool['name'] === 'automation_update' && namespace === 'codex_app'))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
