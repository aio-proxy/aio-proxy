import { z } from 'zod';

import { NonNegativeIntegerStringSchema } from '../dashboard/index';

export const DesktopLiveV1Schema = z
  .object({
    version: z.literal(1),
    todayTokens: NonNegativeIntegerStringSchema,
    todayCostNanoUsd: NonNegativeIntegerStringSchema,
    inFlight: z.number().int().nonnegative(),
    outputTokensPerSecond: z.number().nonnegative(),
  })
  .strict();

export type DesktopLiveV1 = z.output<typeof DesktopLiveV1Schema>;
