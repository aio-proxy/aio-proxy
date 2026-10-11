import type {
  EvaluationAnswer,
  EvaluationEgressContext,
  EvaluationInvocation,
  EvaluationQuestion,
  EvaluationResult,
} from '../adapter';
import { EvaluationDistributionError } from '../typesafe-systemone/egress';
import { decisionQuestionId, type OpenAIDecisionsQuestion, type OpenAIDecisionsRequest } from './parse';

export function decisionsInvocation(request: OpenAIDecisionsRequest): EvaluationInvocation {
  return {
    state: request.input,
    questions: Object.fromEntries(
      request.questions.map((question, index) => [
        decisionQuestionId(question, index, request.questions),
        projectQuestion(question),
      ]),
    ),
  };
}
function projectQuestion(question: OpenAIDecisionsQuestion): EvaluationQuestion {
  const instructions = question.instructions;
  switch (question.type) {
    case 'predicate':
      return { type: 'noul', instructions };
    // Index keys preserve the difference between e.g. true and "true" across a string-keyed evaluation contract.
    case 'choice':
      return {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(
          question.choices.map((choice, index) => [
            String(index),
            choice.description === undefined
              ? JSON.stringify(choice.value)
              : `${JSON.stringify(choice.value)}: ${choice.description}`,
          ]),
        ),
      };
    case 'score':
      return {
        type: 'score',
        instructions,
        criteria: question.levels.map((level) =>
          level.description === undefined ? level.label : `${level.label}: ${level.description}`,
        ),
      };
  }
}
const fail = (message: string): never => {
  throw new EvaluationDistributionError(message);
};
function probability(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : fail('Evaluation did not return a valid probability');
}
function answerJson(question: OpenAIDecisionsQuestion, answer: EvaluationAnswer | undefined): unknown {
  if (answer === undefined) return fail('Evaluation did not answer every question');
  const name = { name: question.name ?? null };
  if (answer.type === 'refusal') return { type: 'refusal', ...name };
  if (question.type === 'predicate') {
    if (answer.type !== 'noul') return fail('Evaluation answer has the wrong type');
    return { type: 'predicate', ...name, probability: probability(answer.noul) };
  }
  if (question.type !== answer.type) return fail('Evaluation answer has the wrong type');
  const confidence = probability(answer.confidence);
  const probabilities = answer.probabilities;
  if (probabilities === undefined) return fail('Evaluation did not return a probability distribution');
  if (question.type === 'choice' && answer.type === 'choice') {
    const selected = question.choices.find((_choice, index) => String(index) === answer.choice);
    if (selected === undefined) return fail('Evaluation selected an unknown choice');
    return {
      type: 'choice',
      ...name,
      choice: selected.value,
      probabilities: question.choices.map((choice, index) => ({
        value: choice.value,
        probability: probability(probabilities[String(index)]),
      })),
      confidence,
    };
  }
  if (question.type !== 'score' || answer.type !== 'score') return fail('Evaluation answer has the wrong type');
  if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.levels.length - 1)
    return fail('Evaluation returned an invalid score');
  return {
    type: 'score',
    ...name,
    score: answer.score,
    probabilities: question.levels.map((level, index) => ({
      value: index,
      label: level.label,
      probability: probability(probabilities[String(index)]),
    })),
    confidence,
  };
}
// The Decisions response schema requires usage and both detail objects. Unreported
// counts are zero on the wire; accounting still omits a count it never received.
function wireCount(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function decisionsUsage(usage: EvaluationResult['usage']) {
  const inputTokens = wireCount(usage?.inputTokens);
  const outputTokens = wireCount(usage?.outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: wireCount(usage?.cacheReadTokens),
      cache_write_tokens: wireCount(usage?.cacheWriteTokens),
    },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}
export function decisionsJson(
  result: EvaluationResult,
  context: EvaluationEgressContext,
  request: OpenAIDecisionsRequest,
): unknown {
  return {
    model: context.responseModelId,
    answers: request.questions.map((question, index) =>
      answerJson(question, result.answers[decisionQuestionId(question, index, request.questions)]),
    ),
    usage: decisionsUsage(result.usage),
  };
}
