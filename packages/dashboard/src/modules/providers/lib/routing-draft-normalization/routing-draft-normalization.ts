import { RoutingPrioritySchema, RoutingWeightSchema } from '@aio-proxy/types';

export const routingDraftNormalization = (
  kind: 'priority' | 'weight',
  authored: number | undefined,
): { readonly authored: number; readonly effective: number } | undefined => {
  if (authored === undefined || !Number.isFinite(authored)) return undefined;
  const parsed = (kind === 'priority' ? RoutingPrioritySchema : RoutingWeightSchema).safeParse(authored);
  if (!parsed.success || parsed.data === authored) return undefined;
  return { authored, effective: parsed.data };
};
