import type { AgentTarget } from '@aio-proxy/types';

export type AgentAssetPaths = {
  readonly opencode: string;
  readonly officialPi: string;
  readonly omp: string;
};

const json = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

const bytes = async (path: string): Promise<Uint8Array> => {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`Agent adapter asset not found: ${path}`);
  return file.bytes();
};

export async function agentFiles(
  target: AgentTarget,
  paths: AgentAssetPaths,
): Promise<ReadonlyMap<string, Uint8Array>> {
  if (target === 'opencode') {
    return new Map([
      ['index.js', await bytes(paths.opencode)],
      ['package.json', json({ type: 'module' })],
    ]);
  }
  return new Map([
    ['dist/official-pi.js', await bytes(paths.officialPi)],
    ['dist/omp.js', await bytes(paths.omp)],
    [
      'package.json',
      json({
        type: 'module',
        pi: { extensions: ['./dist/official-pi.js'] },
        omp: { extensions: ['./dist/omp.js'] },
      }),
    ],
  ]);
}
