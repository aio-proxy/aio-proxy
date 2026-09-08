import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '..');
const nativeRoot = join(packageRoot, 'native');
const nativeDist = join(packageRoot, 'dist', 'native');

type CommandResult = { readonly stdout: string; readonly stderr: string };

async function run(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
  const process = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    const detail = stderr.trim().split(/\r?\n/u).slice(-3).join(' ');
    throw new Error(`${command} failed${detail === '' ? '' : `: ${detail}`}`);
  }
  return { stdout, stderr };
}

export function resolveBundleVersion(version: string | undefined): string {
  if (version === undefined || !/^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('CloudKit plugin release manifest must provide a valid release version');
  }
  const numeric = version.split('-', 1)[0];
  return numeric ?? version;
}

async function loadReleaseVersion(): Promise<string> {
  const candidates = [join(packageRoot, 'release-manifest.json'), join(packageRoot, 'package.json')];
  for (const path of candidates) {
    if (!(await Bun.file(path).exists())) continue;
    const value = (await Bun.file(path).json()) as { readonly version?: unknown };
    if (typeof value.version === 'string') return resolveBundleVersion(value.version);
  }
  throw new Error('CloudKit plugin release manifest is missing');
}

async function fileDigest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function assertTool(name: string): void {
  if (Bun.which(name) === null) throw new Error(`Required native build tool is missing: ${name}`);
}

async function buildArchitecture(architecture: 'arm64' | 'x86_64'): Promise<string> {
  const triple = `${architecture}-apple-macosx14.0`;
  const buildPath = join(nativeDist, `.build-${architecture}`);
  await rm(buildPath, { force: true, recursive: true });
  await mkdir(buildPath, { recursive: true });
  await run(
    'swift',
    ['build', '--configuration', 'release', '--triple', triple, '--build-path', buildPath],
    nativeRoot,
  );
  const binPath = (
    await run(
      'swift',
      ['build', '--show-bin-path', '--configuration', 'release', '--triple', triple, '--build-path', buildPath],
      nativeRoot,
    )
  ).stdout.trim();
  const executable = join(binPath, 'AIOProxyCloudKit');
  if (!(await Bun.file(executable).exists())) {
    throw new Error(`Swift did not produce the ${architecture} CloudKit executable`);
  }
  return executable;
}

function infoPlist(template: string, version: string): string {
  return template.replaceAll('__PLUGIN_VERSION__', version);
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('CloudKit native artifacts can only be built on macOS 14 or later');
  }
  for (const tool of ['swift', 'lipo']) assertTool(tool);

  const version = await loadReleaseVersion();
  const template = await readFile(join(nativeRoot, 'Resources', 'Info.plist'), 'utf8');
  await rm(nativeDist, { force: true, recursive: true });
  await mkdir(nativeDist, { recursive: true });

  const [arm64, x86_64] = await Promise.all([buildArchitecture('arm64'), buildArchitecture('x86_64')]);
  const appRoot = join(nativeDist, 'AIOProxyCloudKit.app');
  const contents = join(appRoot, 'Contents');
  const macos = join(contents, 'MacOS');
  await mkdir(macos, { recursive: true });
  const universalExecutable = join(macos, 'AIOProxyCloudKit');
  await run('lipo', ['-create', arm64, x86_64, '-output', universalExecutable]);
  await chmod(universalExecutable, 0o755);
  await writeFile(join(contents, 'Info.plist'), infoPlist(template, version));

  const manifest = {
    artifactVersion: version,
    bundleIdentifier: 'dev.aioproxy',
    appRelativePath: relative(packageRoot, appRoot),
    executableRelativePath: relative(packageRoot, universalExecutable),
    architectures: ['arm64', 'x86_64'],
    executableSha256: await fileDigest(universalExecutable),
    signatureStatus: 'unsigned',
    notarizationStatus: 'unverified',
  } as const;
  await writeFile(join(nativeDist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'CloudKit native build failed');
    process.exitCode = 1;
  });
}
