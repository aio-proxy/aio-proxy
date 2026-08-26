import { z } from 'zod';

const xorMessage = 'request requires exactly one of model or agent';

const GeminiInteractionsBodySchema = z
  .object({
    model: z.string().optional(),
    agent: z.string().optional(),
    input: z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
    system_instruction: z.string().optional(),
    stream: z.boolean().optional(),
    tools: z.unknown().optional(),
    response_format: z.unknown().optional(),
    generation_config: z.unknown().optional(),
    agent_config: z.unknown().optional(),
    store: z.boolean().optional(),
    background: z.boolean().optional(),
    previous_interaction_id: z.string().optional(),
    environment: z.unknown().optional(),
    labels: z.unknown().optional(),
    safety_settings: z.unknown().optional(),
    service_tier: z.unknown().optional(),
    webhook_config: z.unknown().optional(),
  })
  .catchall(z.unknown())
  .superRefine((body, ctx) => {
    const modelPresent = body.model !== undefined;
    const agentPresent = body.agent !== undefined;
    if (modelPresent === agentPresent) {
      ctx.addIssue({ code: 'custom', message: xorMessage, path: ['model'] });
      return;
    }
    const selected = (modelPresent ? body.model : body.agent)?.trim() ?? '';
    if (selected === '') {
      ctx.addIssue({ code: 'custom', message: xorMessage, path: [modelPresent ? 'model' : 'agent'] });
    }
  });

export type GeminiInteractionsBody = z.output<typeof GeminiInteractionsBodySchema>;

export type GeminiInteractionsRequest = {
  readonly idField: 'model' | 'agent';
  readonly routingId: string;
  readonly body: GeminiInteractionsBody;
};

export type GeminiInteractionsParseResult =
  | { readonly ok: true; readonly value: GeminiInteractionsRequest }
  | { readonly ok: false; readonly error: z.ZodError };

function routingId(body: GeminiInteractionsBody): { readonly idField: 'model' | 'agent'; readonly routingId: string } {
  if (body.model !== undefined && body.model.trim() !== '') {
    const trimmed = body.model.trim();
    const stripped = trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed;
    return { idField: 'model', routingId: stripped === '' ? trimmed : stripped };
  }
  return { idField: 'agent', routingId: body.agent?.trim() ?? '' };
}

export function safeParseGeminiInteractions(input: unknown): GeminiInteractionsParseResult {
  const parsed = GeminiInteractionsBodySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error };
  const ids = routingId(parsed.data);
  return { ok: true, value: { ...ids, body: parsed.data } };
}

export function parseGeminiInteractions(input: unknown): GeminiInteractionsRequest {
  const parsed = safeParseGeminiInteractions(input);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}
