import { describe, expect, it } from 'bun:test';

import type { EvaluationUsageOptions } from '../shared';
import { evaluationCapture } from './evaluation-capture';

const base = { providerId: 'p', modelId: 'm' };

// The System One response schema marks both token fields nullish, so a `null`
// count reaches this layer at runtime even though the typed contract says
// `number | undefined`.
const nullableUsage = (usage: Record<string, unknown>): EvaluationUsageOptions['usage'] =>
  usage as EvaluationUsageOptions['usage'];

describe('evaluationCapture', () => {
  it('records input and output tokens and their total', async () => {
    const completion = await evaluationCapture({ ...base, usage: { inputTokens: 312, outputTokens: 48 } }, undefined);

    expect(completion.outcome).toBe('success');
    expect(completion.usage).toMatchObject({ inputTokens: 312, outputTokens: 48, totalTokens: 360 });
  });

  // The System One response schema marks `usage` and both token fields nullish, so
  // an upstream that reports nothing is not an error. The row still has to exist —
  // it carries the provider/model attribution and any flat per-request fee.
  it('records a row without token fields when usage is unknown, never zeros', async () => {
    const completion = await evaluationCapture({ ...base }, undefined);

    expect(completion.outcome).toBe('success');
    expect(completion.usage).toMatchObject({ providerId: 'p', modelId: 'm' });
    expect(completion.usage?.inputTokens).toBeUndefined();
    expect(completion.usage?.outputTokens).toBeUndefined();
    expect(completion.usage?.totalTokens).toBeUndefined();
  });

  it('drops a non-integer or negative count rather than persisting it', async () => {
    const completion = await evaluationCapture({ ...base, usage: { inputTokens: -1, outputTokens: 1.5 } }, undefined);

    expect(completion.outcome).toBe('success');
    expect(completion.usage?.inputTokens).toBeUndefined();
    expect(completion.usage?.outputTokens).toBeUndefined();
    expect(completion.usage?.totalTokens).toBeUndefined();
  });

  // A half-reported usage object still bills the half it reported; only the derived
  // total is unknowable, and an invented total would misstate the row.
  it('keeps a lone reported count and omits the total it cannot derive', async () => {
    const completion = await evaluationCapture({ ...base, usage: { inputTokens: 312 } }, undefined);

    expect(completion.usage).toMatchObject({ inputTokens: 312 });
    expect(completion.usage?.outputTokens).toBeUndefined();
    expect(completion.usage?.totalTokens).toBeUndefined();
  });

  // Pins the convert layer against the raw layer: a nullish count is "not
  // reported", so the reported side still bills and the row survives. Without
  // this, only the raw layer's behavior was covered and the two could drift.
  it('omits a null input count and keeps the reported output', async () => {
    const completion = await evaluationCapture(
      { ...base, usage: nullableUsage({ inputTokens: null, outputTokens: 48 }) },
      undefined,
    );

    expect(completion.outcome).toBe('success');
    expect(completion.usage).toMatchObject({ providerId: 'p', modelId: 'm', outputTokens: 48 });
    expect(completion.usage).not.toHaveProperty('inputTokens');
    expect(completion.usage).not.toHaveProperty('totalTokens');
  });

  it('omits a null output count and keeps the reported input', async () => {
    const completion = await evaluationCapture(
      { ...base, usage: nullableUsage({ inputTokens: 312, outputTokens: null }) },
      undefined,
    );

    expect(completion.outcome).toBe('success');
    expect(completion.usage).toMatchObject({ providerId: 'p', modelId: 'm', inputTokens: 312 });
    expect(completion.usage).not.toHaveProperty('outputTokens');
    expect(completion.usage).not.toHaveProperty('totalTokens');
  });

  // jev prices input tokens only. The generic pricing path must bill that side
  // without an output price configured, rather than skipping the row.
  it('prices an input-only configured price', async () => {
    const completion = await evaluationCapture(
      { ...base, usage: { inputTokens: 1_000_000, outputTokens: 48 }, configPrice: { id: 'm', input: 2 } },
      undefined,
    );

    expect(completion.usage).toMatchObject({ estimatedCostUsd: 2, priceSource: 'config' });
  });
});
