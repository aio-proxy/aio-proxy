import { isPlainObject } from 'es-toolkit/predicate';

import type { GuardianProjection } from './request';

const labels = {
  risk_level: ['low', 'medium', 'high', 'critical'],
  user_authorization: ['unknown', 'low', 'medium', 'high'],
  outcome: ['allow', 'deny'],
  reason: [
    'low_risk',
    'medium_risk',
    'high_authorized_narrow',
    'high_not_permitted',
    'critical_risk',
    'policy_prohibition',
    'prompt_injection',
    'uncertain',
  ],
} as const;

const rationaleByKey: Record<string, string> = {
  'medium|allow|medium_risk': 'The assessed risk is medium and the supplied policy permits the action.',
  'high|allow|high_authorized_narrow': 'The high-risk action is sufficiently authorized and narrowly scoped.',
  'high|deny|high_not_permitted': 'The high-risk action lacks sufficient authorization or narrow scope.',
  'critical|deny|critical_risk': 'The action poses critical risk under the supplied policy.',
};
for (const risk of ['low', 'medium', 'high']) {
  rationaleByKey[`${risk}|deny|policy_prohibition`] = 'The supplied Guardian policy prohibits this action.';
  rationaleByKey[`${risk}|deny|prompt_injection`] =
    'The action follows untrusted instructions outside the authorized task.';
}

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
  if (Object.keys(answers).length !== 4) return;
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
      !choices.every(
        (choice) =>
          Object.hasOwn(probabilities, choice) &&
          typeof probabilities[choice] === 'number' &&
          Number.isFinite(probabilities[choice]) &&
          probabilities[choice] >= 0 &&
          probabilities[choice] <= 1,
      )
    )
      return;
    selected[id] = answer['choice'];
  }
  const { risk_level: risk, user_authorization: authorization, outcome, reason } = selected;
  if (risk === 'high' && outcome === 'allow' && !['medium', 'high'].includes(authorization!)) return;
  const decision: Record<string, string> | undefined =
    risk === 'low' && outcome === 'allow' && reason === 'low_risk'
      ? { outcome: 'allow' }
      : rationaleByKey[`${risk}|${outcome}|${reason}`] === undefined
        ? undefined
        : {
            risk_level: risk!,
            user_authorization: authorization!,
            outcome: outcome!,
            rationale: rationaleByKey[`${risk}|${outcome}|${reason}`]!,
          };
  return decision && schemaAccepts(decision, projection.schema) ? decision : undefined;
}
