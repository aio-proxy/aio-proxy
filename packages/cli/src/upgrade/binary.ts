import { createWriteStream, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { BINARY_DOWNLOAD_TIMEOUT_MS, GITHUB_REPO } from './constants';

type Verification = { readonly ok: boolean; readonly actual?: string };
type ReplaceOptions = {
  readonly targetPath: string;
  readonly tempPath: string;
  readonly backupPath: string;
  readonly expectedVersion: string;
  readonly verify: (expected: string) => Promise<Verification>;
};

export const binaryAssetName = (): string => `aio-proxy-${process.platform}-${process.arch}`;

const unlinkIfExists = async (p: string): Promise<void> => {
  await fs.unlink(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
};

// 返回契约：
// - 交换成功且 verify 通过 → 返回 verify 的 { ok:true, actual }。
// - verify 未通过 → 回滚到旧二进制、清理 temp，返回 { ok:false }（不抛，交由调用方决定报错文案）。
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

  // 阶段二：校验换入的新二进制。未通过 → 回滚并返回 { ok:false }（正常业务失败，不 rethrow）。
  const verification = await options.verify(options.expectedVersion);
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

export const updateViaBinary = async (targetPath: string, version: string): Promise<void> => {
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryAssetName()}`;
  const tempPath = `${targetPath}.new`;
  const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(BINARY_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || res.body === null)
    throw new Error(`binary asset unavailable (${res.status}); reinstall via install.sh`);
  await pipeline(res.body, createWriteStream(tempPath, { mode: 0o755 }));
  const verification = await replaceBinaryForUpdate({
    targetPath,
    tempPath,
    backupPath,
    expectedVersion: version,
    verify: (expected) => verifyInstalledVersion(targetPath, expected),
  });
  if (!verification.ok) throw new Error(`upgraded binary failed version check; restored previous binary`);
  await sweepStaleBackups(targetPath);
};
