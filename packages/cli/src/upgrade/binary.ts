import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { BINARY_DOWNLOAD_TIMEOUT_MS, BINARY_NPM_SCOPE, NPM_REGISTRY, SUPPORTED_BINARY_TARGETS } from './constants';

type Verification = { readonly ok: boolean; readonly actual?: string };
type ReplaceOptions = {
  readonly targetPath: string;
  readonly tempPath: string;
  readonly backupPath: string;
  readonly expectedVersion: string;
  readonly verify: (expected: string) => Promise<Verification>;
};

// The os-arch key of the running process, matching the @aio-proxy/cli-<key>
// package suffixes (process.platform is darwin/linux, process.arch is arm64/x64).
export const binaryTargetKey = (): string => `${process.platform}-${process.arch}`;

const isSupportedTarget = (key: string): boolean => (SUPPORTED_BINARY_TARGETS as readonly string[]).includes(key);

// Canonical npm tarball URL for a per-platform CLI package. This is the same
// artifact the Homebrew tap installs (aio-proxy/homebrew-tap Formula pins exactly
// this URL), so both channels share one published binary and one release step.
export const binaryTarballUrl = (registry: string, key: string, version: string): string => {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  return `${base}${BINARY_NPM_SCOPE}/cli-${key}/-/cli-${key}-${version}.tgz`;
};

const unlinkIfExists = async (p: string): Promise<void> => {
  await fs.unlink(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
};

// Pull package/bin/aio-proxy out of the downloaded npm tarball. Bun.Archive
// transparently gunzips the .tgz, matching the layout published by the release
// pipeline (build-binary.ts writes npm/cli-*/bin/aio-proxy).
const extractBinaryFromTarball = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const files = await new Bun.Archive(bytes).files();
  const entry = files.get('package/bin/aio-proxy');
  if (entry === undefined) throw new Error('downloaded package is missing bin/aio-proxy');
  return entry.bytes();
};

// 返回契约：
// - 交换成功且 verify 通过 → 返回 verify 的 { ok:true, actual }。
// - verify 未通过 → 回滚到旧二进制、清理 temp，返回 { ok:false }（不抛，交由调用方决定报错文案）。
// - verify 抛异常（如损坏/格式错的二进制让 Bun.spawn 直接 reject）→ 视为校验失败：先回滚，再 rethrow。
// - 下载/rename 等系统级错误（在 verify 之前发生）→ 尽力回滚后 rethrow，让调用方看到真实 IO 失败。
export const replaceBinaryForUpdate = async (options: ReplaceOptions): Promise<Verification> => {
  // 阶段一：把旧二进制挪到备份、把新二进制换入。此处任何失败都是系统级错误 → 回滚并 rethrow。
  let backupReady = false;
  try {
    await fs.rename(options.targetPath, options.backupPath);
    backupReady = true;
    await fs.rename(options.tempPath, options.targetPath);
  } catch (err) {
    if (backupReady) {
      await unlinkIfExists(options.targetPath);
      await fs.rename(options.backupPath, options.targetPath);
    }
    await unlinkIfExists(options.tempPath);
    throw err;
  }

  // 阶段二：校验换入的新二进制。verify 抛异常也当作校验失败处理：回滚后 rethrow，
  // 避免把无法执行的新二进制留在目标路径。
  let verification: Verification;
  try {
    verification = await options.verify(options.expectedVersion);
  } catch (err) {
    await unlinkIfExists(options.targetPath);
    await fs.rename(options.backupPath, options.targetPath);
    throw err;
  }
  if (!verification.ok) {
    await unlinkIfExists(options.targetPath);
    await fs.rename(options.backupPath, options.targetPath);
    return { ok: false, ...(verification.actual === undefined ? {} : { actual: verification.actual }) };
  }

  // 成功：清理本次备份后返回。
  await unlinkIfExists(options.backupPath);
  return verification;
};

export const sweepStaleBackups = async (targetPath: string): Promise<void> => {
  const dir = dirname(targetPath);
  const base = basename(targetPath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.`) || !entry.endsWith('.bak')) continue;
    const middle = entry.slice(base.length + 1, entry.length - '.bak'.length);
    if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
    await unlinkIfExists(join(dir, entry));
  }
};

const verifyInstalledVersion = async (binPath: string, expected: string): Promise<Verification> => {
  const proc = Bun.spawn([binPath, '--version'], { stdout: 'pipe', stderr: 'ignore' });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) return { ok: false };
  const actual = out.match(/(\d+\.\d+\.\d+)/)?.[1];
  return { ok: actual === expected, ...(actual === undefined ? {} : { actual }) };
};

export const updateViaBinary = async (
  targetPath: string,
  version: string,
  opts: { readonly registry?: string } = {},
): Promise<void> => {
  const key = binaryTargetKey();
  if (!isSupportedTarget(key)) throw new Error(`no prebuilt binary for ${key}; reinstall via install.sh`);
  const url = binaryTarballUrl(opts.registry ?? NPM_REGISTRY, key, version);
  const tempPath = `${targetPath}.new`;
  const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(BINARY_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`binary asset unavailable (${res.status}); reinstall via install.sh`);
    const bin = await extractBinaryFromTarball(new Uint8Array(await res.arrayBuffer()));
    await fs.writeFile(tempPath, bin, { mode: 0o755 });
    const verification = await replaceBinaryForUpdate({
      targetPath,
      tempPath,
      backupPath,
      expectedVersion: version,
      verify: (expected) => verifyInstalledVersion(targetPath, expected),
    });
    if (!verification.ok) throw new Error('upgraded binary failed version check; restored previous binary');
  } finally {
    // A failure before the atomic swap (download/extract/write) leaves the .new
    // temp behind; clear it so retries don't trip over a stale partial file.
    await unlinkIfExists(tempPath);
  }
  await sweepStaleBackups(targetPath);
};
