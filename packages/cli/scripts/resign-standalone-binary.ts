/**
 * Bun's `bun build --compile` writes a linker-signed Mach-O whose
 * LC_CODE_SIGNATURE macOS 27 rejects: the process is SIGKILL'd (exit 137)
 * before user code runs. Replacing the signature with an ad-hoc one makes the
 * binary runnable.
 *
 * oven-sh/bun#39764 is closed and oven-sh/bun#39837 fixed the darwin-arm64
 * signer in Bun 1.4.1 — but as of Bun 1.4.2 `bun-darwin-x64` output still fails
 * `codesign -v`. build-binary.ts publishes both darwin arches, so this stays.
 * TODO(oven-sh/bun): drop this file, its call in build-binary.ts, and the
 * macOS-only release job once darwin-x64 compile output passes `codesign -v`
 * unmodified. Re-check with:
 *   bun build --compile --target=bun-darwin-x64 --outfile=/tmp/p x.ts && codesign -v /tmp/p
 *
 * No-op for non-darwin compile targets. Darwin targets fail closed if no signer
 * is available so Linux CI cannot ship an unsigned macOS binary.
 */
export function resignStandaloneBinary(outfile: string, compileTarget?: string): void {
  const darwin = compileTarget === undefined ? process.platform === 'darwin' : compileTarget.startsWith('bun-darwin-');
  if (!darwin) return;

  const command = signerCommand(outfile);
  if (command === undefined) {
    throw new Error(
      `codesign or rcodesign is required to resign ${outfile}; Bun 1.4 compile artifacts are killed on macOS 27 until re-signed`,
    );
  }

  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

const signerCommand = (outfile: string): string[] | undefined => {
  if (Bun.which('codesign') !== null) return ['codesign', '--force', '--sign', '-', outfile];
  if (Bun.which('rcodesign') !== null) return ['rcodesign', 'sign', outfile];
  return undefined;
};
