import type { EvaluationAnswer, EvaluationEgressContext, EvaluationResult } from '../adapter';

export class EvaluationDistributionError extends Error {}

const answerJson = (id: string, answer: EvaluationAnswer): Record<string, unknown> => {
  if (answer.type === 'noul') return { type: 'noul', noul: answer.noul };
  if (answer.probabilities === undefined) {
    throw new EvaluationDistributionError(
      `Answer ${id} is a ${answer.type} without probabilities, which System One requires`,
    );
  }
  const scalar = answer.type === 'choice' ? { choice: answer.choice } : { score: answer.score };
  return {
    type: answer.type,
    ...scalar,
    probabilities: answer.probabilities,
    // `confidence` is optional upstream: omit the key rather than emit `undefined`.
    ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
  };
};

export function systemOneJson(result: EvaluationResult, context: EvaluationEgressContext): unknown {
  const answers = Object.fromEntries(
    Object.entries(result.answers).map(([id, answer]) => [id, answerJson(id, answer)]),
  );
  const { inputTokens, outputTokens } = result.usage ?? {};
  const usage =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : {
          ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
          ...(outputTokens === undefined ? {} : { output_tokens: outputTokens }),
        };
  return { model: context.responseModelId, answers, ...(usage === undefined ? {} : { usage }) };
}
