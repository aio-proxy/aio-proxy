import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';

import { type ThinkingMode, classifyProvider } from '../classify';

export type AntigravityFamily = {
  readonly logicalId: string;
  readonly kind: 'split' | 'tiered' | 'same-wire';
  readonly thinking: { readonly mode: ThinkingMode };
  readonly base: string;
  readonly variants: readonly { readonly effort: Effort; readonly model: string }[];
  readonly suppressedWireIds?: readonly string[];
};

export type Effort = 'low' | 'medium' | 'high';

const DISPLAY_EFFORT = /^(.+) \((Low|Medium|High)\)$/;
const WIRE_SUFFIXES = ['-extra-low', '-low', '-medium', '-high', '-tiered'] as const;
const EFFORTS = ['low', 'medium', 'high'] as const;
const THINKING_RANK: Readonly<Record<ThinkingMode, number>> = { none: 0, claude: 1, gemini: 2 };

type FamilyKind = AntigravityFamily['kind'];

type BuiltFamily = AntigravityFamily & { readonly firstPickerIndex: number };

export function pickerModelIds(input: {
  readonly languageIds: ReadonlySet<string>;
  readonly tieredModelIds?: { readonly flash?: readonly string[] };
  readonly agentModelSorts?: readonly { readonly groups: readonly { readonly modelIds: readonly string[] }[] }[];
}): string[] {
  const picker: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!input.languageIds.has(id) || seen.has(id)) return;
    seen.add(id);
    picker.push(id);
  };
  for (const id of input.tieredModelIds?.flash ?? []) push(id);
  for (const sort of input.agentModelSorts ?? []) {
    for (const group of sort.groups) {
      for (const id of group.modelIds) push(id);
    }
  }
  return picker;
}

export function collapseAntigravityFamilies(input: {
  readonly pickerIds: readonly string[];
  readonly descriptorsById: ReadonlyMap<string, ModelDescriptor>;
  readonly deprecatedModelIds?: Record<string, { readonly newModelId?: string }>;
}): AntigravityFamily[] {
  const newModelIds = new Set(
    Object.values(input.deprecatedModelIds ?? {})
      .map((entry) => entry.newModelId)
      .filter((id): id is string => id !== undefined && id !== ''),
  );
  const splitByDisplay = new Map<string, { id: string; effort: Effort }[]>();
  const singles: { kind: Exclude<FamilyKind, 'split'>; id: string; displayName?: string }[] = [];

  for (const id of input.pickerIds) {
    const displayName = input.descriptorsById.get(id)?.displayName;
    const match = displayName === undefined ? undefined : DISPLAY_EFFORT.exec(displayName);
    if (match !== null && match !== undefined) {
      const displayStem = match[1] ?? '';
      const effort = (match[2] ?? '').toLowerCase() as Effort;
      const members = splitByDisplay.get(displayStem) ?? [];
      members.push({ id, effort });
      splitByDisplay.set(displayStem, members);
      continue;
    }
    if (id.endsWith('-tiered')) {
      singles.push({ kind: 'tiered', id });
      continue;
    }
    singles.push({ kind: 'same-wire', id, ...(displayName === undefined ? {} : { displayName }) });
  }

  const candidates: BuiltFamily[] = [];
  for (const [displayStem, members] of splitByDisplay) {
    candidates.push(buildSplitFamily(displayStem, members, input, newModelIds));
  }
  for (const single of singles) {
    candidates.push(buildSingleFamily(single, input.descriptorsById, input.pickerIds));
  }
  return discardAndOrder(candidates);
}

function buildSplitFamily(
  displayStem: string,
  members: readonly { readonly id: string; readonly effort: Effort }[],
  input: {
    readonly pickerIds: readonly string[];
    readonly descriptorsById: ReadonlyMap<string, ModelDescriptor>;
  },
  newModelIds: ReadonlySet<string>,
): BuiltFamily {
  const byEffort = new Map<Effort, string[]>();
  for (const member of members) {
    const ids = byEffort.get(member.effort) ?? [];
    ids.push(member.id);
    byEffort.set(member.effort, ids);
  }

  const variants: { effort: Effort; model: string }[] = [];
  for (const effort of EFFORTS) {
    const ids = byEffort.get(effort);
    if (ids === undefined) continue;
    variants.push({ effort, model: pickEffortWinner(ids, input.pickerIds, newModelIds) });
  }

  const memberIds = variants.map((variant) => variant.model);
  const stems = memberIds.map((id) => stripWireSuffix(id, false));
  return {
    logicalId: agreedStem(stems) ?? slugifyDisplay(displayStem),
    kind: 'split',
    thinking: { mode: familyThinking(memberIds, input.descriptorsById) },
    base: defaultBase(variants, memberIds, input.pickerIds),
    variants,
    firstPickerIndex: earliestPickerIndex(
      members.map((member) => member.id),
      input.pickerIds,
    ),
  };
}

function buildSingleFamily(
  candidate: { readonly kind: Exclude<FamilyKind, 'split'>; readonly id: string; readonly displayName?: string },
  descriptorsById: ReadonlyMap<string, ModelDescriptor>,
  pickerIds: readonly string[],
): BuiltFamily {
  const stem = stripWireSuffix(candidate.id, candidate.kind === 'same-wire');
  const displayName = candidate.displayName ?? descriptorsById.get(candidate.id)?.displayName;
  return {
    logicalId: stem === '' ? slugifyDisplay(stripThinkingSuffix(displayName ?? candidate.id)) : stem,
    kind: candidate.kind,
    thinking: { mode: classifyProvider(descriptorsById.get(candidate.id) ?? {}) },
    base: candidate.id,
    variants: EFFORTS.map((effort) => ({ effort, model: candidate.id })),
    firstPickerIndex: earliestPickerIndex([candidate.id], pickerIds),
  };
}

function pickEffortWinner(
  ids: readonly string[],
  pickerIds: readonly string[],
  newModelIds: ReadonlySet<string>,
): string {
  return [...ids].sort((left, right) => {
    const pickerDelta = pickerPresence(right, pickerIds) - pickerPresence(left, pickerIds);
    if (pickerDelta !== 0) return pickerDelta;
    const replacementDelta = Number(newModelIds.has(right)) - Number(newModelIds.has(left));
    if (replacementDelta !== 0) return replacementDelta;
    return left < right ? -1 : left > right ? 1 : 0;
  })[0]!;
}

function pickerPresence(id: string, pickerIds: readonly string[]): number {
  return pickerIds.includes(id) ? 1 : 0;
}

function defaultBase(
  variants: readonly { readonly effort: Effort; readonly model: string }[],
  memberIds: readonly string[],
  pickerIds: readonly string[],
): string {
  const medium = variants.find((variant) => variant.effort === 'medium');
  if (medium !== undefined) return medium.model;
  const index = earliestPickerIndex(memberIds, pickerIds);
  return pickerIds[index] ?? memberIds[0] ?? '';
}

function familyThinking(
  memberIds: readonly string[],
  descriptorsById: ReadonlyMap<string, ModelDescriptor>,
): ThinkingMode {
  let mode: ThinkingMode = 'none';
  for (const id of memberIds) {
    const next = classifyProvider(descriptorsById.get(id) ?? {});
    if (THINKING_RANK[next] > THINKING_RANK[mode]) mode = next;
  }
  return mode;
}

function discardAndOrder(candidates: readonly BuiltFamily[]): AntigravityFamily[] {
  const byLogicalId = new Map<string, BuiltFamily[]>();
  for (const family of candidates) {
    const group = byLogicalId.get(family.logicalId) ?? [];
    group.push(family);
    byLogicalId.set(family.logicalId, group);
  }

  const winners: BuiltFamily[] = [];
  for (const group of byLogicalId.values()) {
    const split = group.filter((family) => family.kind === 'split');
    const tiered = group.filter((family) => family.kind === 'tiered');
    const sameWire = group.filter((family) => family.kind === 'same-wire');
    const preferred = split.length > 0 ? split : tiered.length > 0 ? tiered : sameWire;
    const winner = pickSameKindWinner(preferred);
    const winnerIds = new Set(familyMemberIds(winner));
    const suppressedWireIds: string[] = [];
    for (const family of group) {
      if (family === winner) continue;
      for (const id of familyMemberIds(family)) {
        if (winnerIds.has(id) || suppressedWireIds.includes(id)) continue;
        suppressedWireIds.push(id);
      }
    }
    winners.push(suppressedWireIds.length === 0 ? winner : { ...winner, suppressedWireIds });
  }

  return winners
    .sort((left, right) => left.firstPickerIndex - right.firstPickerIndex)
    .map(({ firstPickerIndex: _index, ...family }) => family);
}

function familyMemberIds(family: AntigravityFamily): readonly string[] {
  return [family.base, ...family.variants.map((variant) => variant.model), ...(family.suppressedWireIds ?? [])];
}

function pickSameKindWinner(families: readonly BuiltFamily[]): BuiltFamily {
  return [...families].sort((left, right) => {
    if (left.firstPickerIndex !== right.firstPickerIndex) return left.firstPickerIndex - right.firstPickerIndex;
    if (left.variants.length !== right.variants.length) return right.variants.length - left.variants.length;
    return left.base < right.base ? -1 : left.base > right.base ? 1 : 0;
  })[0]!;
}

function stripWireSuffix(id: string, alsoThinking: boolean): string {
  let stem = id;
  for (const suffix of WIRE_SUFFIXES) {
    if (!stem.endsWith(suffix)) continue;
    stem = stem.slice(0, -suffix.length);
    break;
  }
  if (alsoThinking && stem.endsWith('-thinking')) stem = stem.slice(0, -'-thinking'.length);
  return stem;
}

function agreedStem(stems: readonly string[]): string | undefined {
  const first = stems[0];
  if (first === undefined || first === '') return undefined;
  return stems.every((stem) => stem === first) ? first : undefined;
}

function slugifyDisplay(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9.]+/g, '-')
    .replaceAll(/(?<!\d)\.|\.(?!\d)/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
}

function stripThinkingSuffix(displayName: string): string {
  return displayName.endsWith(' (Thinking)') ? displayName.slice(0, -' (Thinking)'.length) : displayName;
}

function earliestPickerIndex(memberIds: readonly string[], pickerIds: readonly string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const id of memberIds) {
    const index = pickerIds.indexOf(id);
    if (index !== -1 && index < best) best = index;
  }
  return best === Number.POSITIVE_INFINITY ? 0 : best;
}
