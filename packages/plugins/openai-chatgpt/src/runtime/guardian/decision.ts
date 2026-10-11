import { isPlainObject } from 'es-toolkit/predicate';

import type { GuardianProjection } from './request';

const unitInterval = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const labels = {
  risk_level: ['low', 'medium', 'high', 'critical'],
  user_authorization: ['unknown', 'low', 'medium', 'high'],
  outcome: ['allow', 'deny', 'uncertain'],
} as const;

function schemaAccepts(decision: Record<string, string>, schema: Record<string, unknown>): boolean {
  const properties = schema['properties'];
  if (
    schema['type'] !== 'object' ||
    schema['additionalProperties'] !== false ||
    !Array.isArray(schema['required']) ||
    !schema['required'].every((key) => typeof key === 'string' && key in decision) ||
    !isPlainObject(properties)
  )
    return false;
  return Object.entries(decision).every(([key, value]) => {
    const property = properties[key];
    return (
      isPlainObject(property) &&
      property['type'] === 'string' &&
      (!('enum' in property) || (Array.isArray(property['enum']) && property['enum'].includes(value)))
    );
  });
}

export function guardianDecision(result: unknown, projection: GuardianProjection): Record<string, string> | undefined {
  if (!isPlainObject(result) || !isPlainObject(result['answers'])) return;
  const answers = result['answers'];
  if (Object.keys(answers).length !== 3) return;
  const selected: Record<string, string> = {};
  for (const [id, choices] of Object.entries(labels)) {
    const answer = answers[id];
    if (
      !isPlainObject(answer) ||
      answer['type'] !== 'choice' ||
      typeof answer['choice'] !== 'string' ||
      !choices.includes(answer['choice'] as never) ||
      !isPlainObject(answer['probabilities'])
    )
      return;
    const probabilities = answer['probabilities'];
    if (
      Object.keys(probabilities).length !== choices.length ||
      !choices.every((choice) => Object.hasOwn(probabilities, choice) && unitInterval(probabilities[choice]))
    )
      return;
    selected[id] = answer['choice'];
  }
  const { risk_level: risk, user_authorization: authorization, outcome } = selected;
  if (outcome === 'uncertain') return;
  const decision: Record<string, string> =
    risk === 'low' && outcome === 'allow'
      ? { outcome: 'allow' }
      : {
          risk_level: risk!,
          user_authorization: authorization!,
          outcome: outcome!,
          rationale:
            outcome === 'allow'
              ? 'The supplied Guardian policy assessment permits this action.'
              : 'The supplied Guardian policy assessment denies this action.',
        };
  return schemaAccepts(decision, projection.schema) ? decision : undefined;
}
