import { access, writeFile } from 'node:fs/promises';

import { createGrokCompatFixture, type GrokCompatCommandResult, type GrokCompatFixture } from './fixture';
import type { GrokCompatOptions, GrokCompatReport } from './types';

export type { GrokCompatOptions, GrokCompatReport } from './types';

type GrokCompatCase = GrokCompatReport['cases'][number];

function parseFlag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

function parseGrokVersion(output: string): string | undefined {
  return /^\s*grok\s+(\S+)/u.exec(output)?.[1];
}

export function redactCompatText(text: string): string {
  return text
    .replace(/aio_agent_[A-Za-z0-9_]+/gu, '[redacted]')
    .replace(/(access_token|refresh_token|user_code)(\s*[:=]\s*"?)[^"\s,}\\]*/giu, '$1$2[redacted]')
    .replace(/access_token|refresh_token|user_code/giu, '[redacted]');
}

function redactReport(report: GrokCompatReport): GrokCompatReport {
  return {
    ...report,
    grokVersion: redactCompatText(report.grokVersion),
    cliVersion: redactCompatText(report.cliVersion),
    cases: report.cases.map((item) => ({
      ...item,
      name: redactCompatText(item.name),
      detail: redactCompatText(item.detail),
    })),
  };
}

async function requireBinary(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} binary is missing: ${path}`);
  }
}

async function capture(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<GrokCompatCommandResult> {
  const command = argv[0];
  if (command === undefined) throw new Error('missing command');
  const child = Bun.spawn([command, ...argv.slice(1)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function failed(name: string, detail: string): GrokCompatCase {
  return { name, passed: false, detail: redactCompatText(detail) };
}

function fromChild(name: string, child: GrokCompatCommandResult): GrokCompatCase {
  return {
    name,
    passed: child.exitCode === 0,
    detail: redactCompatText(`exit ${child.exitCode} stderr=${child.stderr} stdout=${child.stdout}`),
  };
}

function unrunHostGates(platform: string): GrokCompatCase[] {
  return [
    failed('natural-15m-expiry', 'not run: 15-minute natural AT expiry was not waited on this runner'),
    failed(
      'macos-sandbox-egress',
      platform === 'darwin'
        ? 'not run: sandbox-exec token-destination capture was not executed'
        : 'not run: not macOS; sandbox-exec unavailable; no equivalent network isolation on this runner',
    ),
    failed('compiled-darwin-arm64-host', `not run: compiled CLI + real Grok host not run on this runner (${platform})`),
    failed('fresh401', 'not run: no real Grok host; native freshly-minted token 401 was not observed'),
    failed('shared-installation-rotation', 'not run: no real dual Grok processes sharing one installation'),
    failed('plugin-compat-opencode-pi', 'not run: OpenCode/Pi/OMP plugin compatibility was not executed here'),
    failed('host-timestamp-not-natural-expiry', 'host-only timestamp edits are not natural-expiry evidence'),
  ];
}

async function runJourney(fixture: GrokCompatFixture, options: GrokCompatOptions): Promise<GrokCompatCase[]> {
  const cases: GrokCompatCase[] = [];
  const login = await fixture.run([options.grokBinary, 'login']);
  cases.push(fromChild('login', login));
  cases.push(fromChild('configure', await fixture.run([options.cliBinary, 'agent', 'configure', 'grok'])));
  cases.push(fromChild('models', await fixture.run([options.grokBinary, 'models'])));
  cases.push(
    fromChild(
      'stream-and-tool',
      await fixture.run([options.grokBinary, '-p', '--no-session', '-m', 'compat-grok-model', 'compat']),
    ),
  );
  const helper = await fixture.run([options.cliBinary, 'agent', 'auth', 'grok', '--installation-id', 'missing']);
  cases.push(fromChild('helper-stdout-contract', helper));
  cases.push(...unrunHostGates(process.platform));
  return cases;
}

export async function runGrokCompatibility(options: GrokCompatOptions): Promise<GrokCompatReport> {
  await requireBinary(options.grokBinary, 'Grok');
  await requireBinary(options.cliBinary, 'CLI');
  const grok = await capture([options.grokBinary, '--version']);
  if (grok.exitCode !== 0) throw new Error(`Grok --version failed with ${grok.exitCode}`);
  const grokVersion = parseGrokVersion(grok.stdout) ?? grok.stdout.trim();
  if (grokVersion !== options.expectedVersion) {
    throw new Error(`Grok version ${grokVersion} does not match ${options.expectedVersion}`);
  }
  const cli = await capture([options.cliBinary, '--version']);
  const cliVersion = cli.stdout.trim();
  const fixture = await createGrokCompatFixture(options);
  let lastProgress = Date.now();
  const heartbeat = setInterval(() => {
    process.stderr.write(`[grok-compat] waiting ${Math.round((Date.now() - lastProgress) / 1000)}s\n`);
  }, 30_000);
  let cases: GrokCompatCase[] = [];
  try {
    cases.push(...(await runJourney(fixture, options)));
    for (const item of cases) {
      lastProgress = Date.now();
      process.stderr.write(`[grok-compat] ${item.name}: ${item.passed ? 'passed' : 'failed'} ${item.detail}\n`);
    }
  } finally {
    clearInterval(heartbeat);
    await fixture.close();
  }
  const report = redactReport({
    grokVersion,
    cliVersion,
    platform: `${process.platform}-${process.arch}`,
    cases,
  });
  await writeFile(options.reportPath, `${JSON.stringify(report, undefined, 2)}\n`, { mode: 0o600 });
  return report;
}

function parseOptions(argv: readonly string[]): GrokCompatOptions {
  return {
    grokBinary: parseFlag(argv, '--grok-bin'),
    cliBinary: parseFlag(argv, '--cli-bin'),
    expectedVersion: parseFlag(argv, '--expected-version'),
    reportPath: parseFlag(argv, '--report'),
  };
}

if (import.meta.main) {
  try {
    const report = await runGrokCompatibility(parseOptions(Bun.argv));
    if (report.cases.length === 0 || report.cases.some((item) => !item.passed)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
