type CliEnv = Record<string, string | undefined>;
export declare const runCli: (args: readonly string[], env?: CliEnv) => Bun.SyncSubprocess<'pipe', 'pipe'>;
export declare const runCliAsync: (
  args: readonly string[],
  env?: CliEnv,
) => Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;
export declare const runCliUntilOutput: (
  args: readonly string[],
  expected: readonly string[],
  env?: CliEnv,
) => Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;
export declare const output: (result: Bun.SpawnSyncReturns<Uint8Array>) => string;
export declare const cliRunArgs: (port: number) => readonly string[];
export declare const repoCwd: string;
export declare const freePort: () => number;
type WaitForOkOptions = Readonly<{
  probeTimeoutMs: number;
  readinessTimeoutMs: number;
}>;
export declare function waitForOk(url: string, options: WaitForOkOptions): Promise<Response>;
export {};
//# sourceMappingURL=cli-test-helpers.d.ts.map
