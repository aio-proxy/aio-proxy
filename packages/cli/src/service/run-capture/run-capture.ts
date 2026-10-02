export type CaptureResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

// Windows tools differ in what they write to a pipe: some emit UTF-16LE (with or without a BOM), most
// emit 8-bit text. UTF-16LE of mostly-ASCII text has NUL high bytes at odd offsets; UTF-8 text has no NULs.
export function decodeOutput(bytes: Uint8Array): string {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || bytes.some((b, i) => i % 2 === 1 && b === 0);
  return new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(bytes);
}

/** Runs a query command hidden, capturing its output instead of streaming it to the user. */
export async function runCapture(cmd: readonly string[]): Promise<CaptureResult> {
  const proc = Bun.spawn(cmd as string[], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).bytes(),
    proc.exited,
  ]);
  return { code, stdout: decodeOutput(stdout), stderr: decodeOutput(stderr) };
}
