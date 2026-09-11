import { access, writeFile } from 'node:fs/promises';

import { approveDashboardAuthorization } from './dashboard-approve';
import {
  createGrokCompatFixture,
  GrokCompatProxyError,
  type GrokCompatCommandResult,
  type GrokCompatFixture,
} from './fixture';
import { helperStdoutContractCase, waitForVerificationUrl } from './helper-capture';
import type { GrokCompatOptions, GrokCompatReport } from './types';

export type { GrokCompatOptions, GrokCompatReport } from './types';
export { approveDashboardAuthorization } from './dashboard-approve';
export { HELPER_STDOUT_KEYS, parseDeviceVerificationUrl } from './helper-capture';

type GrokCompatCase = GrokCompatReport['cases'][number];

const NOT_RUN = 'not_run:';

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
    .replace(/aio_agent_(?:at|rt)_[A-Za-z0-9_-]*/gu, '[redacted]')
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

function passed(name: string, detail: string): GrokCompatCase {
  return { name, passed: true, detail: redactCompatText(detail) };
}

function notRun(name: string, detail: string): GrokCompatCase {
  return { name, passed: false, detail: redactCompatText(`${NOT_RUN} ${detail}`) };
}

function fromChild(name: string, child: GrokCompatCommandResult): GrokCompatCase {
  return {
    name,
    passed: child.exitCode === 0,
    detail: redactCompatText(`exit ${child.exitCode} stderr=${child.stderr} stdout=${child.stdout}`),
  };
}

export function compatScriptShouldFail(report: GrokCompatReport): boolean {
  const implemented = report.cases.filter((item) => !item.detail.startsWith(NOT_RUN));
  return implemented.length === 0 || implemented.some((item) => !item.passed);
}

function namedNotRunGates(platform: string): GrokCompatCase[] {
  const gates: GrokCompatCase[] = [
    notRun('natural-15m-expiry', '15-minute natural AT expiry was not waited on this runner'),
    notRun('fresh401', 'native freshly-minted token 401 was not observed'),
    notRun('shared-installation-rotation', 'dual Grok processes sharing one installation were not executed'),
    notRun('plugin-compat-opencode-pi', 'OpenCode/Pi/OMP plugin compatibility was not executed by this harness'),
    notRun('host-timestamp-not-natural-expiry', 'host-only timestamp edits are not natural-expiry evidence'),
  ];
  if (platform !== 'darwin') {
    gates.push(notRun('compiled-darwin-arm64-host', `compiled darwin-arm64 CLI was not run on ${platform}`));
  }
  return gates;
}

async function probeUnimplementedHelperUrl(endpoint: string): Promise<GrokCompatCase> {
  const url = `${endpoint}/__grok_unavailable/managed-config`;
  try {
    const response = await fetch(url, { redirect: 'manual' });
    const location = response.headers.get('location') ?? '';
    if (response.status !== 404) {
      return failed('helper-404', `expected 404 from ${url}, got ${String(response.status)}`);
    }
    if (/x\.ai|grok\.com/iu.test(location)) {
      return failed('helper-404', 'unimplemented helper URL attempted a cloud fallback');
    }
    return passed('helper-404', 'unimplemented helper URL returned 404 without cloud fallback');
  } catch (error) {
    return failed('helper-404', error instanceof Error ? error.message : String(error));
  }
}

function loopbackRecorderCase(fixture: GrokCompatFixture): GrokCompatCase {
  if (fixture.records.length === 0) {
    return notRun('loopback-http-recorder', 'no HTTP records were captured');
  }
  const foreign = fixture.records.filter((item) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/u.test(item.origin));
  if (foreign.length > 0) {
    return failed(
      'loopback-http-recorder',
      `non-loopback origin recorded: ${foreign.map((item) => item.origin).join(',')}`,
    );
  }
  return passed(
    'loopback-http-recorder',
    `recorded ${String(fixture.records.length)} loopback request(s); token fingerprints only`,
  );
}

export function sandboxExecCase(sandboxExec: string | null, grokSpawned: boolean): GrokCompatCase {
  if (sandboxExec === null) return notRun('macos-sandbox-egress', 'egress isolation not available');
  if (!grokSpawned) return notRun('macos-sandbox-egress', 'sandbox-exec present but Grok was not spawned under it');
  return passed('macos-sandbox-egress', `grok invoked under ${sandboxExec}`);
}

async function runJourney(fixture: GrokCompatFixture, options: GrokCompatOptions): Promise<GrokCompatCase[]> {
  const cases: GrokCompatCase[] = [];
  cases.push(await probeUnimplementedHelperUrl(fixture.endpoint));
  const configure = await fixture.run([options.cliBinary, 'agent', 'configure', 'grok']);
  cases.push(fromChild('configure', configure));
  if (configure.exitCode === 0) await fixture.wrapAuthCommand();
  const loginChild = fixture.start([options.grokBinary, 'login']);
  try {
    const verification = await waitForVerificationUrl({
      captureDir: fixture.helperCaptureDir,
      stderr: () => loginChild.stderr(),
      timeoutMs: 60_000,
      finished: () => loginChild.finished(),
    });
    await approveDashboardAuthorization({
      endpoint: fixture.endpoint,
      password: fixture.dashboardPassword,
      verificationUrl: verification.url,
    });
    cases.push(passed('approve', 'Dashboard login/CSRF/approve succeeded'));
  } catch (error) {
    loginChild.kill();
    cases.push(failed('approve', error instanceof Error ? error.message : String(error)));
  }
  const login = await loginChild.result;
  cases.push(fromChild('login', login));
  cases.push(await helperStdoutContractCase(fixture.helperCaptureDir, login.stderr));
  cases.push(fromChild('models', await fixture.run([options.grokBinary, 'models'])));
  cases.push(
    fromChild(
      'stream-and-tool',
      await fixture.run([options.grokBinary, '-p', '--no-session', '-m', 'compat-grok-model', 'compat'], 60_000),
    ),
  );
  cases.push(loopbackRecorderCase(fixture));
  cases.push(sandboxExecCase(fixture.sandboxExec, fixture.sandboxExec !== null));
  cases.push(...namedNotRunGates(process.platform));
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
  let fixture: GrokCompatFixture;
  try {
    fixture = await createGrokCompatFixture(options);
  } catch (error) {
    if (error instanceof GrokCompatProxyError) {
      throw new Error(redactCompatText(`${error.message}`));
    }
    throw error;
  }
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
    if (compatScriptShouldFail(report)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
