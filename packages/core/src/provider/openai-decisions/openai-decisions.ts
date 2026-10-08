import { type ApiProvider, ProviderProtocol } from '@aio-proxy/types';
import { APICallError } from 'ai';
import { z } from 'zod';

import type {
  EvaluationAnswer,
  EvaluationInvocation,
  EvaluationQuestion,
  EvaluationResult,
} from '../../protocol/adapter';
import { type OpenAIDecisionsQuestion, OpenAIDecisionsInputSchema } from '../../protocol/openai-decisions';
import { EvaluationDistributionError } from '../../protocol/typesafe-systemone';
import { createApiProvider } from '../api';
import type { ProviderFetch } from '../proxy-fetch';

const probability = z.number().finite().min(0).max(1);
const choiceValue = z.union([z.string(), z.number().finite(), z.boolean()]);
const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), name: z.string().optional(), probability }).loose(),
  z
    .object({
      type: z.literal('choice'),
      name: z.string().optional(),
      choice: choiceValue,
      probabilities: z.array(z.object({ value: choiceValue, probability })),
      confidence: probability.optional(),
    })
    .loose(),
  z
    .object({
      type: z.literal('score'),
      name: z.string().optional(),
      score: z.number().finite(),
      probabilities: z.array(z.object({ value: z.number().int().nonnegative(), probability })),
      confidence: probability.optional(),
    })
    .loose(),
  z.object({ type: z.literal('refusal'), name: z.string().optional() }).loose(),
]);
const responseSchema = z
  .object({
    answers: z.array(answerSchema),
    usage: z.object({ input_tokens: z.number().int().nonnegative().nullish() }).nullish(),
  })
  .loose();

function instructions(question: EvaluationQuestion): string {
  const text =
    typeof question.instructions === 'string' ? question.instructions : JSON.stringify(question.instructions);
  if (question.type !== 'noul' || question.criteria === undefined) return text;
  return [
    text,
    question.criteria.true === undefined ? undefined : `True: ${question.criteria.true}`,
    question.criteria.false === undefined ? undefined : `False: ${question.criteria.false}`,
  ]
    .filter((entry) => entry !== undefined)
    .join('\n');
}
function projectQuestion(name: string, question: EvaluationQuestion): OpenAIDecisionsQuestion {
  const shared = { name, instructions: instructions(question) };
  switch (question.type) {
    case 'noul':
      return { type: 'predicate', ...shared };
    case 'choice':
      return {
        type: 'choice',
        ...shared,
        choices: Object.entries(question.criteria).map(([value, description]) => ({
          value,
          ...(description === null ? {} : { description }),
        })),
      };
    case 'score':
      return { type: 'score', ...shared, levels: question.criteria.map((label) => ({ label })) };
  }
}
function toInput(state: unknown): z.infer<typeof OpenAIDecisionsInputSchema> {
  const parsed = OpenAIDecisionsInputSchema.safeParse(state);
  // Structured evaluation state is evidence, not an OpenAI message envelope.
  return parsed.success ? parsed.data : JSON.stringify(state);
}
function resultFromResponse(body: unknown, invocation: EvaluationInvocation): EvaluationResult {
  const result = responseSchema.parse(body);
  const ids = Object.keys(invocation.questions);
  const seen = new Set<string>();
  const answers = Object.fromEntries(
    result.answers.map((answer, index): [string, EvaluationAnswer] => {
      const id = answer.name ?? ids[index];
      if (id === undefined || !Object.hasOwn(invocation.questions, id))
        throw new EvaluationDistributionError('Decisions returned an unknown question');
      if (seen.has(id)) throw new EvaluationDistributionError('Decisions returned duplicate answers');
      seen.add(id);
      if (answer.type === 'refusal') return [id, { type: 'refusal' }];
      const question = invocation.questions[id]!;
      const expectedType = question.type === 'noul' ? 'predicate' : question.type;
      if (answer.type !== expectedType)
        throw new EvaluationDistributionError('Decisions answered the wrong question type');
      if (answer.type === 'choice' && question.type === 'choice') {
        const keys = Object.keys(question.criteria);
        if (
          typeof answer.choice !== 'string' ||
          !Object.hasOwn(question.criteria, answer.choice) ||
          answer.probabilities.length !== keys.length ||
          new Set(answer.probabilities.map((entry) => entry.value)).size !== keys.length ||
          answer.probabilities.some(
            (entry) => typeof entry.value !== 'string' || !Object.hasOwn(question.criteria, entry.value),
          )
        )
          throw new EvaluationDistributionError('Decisions returned an invalid choice distribution');
      }
      if (answer.type === 'score' && question.type === 'score') {
        const count = question.criteria.length;
        if (
          answer.score < 0 ||
          answer.score > count - 1 ||
          answer.probabilities.length !== count ||
          new Set(answer.probabilities.map((entry) => entry.value)).size !== count ||
          answer.probabilities.some((entry) => entry.value >= count)
        )
          throw new EvaluationDistributionError('Decisions returned an invalid score distribution');
      }
      if (answer.type === 'predicate') return [id, { type: 'noul', noul: answer.probability }];
      const extras = {
        probabilities: Object.fromEntries(
          answer.probabilities.map((entry) => [String(entry.value), entry.probability]),
        ),
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      };
      return answer.type === 'choice'
        ? [id, { type: 'choice', choice: String(answer.choice), ...extras }]
        : [id, { type: 'score', score: answer.score, ...extras }];
    }),
  );
  if (Object.keys(answers).length !== Object.keys(invocation.questions).length)
    throw new EvaluationDistributionError('Decisions did not answer every question');
  return {
    answers,
    ...(result.usage?.input_tokens == null
      ? {}
      : { usage: { inputTokens: result.usage.input_tokens, outputTokens: 0 } }),
  };
}

/** Native Decisions evaluation transport, sharing API endpoint URL, auth and proxy handling with raw requests. */
export function createOpenAIDecisionsEvaluate(config: ApiProvider, options: { readonly fetch?: ProviderFetch } = {}) {
  const endpoint = createApiProvider(config, options).endpointTransports.find(
    (entry) => entry.protocol === ProviderProtocol.OpenAIDecisions,
  );
  if (endpoint === undefined) throw new TypeError('Provider has no Decisions endpoint');
  return {
    async evaluate(
      invocation: EvaluationInvocation,
      call: { readonly modelId: string; readonly signal?: AbortSignal },
    ): Promise<EvaluationResult> {
      const body = {
        model: call.modelId,
        input: toInput(invocation.state),
        questions: Object.entries(invocation.questions).map(([name, question]) => projectQuestion(name, question)),
      };
      const raw = new Request('http://aio-proxy.local/v1/decisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      const response = await endpoint.passthrough(raw);
      if (!response.ok)
        throw new APICallError({
          message: 'Upstream Decisions request failed',
          url: raw.url,
          requestBodyValues: body,
          statusCode: response.status,
          responseHeaders: Object.fromEntries(response.headers),
          responseBody: await response.text(),
        });
      try {
        return resultFromResponse(await response.json(), invocation);
      } catch (error) {
        throw new APICallError({
          message: 'Upstream Decisions returned an invalid response',
          url: raw.url,
          requestBodyValues: body,
          statusCode: 502,
          cause: error,
        });
      }
    },
  };
}
