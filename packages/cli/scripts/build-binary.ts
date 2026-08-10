import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { virtualCompiledEntry } from './generate-compiled-entry';

// Default targets: the glibc/darwin binaries packed into the npm/cli-* publish packages.
const publishTargets = [
  { suffix: 'darwin-arm64', target: 'bun-darwin-arm64' },
  { suffix: 'darwin-x64', target: 'bun-darwin-x64' },
  { suffix: 'linux-x64', target: 'bun-linux-x64' },
  { suffix: 'linux-arm64', target: 'bun-linux-arm64' },
] as const;

// musl targets are Docker-only (alpine base); they are never packed for npm publish,
// so they are selectable by suffix but excluded from the default loop.
const extraTargets = [
  { suffix: 'linux-x64-musl', target: 'bun-linux-x64-musl' },
  { suffix: 'linux-arm64-musl', target: 'bun-linux-arm64-musl' },
] as const;

const allTargets = [...publishTargets, ...extraTargets];

// Usage:
//   build-binary.ts                      -> build every publish target into npm/cli-*/bin
//   build-binary.ts <suffix>             -> build one target into npm/cli-<suffix>/bin
//   build-binary.ts <suffix> <outfile>   -> build one target to an explicit path (Docker)
const only = process.argv[2];
const explicitOutfile = process.argv[3];
const selected = only === undefined ? publishTargets : allTargets.filter((t) => t.suffix === only);
if (selected.length === 0) {
  console.error(`Unknown target "${only}". Valid: ${allTargets.map((t) => t.suffix).join(', ')}`);
  process.exit(1);
}
if (explicitOutfile !== undefined && selected.length !== 1) {
  console.error('An explicit outfile requires exactly one target suffix.');
  process.exit(1);
}

const rootDir = join(import.meta.dir, '..', '..', '..');
const thirdPartyNotice = await Bun.file(join(rootDir, 'packages/plugins/cursor/src/gen/LICENSE')).bytes();

const entry = virtualCompiledEntry();
for (const { suffix, target } of selected) {
  let outfile: string;
  if (explicitOutfile === undefined) {
    const binDir = join(rootDir, 'npm', `cli-${suffix}`, 'bin');
    mkdirSync(binDir, { recursive: true });
    outfile = join(binDir, 'aio-proxy');
  } else {
    mkdirSync(dirname(explicitOutfile), { recursive: true });
    outfile = explicitOutfile;
  }
  const build = await Bun.build({
    entrypoints: [entry.entrypoint],
    files: entry.files,
    compile: {
      target,
      outfile,
    },
  });
  if (!build.success) {
    for (const log of build.logs) {
      console.error(log);
    }
    console.error(`bun build --compile failed for ${target}`);
    process.exit(1);
  }
  await Bun.write(join(dirname(outfile), 'THIRD_PARTY_NOTICES'), thirdPartyNotice);
  console.log(`${suffix}: ${outfile}`);
}
