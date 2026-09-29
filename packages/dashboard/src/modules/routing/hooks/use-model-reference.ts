import type { ModelMetadata } from '@aio-proxy/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { modelsDevLookupQueryOptions } from '../services/models-dev-service';

export interface ModelReference {
  /** The reference the user chose in `extend`, or `''` when they chose none. */
  readonly extend: string;
  /** The reference in effect: the chosen one, else the catalog match for the model ID, else `''`. */
  readonly slug: string;
  /** `slug` was matched from the model ID rather than chosen. */
  readonly matched: boolean;
  /** The reference's own metadata; `undefined` when nothing matched or before it loads. */
  readonly inherited: ModelMetadata | undefined;
  /** The reference is still loading, so there is nothing to seed an override from yet. */
  readonly pending: boolean;
}

/**
 * The model this model's metadata follows. Without `extend` the proxy still falls back to the
 * catalog entry matching the model ID, field by field, so that match is the reference in effect.
 */
export const useModelReference = (
  modelId: string,
  metadata: { readonly extend?: unknown } | undefined,
): ModelReference => {
  const extend = typeof metadata?.extend === 'string' ? metadata.extend : '';
  const queryClient = useQueryClient();
  const lookup = useQuery(modelsDevLookupQueryOptions(extend === '' ? modelId : extend));
  const found = typeof lookup.data?.slug === 'string' ? lookup.data.slug : '';
  // The match is that slug's own entry. Filing it under the slug too means writing the match into
  // `extend` switches to a lookup that is already answered, instead of reloading the same model.
  const matchedData = extend === '' && found !== '' ? lookup.data : undefined;
  useEffect(() => {
    if (matchedData === undefined) return;
    const { queryKey } = modelsDevLookupQueryOptions(matchedData.slug ?? '');
    if (queryClient.getQueryData(queryKey) === undefined) queryClient.setQueryData(queryKey, matchedData);
  }, [matchedData, queryClient]);
  const slug = extend === '' ? found : extend;
  return {
    extend,
    slug,
    matched: extend === '' && slug !== '',
    inherited: lookup.data?.metadata ?? undefined,
    pending: lookup.isPending,
  };
};
