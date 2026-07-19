import { validThoughtSignature } from "../../../protocol/signatures";
import { asRecord } from "../payload-shape";
import { type AllocationCounts, maximumCardinality, removePair } from "./call-allocation-cardinality";
import { callAllocationKey, type FunctionCallReplayPart, sameCanonicalCallFields } from "./replay-parts";

export type CallOccurrence = {
  readonly part: FunctionCallReplayPart;
  readonly replayIndex: number;
};
export type MatchedCall = CallOccurrence & { readonly candidateIndex: number };
type Occurrence = CallOccurrence & {
  readonly id: string | undefined;
  readonly occurrenceOrder: number;
  readonly signature: string | undefined;
};
type Candidate = {
  readonly call: unknown;
  readonly candidateIndex: number;
  readonly candidateOrder: number;
  readonly id: string | undefined;
  readonly quality: 0 | 1 | 2;
  readonly signature: string | undefined;
};
type Group = { readonly candidates: Candidate[]; readonly occurrences: Occurrence[] };

export function allocateCallOccurrences(
  parts: readonly unknown[],
  occurrences: readonly CallOccurrence[],
  candidateIndexes: readonly number[],
  modelId: string,
): readonly MatchedCall[] {
  const groups = new Map<string, Group>();
  occurrences.forEach((occurrence, occurrenceOrder) => {
    const call = asRecord(occurrence.part.call);
    const key = callAllocationKey(call);
    if (call === undefined || key === undefined) return;
    const id = Reflect.get(call, "id");
    const signature = validThoughtSignature(modelId, occurrence.part.signature) ? occurrence.part.signature : undefined;
    group(groups, key).occurrences.push({
      ...occurrence,
      id: typeof id === "string" ? id : undefined,
      occurrenceOrder,
      signature,
    });
  });
  candidateIndexes.forEach((candidateIndex, candidateOrder) => {
    const candidate = asRecord(parts[candidateIndex]);
    const call = asRecord(Reflect.get(candidate ?? {}, "functionCall"));
    const key = callAllocationKey(call);
    if (candidate === undefined || call === undefined || key === undefined) return;
    const id = Reflect.get(call, "id");
    const signatureValue = Reflect.get(candidate, "thoughtSignature");
    const signature = validThoughtSignature(modelId, signatureValue) ? signatureValue : undefined;
    group(groups, key).candidates.push({
      call,
      candidateIndex,
      candidateOrder,
      id: typeof id === "string" ? id : undefined,
      quality: signature !== undefined ? 2 : signatureValue === undefined ? 1 : 0,
      signature,
    });
  });

  return [...groups.values()]
    .flatMap(allocateGroup)
    .sort((left, right) => left.occurrenceOrder - right.occurrenceOrder)
    .map(({ id: _, occurrenceOrder: __, signature: ___, ...match }) => match);
}
type OrderedMatchedCall = Occurrence & { readonly candidateIndex: number };

function allocateGroup(groupValue: Group): readonly OrderedMatchedCall[] {
  const usedCandidates = new Set<number>();
  const usedOccurrences = new Set<number>();
  const matches: OrderedMatchedCall[] = [];
  const pair = (occurrence: Occurrence, candidate: Candidate) => {
    if (!sameCanonicalCallFields(occurrence.part.call, candidate.call)) {
      throw new Error("Replay function-call allocation key collision");
    }
    usedOccurrences.add(occurrence.occurrenceOrder);
    usedCandidates.add(candidate.candidateIndex);
    matches.push({
      ...occurrence,
      candidateIndex: candidate.candidateIndex,
      occurrenceOrder: occurrence.occurrenceOrder,
    });
  };

  pairExactIds(groupValue, usedOccurrences, usedCandidates, pair);
  let counts = remainingCounts(groupValue, usedOccurrences, usedCandidates);
  let target = maximumCardinality(counts);
  const safePair = (occurrence: Occurrence, candidate: Candidate): boolean => {
    const next = removePair(counts, occurrence.id !== undefined, candidate.id !== undefined);
    if (1 + maximumCardinality(next) !== target) return false;
    pair(occurrence, candidate);
    counts = next;
    target -= 1;
    return true;
  };

  pairExactSignatures(groupValue, usedOccurrences, usedCandidates, safePair);
  for (const quality of [2, 1, 0] as const) {
    pairQuality(groupValue, quality, usedOccurrences, usedCandidates, safePair);
  }
  if (target !== 0) throw new Error("Unable to allocate replay function calls");
  return matches;
}

function pairExactIds(
  groupValue: Group,
  usedOccurrences: ReadonlySet<number>,
  usedCandidates: ReadonlySet<number>,
  pair: (occurrence: Occurrence, candidate: Candidate) => void,
): void {
  const ids = [
    ...new Set(groupValue.occurrences.flatMap((occurrence) => (occurrence.id === undefined ? [] : [occurrence.id]))),
  ];
  for (const id of ids) {
    const occurrences = groupValue.occurrences.filter(
      (occurrence) => occurrence.id === id && !usedOccurrences.has(occurrence.occurrenceOrder),
    );
    const candidates = groupValue.candidates.filter(
      (candidate) => candidate.id === id && !usedCandidates.has(candidate.candidateIndex),
    );
    pairSameSignatures(occurrences, candidates, pair);
    const remainingOccurrences = occurrences.filter((occurrence) => !usedOccurrences.has(occurrence.occurrenceOrder));
    const remainingCandidates = candidates
      .filter((candidate) => !usedCandidates.has(candidate.candidateIndex))
      .sort((left, right) => right.quality - left.quality || left.candidateOrder - right.candidateOrder);
    remainingOccurrences.forEach((occurrence, index) => {
      const candidate = remainingCandidates[index];
      if (candidate !== undefined) pair(occurrence, candidate);
    });
  }
}

function pairSameSignatures(
  occurrences: readonly Occurrence[],
  candidates: readonly Candidate[],
  pair: (occurrence: Occurrence, candidate: Candidate) => void,
): void {
  const bySignature = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.signature === undefined) continue;
    const bucket = bySignature.get(candidate.signature) ?? [];
    bucket.push(candidate);
    bySignature.set(candidate.signature, bucket);
  }
  const offsets = new Map<string, number>();
  for (const occurrence of occurrences) {
    if (occurrence.signature === undefined) continue;
    const bucket = bySignature.get(occurrence.signature);
    const offset = offsets.get(occurrence.signature) ?? 0;
    const candidate = bucket?.[offset];
    if (candidate === undefined) continue;
    offsets.set(occurrence.signature, offset + 1);
    pair(occurrence, candidate);
  }
}

function pairExactSignatures(
  groupValue: Group,
  usedOccurrences: ReadonlySet<number>,
  usedCandidates: ReadonlySet<number>,
  pair: (occurrence: Occurrence, candidate: Candidate) => boolean,
): void {
  const candidates = candidateBuckets(groupValue.candidates, usedCandidates, (candidate) => candidate.signature);
  for (const occurrence of groupValue.occurrences) {
    if (usedOccurrences.has(occurrence.occurrenceOrder) || occurrence.signature === undefined) continue;
    const bucket = candidates.get(occurrence.signature);
    tryCompatibleCandidate(occurrence, bucket, usedCandidates, pair);
  }
}

function pairQuality(
  groupValue: Group,
  quality: Candidate["quality"],
  usedOccurrences: ReadonlySet<number>,
  usedCandidates: ReadonlySet<number>,
  pair: (occurrence: Occurrence, candidate: Candidate) => boolean,
): void {
  const bucket = groupValue.candidates.filter((candidate) => candidate.quality === quality);
  for (const occurrence of groupValue.occurrences) {
    if (usedOccurrences.has(occurrence.occurrenceOrder)) continue;
    tryCompatibleCandidate(occurrence, bucket, usedCandidates, pair);
  }
}

function tryCompatibleCandidate(
  occurrence: Occurrence,
  candidates: readonly Candidate[] | undefined,
  usedCandidates: ReadonlySet<number>,
  pair: (occurrence: Occurrence, candidate: Candidate) => boolean,
): boolean {
  if (candidates === undefined) return false;
  const available = candidates.filter(
    (candidate) =>
      !usedCandidates.has(candidate.candidateIndex) &&
      (occurrence.id === undefined || candidate.id === undefined || occurrence.id === candidate.id),
  );
  for (const candidate of available) {
    if (pair(occurrence, candidate)) return true;
  }
  return false;
}

function candidateBuckets(
  candidates: readonly Candidate[],
  usedCandidates: ReadonlySet<number>,
  key: (candidate: Candidate) => string | undefined,
): ReadonlyMap<string, readonly Candidate[]> {
  const buckets = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (usedCandidates.has(candidate.candidateIndex)) continue;
    const value = key(candidate);
    if (value === undefined) continue;
    const bucket = buckets.get(value) ?? [];
    bucket.push(candidate);
    buckets.set(value, bucket);
  }
  return buckets;
}

function remainingCounts(
  groupValue: Group,
  occurrences: ReadonlySet<number>,
  candidates: ReadonlySet<number>,
): AllocationCounts {
  const remainingOccurrences = groupValue.occurrences.filter((value) => !occurrences.has(value.occurrenceOrder));
  const remainingCandidates = groupValue.candidates.filter((value) => !candidates.has(value.candidateIndex));
  return {
    specificCandidates: remainingCandidates.filter((value) => value.id !== undefined).length,
    specificOccurrences: remainingOccurrences.filter((value) => value.id !== undefined).length,
    wildcardCandidates: remainingCandidates.filter((value) => value.id === undefined).length,
    wildcardOccurrences: remainingOccurrences.filter((value) => value.id === undefined).length,
  };
}

function group(groups: Map<string, Group>, key: string): Group {
  const existing = groups.get(key);
  if (existing !== undefined) return existing;
  const created: Group = { candidates: [], occurrences: [] };
  groups.set(key, created);
  return created;
}
