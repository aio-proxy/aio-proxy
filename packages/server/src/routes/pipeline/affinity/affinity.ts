export function prioritizeAffinity<T extends { readonly provider: { readonly id: string } }>(
  candidates: readonly T[],
  providerId: string | undefined,
): readonly T[] {
  if (providerId === undefined) return candidates;
  const index = candidates.findIndex((candidate) => candidate.provider.id === providerId);
  return index <= 0 ? candidates : [candidates[index]!, ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}
