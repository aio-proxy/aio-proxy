import { z } from 'zod';

import { readJsonRequest } from '../request/index';

const value = z.union([z.string(), z.number().finite(), z.boolean()]);
const part = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input_text'), text: z.string() }).loose(),
  z
    .object({
      type: z.literal('input_image'),
      image_url: z.string().regex(/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/u),
    })
    .loose(),
]);
export const OpenAIDecisionsInputSchema = z.union([
  z.string(),
  z
    .array(
      z
        .object({
          role: z.literal('user').optional(),
          type: z.literal('message').optional(),
          content: z.union([z.string(), z.array(part).min(1)]),
        })
        .loose(),
    )
    .min(1),
]);
const shared = { name: z.string().optional(), instructions: z.string() };
export const OpenAIDecisionsQuestionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('predicate'), ...shared }).loose(),
  z
    .object({
      type: z.literal('choice'),
      ...shared,
      choices: z.array(z.object({ value, description: z.string().optional() }).loose()).min(1),
    })
    .loose(),
  z
    .object({
      type: z.literal('score'),
      ...shared,
      levels: z.array(z.object({ label: z.string(), description: z.string().optional() }).loose()).min(2),
    })
    .loose(),
]);
export const OpenAIDecisionsRequestSchema = z
  .object({
    model: z.string().min(1),
    input: OpenAIDecisionsInputSchema,
    questions: z.array(OpenAIDecisionsQuestionSchema).min(1),
  })
  .loose()
  .superRefine((body, context) => {
    const names = new Set<string>();
    body.questions.forEach((question, index) => {
      const id = question.name;
      if (id !== undefined && names.has(id))
        context.addIssue({
          code: 'custom',
          message: 'Question names must be unique',
          path: ['questions', index, 'name'],
        });
      if (id !== undefined) names.add(id);
      if (question.type === 'choice') {
        const values = new Set(question.choices.map((choice) => JSON.stringify(choice.value)));
        if (values.size !== question.choices.length)
          context.addIssue({
            code: 'custom',
            message: 'Choice values must be distinct',
            path: ['questions', index, 'choices'],
          });
      }
    });
  });
export type OpenAIDecisionsRequest = z.infer<typeof OpenAIDecisionsRequestSchema>;
export type OpenAIDecisionsQuestion = z.infer<typeof OpenAIDecisionsQuestionSchema>;
export function decisionQuestionId(
  question: OpenAIDecisionsQuestion,
  index: number,
  questions: readonly OpenAIDecisionsQuestion[],
): string {
  if (question.name !== undefined) return question.name;
  let id = `__decision_${index}`;
  while (questions.some((entry) => entry.name === id)) id += '_';
  return id;
}

export async function parseOpenAIDecisions(raw: Request): Promise<OpenAIDecisionsRequest> {
  return OpenAIDecisionsRequestSchema.parse(await readJsonRequest(raw));
}
