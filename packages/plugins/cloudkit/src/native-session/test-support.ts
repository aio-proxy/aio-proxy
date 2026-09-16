export type FakeNativeMode =
  | 'exit-after-write'
  | 'partial-frame'
  | 'identity-change'
  | 'oversized'
  | 'duplicate'
  | 'unexpected'
  | 'hold'
  | 'malformed'
  | 'late-cancel-reply'
  | 'ok';

export async function withFakeNative(mode: FakeNativeMode, run: (executable: string) => Promise<void>): Promise<void> {
  const root = await Bun.$`mktemp -d /tmp/aio-cloudkit-native-XXXXXX`.text();
  const launcher = `${root.trim()}/fake-native`;
  const fake = new URL('./fake-native.ts', import.meta.url).href;
  await Bun.write(
    launcher,
    `#!/usr/bin/env bun\nBun.argv.push(${JSON.stringify(`--mode=${mode}`)}); await import(${JSON.stringify(fake)});\n`,
  );
  await Bun.spawn(['chmod', '755', launcher]).exited;
  await run(launcher);
}
