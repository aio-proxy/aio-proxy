// Parsers for the bundle checks. A parse miss must fail the check, never pass it.

export const MINIMUM_MACOS = '13.0';

/** Every `minos` in `vtool -show-build` output; one per architecture slice. */
export function parseMinos(vtoolOutput: string): string[] {
  return [...vtoolOutput.matchAll(/^\s*minos\s+(\d+(?:\.\d+)*)\s*$/gmu)].map((match) => match[1] ?? '');
}

/** `a <= b` for dotted numeric versions (`12.0` vs `13.0`). */
export function versionAtMost(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}

export type MachOCheck = {
  readonly path: string;
  readonly archs: string;
  readonly vtool: string;
  readonly exactArm64: boolean;
};

/** Problems with one Mach-O; empty when it passes. */
export function machOProblems({ path, archs, vtool, exactArm64 }: MachOCheck): string[] {
  const problems: string[] = [];
  const list = archs.trim().split(/\s+/u).filter(Boolean);
  if (exactArm64 ? list.join(' ') !== 'arm64' : !list.includes('arm64')) {
    problems.push(`${path}: architectures "${archs.trim()}", expected ${exactArm64 ? 'exactly' : 'to include'} arm64`);
  }
  const minos = parseMinos(vtool);
  if (minos.length === 0) problems.push(`${path}: vtool reported no minos`);
  for (const version of minos) {
    if (!versionAtMost(version, MINIMUM_MACOS)) problems.push(`${path}: minos ${version} is above ${MINIMUM_MACOS}`);
  }
  return problems;
}
