/**
 * TODO(oven-sh/bun#39764): drop this file (and the macOS-only release job) once
 * `bun build --compile` artifacts are accepted on macOS 27 without a re-sign.
 *
 * Bun 1.4 writes a linker-signed Mach-O whose LC_CODE_SIGNATURE macOS 27
 * rejects: the process is SIGKILL'd (exit 137) before user code runs.
 * Replacing the signature with an ad-hoc one makes the binary runnable. No-op
 * for non-darwin compile targets. Darwin targets fail closed if no signer is
 * available so Linux CI cannot ship an unsigned macOS binary.
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
