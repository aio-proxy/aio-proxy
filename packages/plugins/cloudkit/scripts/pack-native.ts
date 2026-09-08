import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');

export function nativeArchivePath(outputName: string): string {
  return `dist/native/${outputName}`;
}

async function main(): Promise<void> {
  const archive = process.env.CLOUDKIT_SIGNED_ARCHIVE;
  if (archive === undefined || archive.trim() === '') {
    throw new Error('CLOUDKIT_SIGNED_ARCHIVE is required; refusing to package an unsigned native artifact');
  }
  const teamId = process.env.CLOUDKIT_TEAM_ID;
  if (teamId === undefined || teamId.trim() === '') throw new Error('CLOUDKIT_TEAM_ID is required');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string') throw new Error('CloudKit package version is missing');
  const outputRoot = join(packageRoot, 'dist', 'native');
  await mkdir(outputRoot, { recursive: true });
  const outputName = basename(archive);
  const output = join(outputRoot, outputName);
  const bytes = await Bun.file(archive).bytes();
  await copyFile(archive, output);
  const manifest = {
    format: 1 as const,
    pluginVersion: packageJson.version,
    nativeVersion: process.env.CLOUDKIT_NATIVE_VERSION ?? packageJson.version,
    bundleId: 'dev.aioproxy' as const,
    teamId,
    minimumMacOS: '14.0' as const,
    archive: nativeArchivePath(outputName),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) await main();
