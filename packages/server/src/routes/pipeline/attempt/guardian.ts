import { createGuardianEvaluate } from '../../../plugin-runtime/guardian-evaluation';
import type { RawTransport } from '../../../runtime';
import type { AnyAttemptLoopContext, CandidateSlot } from './context';

export function guardianRaw<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  raw: RawTransport,
): RawTransport {
  if (ctx.adapter.protocol !== 'openai-response' || ctx.adapter.capability !== 'language') return raw;
  const wrap = ctx.snapshot?.plugins?.registry.resolveResponses('@aio-proxy/plugin-openai-chatgpt')?.wrap;
  if (wrap === undefined) return raw;
  return {
    ...raw,
    invoke: wrap({
      original: raw.invoke,
      evaluate: createGuardianEvaluate(() => ctx.source, {
        providerId: slot.candidate.provider.id,
        plugin: slot.candidate.provider.plugin,
      }),
    }),
  };
}
