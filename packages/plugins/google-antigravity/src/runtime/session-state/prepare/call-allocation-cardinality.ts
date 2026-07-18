export type AllocationCounts = {
  readonly specificCandidates: number;
  readonly specificOccurrences: number;
  readonly wildcardCandidates: number;
  readonly wildcardOccurrences: number;
};

export function maximumCardinality(counts: AllocationCounts): number {
  const specificMatches = Math.min(counts.specificOccurrences, counts.wildcardCandidates);
  return (
    specificMatches +
    Math.min(counts.wildcardOccurrences, counts.specificCandidates + counts.wildcardCandidates - specificMatches)
  );
}

export function removePair(
  counts: AllocationCounts,
  occurrenceHasId: boolean,
  candidateHasId: boolean,
): AllocationCounts {
  return {
    specificCandidates: counts.specificCandidates - (candidateHasId ? 1 : 0),
    specificOccurrences: counts.specificOccurrences - (occurrenceHasId ? 1 : 0),
    wildcardCandidates: counts.wildcardCandidates - (candidateHasId ? 0 : 1),
    wildcardOccurrences: counts.wildcardOccurrences - (occurrenceHasId ? 0 : 1),
  };
}
