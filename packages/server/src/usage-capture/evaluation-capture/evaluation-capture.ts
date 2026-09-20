import type { ServerLogSink } from '../../server-log';
import { type EvaluationUsageOptions, type UsageCompletion, usageProperty } from '../shared';
import { finalizeUsage } from '../usage-validation';

// A count the row can carry. `UsageRow` requires finite non-negative safe
// integers, so a malformed field is dropped rather than recorded: omitting it
// keeps the rest of the row billable, where a zero would assert a real count of
// none and a NaN would fail validation and discard the whole row.
const validCount = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// Evaluation upstreams report input/output counts and no total, so the total is
// derived and only when both sides are known. Unknown usage is not a failure —
// the System One response schema marks `usage` and both token fields nullish —
// so the row is still written for attribution and any flat per-request fee.
export async function evaluationCapture(
  { usage, providerId, modelId, requestedModelId, configPrice }: EvaluationUsageOptions,
  logger: ServerLogSink | undefined,
): Promise<UsageCompletion> {
  const inputTokens = validCount(usage?.inputTokens);
  const outputTokens = validCount(usage?.outputTokens);
  const totalTokens =
    inputTokens === undefined || outputTokens === undefined ? undefined : validCount(inputTokens + outputTokens);
  const row = await finalizeUsage({
    usage: {
      providerId,
      modelId,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(totalTokens === undefined ? {} : { totalTokens }),
    },
    accounting: { source: 'ai-sdk' },
    providerId,
    modelId,
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    ...(configPrice === undefined ? {} : { configPrice }),
    ...(logger === undefined ? {} : { logger }),
  });
  return { outcome: 'success', ...usageProperty(row) };
}
