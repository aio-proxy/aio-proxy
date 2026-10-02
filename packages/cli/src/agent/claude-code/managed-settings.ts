import { constants } from 'node:fs';
import { mkdir, open, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { omit } from 'es-toolkit/object';
import { isEqual, isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

export type ClaudeCodeLocation = {
  readonly home: string;
  readonly settingsPath: string;
  readonly markerPath: string;
};

const MANAGED_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

const SlotSchema = z.union([
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({ present: z.literal(true), value: z.json() }),
]);
type Slot = z.output<typeof SlotSchema>;
// `applied` is a digest: Claude Code rewrites settings.json itself, so ownership cannot live in
// that file, and the sidecar must not become a second copy of a live proxy key.
const FieldSchema = z.strictObject({ before: SlotSchema, applied: z.string().regex(/^[0-9a-f]{64}$/u) });
const MarkerSchema = z.strictObject({
  format: z.literal(1),
  managedBy: z.literal('aio-proxy'),
  agent: z.literal('claude-code'),
  settingsPath: z.string(),
  endpoint: z.string(),
  credential: z.enum(['placeholder', 'existing']),
  createdEnv: z.boolean(),
  fields: z.strictObject({ ANTHROPIC_BASE_URL: FieldSchema, ANTHROPIC_AUTH_TOKEN: FieldSchema }),
});
type Marker = z.output<typeof MarkerSchema>;

type FileSnapshot = { readonly text: string; readonly mode: number };
type Settings = Record<string, unknown>;

const digest = (value: string): string => new Bun.CryptoHasher('sha256').update(value).digest('hex');

async function readRegular(path: string): Promise<FileSnapshot | undefined> {
  // A symlinked file is refused (ELOOP): replacing it would detach the user's link target.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw error;
  });
  if (handle === undefined) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    return { text: await handle.readFile('utf8'), mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function replaceFile(
  path: string,
  text: string,
  expected: FileSnapshot | undefined,
  mode: number = expected?.mode ?? 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Claude Code writes this file too; never rename over a version this run did not read.
    if ((await readRegular(path))?.text !== expected?.text) throw new Error(`${path} changed during update`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function parseSettings(text: string | undefined): { readonly settings: Settings; readonly env?: Settings } {
  if (text === undefined || text.trim() === '') return { settings: {} };
  const settings: unknown = JSON.parse(text);
  if (!isPlainObject(settings)) throw new Error('Claude Code settings must be a JSON object');
  const env = settings['env'];
  if (env === undefined) return { settings };
  if (!isPlainObject(env)) throw new Error('Claude Code settings env must be a JSON object');
  return { settings, env };
}

async function readMarker(
  location: ClaudeCodeLocation,
): Promise<{ readonly marker: Marker; readonly file: FileSnapshot } | undefined> {
  const file = await readRegular(location.markerPath);
  if (file === undefined) return undefined;
  const marker = MarkerSchema.parse(JSON.parse(file.text));
  if (marker.settingsPath !== location.settingsPath) throw new Error('Claude Code marker settings path conflict');
  return { marker, file };
}

// Values come from JSON.parse, so they are JSON by construction.
const slotOf = (env: Settings | undefined, key: ManagedKey): Slot =>
  env !== undefined && Object.hasOwn(env, key)
    ? { present: true, value: env[key] as Extract<Slot, { present: true }>['value'] }
    : { present: false };

const isApplied = (env: Settings | undefined, key: ManagedKey, marker: Marker): boolean => {
  const value = env?.[key];
  return typeof value === 'string' && digest(value) === marker.fields[key].applied;
};

const pathsOf = (keys: readonly ManagedKey[]): readonly string[] => keys.map((key) => `env.${key}`);

async function loadConfigurable(location: ClaudeCodeLocation) {
  const previous = await readMarker(location);
  const original = await readRegular(location.settingsPath);
  const { settings, env } = parseSettings(original?.text);
  if (previous !== undefined) {
    // A value still equal to `before` is an interrupted write, not a user edit.
    const drift = MANAGED_KEYS.filter(
      (key) => !isApplied(env, key, previous.marker) && !isEqual(slotOf(env, key), previous.marker.fields[key].before),
    );
    if (drift.length > 0) throw new Error(`Claude Code managed fields changed: ${pathsOf(drift).join(', ')}`);
  }
  return { previous, original, settings, env };
}

/** Fails before any prompt when configure could not write: broken settings, foreign marker, or user edits. */
export async function assertClaudeCodeConfigurable(location: ClaudeCodeLocation): Promise<void> {
  await loadConfigurable(location);
}

export type ClaudeCodeInspection = {
  readonly status: 'absent' | 'managed' | 'modified' | 'conflict';
  readonly endpoint?: string;
  readonly credential?: Marker['credential'];
  readonly baseUrl?: string;
  /** For the connection probe only; never rendered. */
  readonly token?: string;
  readonly changedPaths: readonly string[];
};

export async function inspectClaudeCodeSettings(location: ClaudeCodeLocation): Promise<ClaudeCodeInspection> {
  try {
    const marker = (await readMarker(location))?.marker;
    if (marker === undefined) return { status: 'absent', changedPaths: [] };
    const { env } = parseSettings((await readRegular(location.settingsPath))?.text);
    const changedPaths = pathsOf(MANAGED_KEYS.filter((key) => !isApplied(env, key, marker)));
    const baseUrl = env?.['ANTHROPIC_BASE_URL'];
    const token = env?.['ANTHROPIC_AUTH_TOKEN'];
    return {
      status: changedPaths.length === 0 ? 'managed' : 'modified',
      endpoint: marker.endpoint,
      credential: marker.credential,
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
      ...(typeof token === 'string' ? { token } : {}),
      changedPaths,
    };
  } catch {
    return { status: 'conflict', changedPaths: [] };
  }
}

export async function configureClaudeCodeSettings(
  location: ClaudeCodeLocation,
  input: { readonly endpoint: string; readonly token: string; readonly credential: Marker['credential'] },
): Promise<'configured' | 'unchanged'> {
  // With a base URL and no credential variable, Claude Code keeps using its saved claude.ai login.
  if (input.token.trim() === '') throw new Error('Claude Code needs a non-empty ANTHROPIC_AUTH_TOKEN');
  const { previous, original, settings, env } = await loadConfigurable(location);
  const applied: Record<ManagedKey, string> = {
    ANTHROPIC_BASE_URL: input.endpoint,
    ANTHROPIC_AUTH_TOKEN: input.token,
  };
  const field = (key: ManagedKey) => ({
    before: previous?.marker.fields[key].before ?? slotOf(env, key),
    applied: digest(applied[key]),
  });
  const marker: Marker = {
    format: 1,
    managedBy: 'aio-proxy',
    agent: 'claude-code',
    settingsPath: location.settingsPath,
    endpoint: input.endpoint,
    credential: input.credential,
    createdEnv: previous?.marker.createdEnv ?? env === undefined,
    fields: { ANTHROPIC_BASE_URL: field('ANTHROPIC_BASE_URL'), ANTHROPIC_AUTH_TOKEN: field('ANTHROPIC_AUTH_TOKEN') },
  };
  if (isEqual(previous?.marker, marker) && MANAGED_KEYS.every((key) => env?.[key] === applied[key])) return 'unchanged';
  // Marker first: a crash in between leaves a marker whose fields still equal `before`, which both
  // configure and remove recognise. The reverse order would leave written keys nobody owns.
  await replaceFile(location.markerPath, serialize(marker), previous?.file);
  try {
    await replaceFile(
      location.settingsPath,
      serialize({ ...settings, env: { ...env, ...applied } }),
      original,
      // A live proxy key must not stay readable by other local users.
      input.credential === 'existing' ? 0o600 : undefined,
    );
  } catch (error) {
    try {
      if (previous === undefined) await removeMarker(location);
      else await replaceFile(location.markerPath, previous.file.text, await readRegular(location.markerPath));
    } catch {
      // Best-effort rollback must not replace the original failure.
    }
    throw error;
  }
  return 'configured';
}

async function removeMarker(location: ClaudeCodeLocation): Promise<void> {
  await rm(location.markerPath, { force: true });
  // Only an empty directory goes; anything the user put next to the marker stays.
  await rmdir(dirname(location.markerPath)).catch(() => undefined);
}

export async function removeClaudeCodeSettings(
  location: ClaudeCodeLocation,
): Promise<{ readonly status: 'removed' | 'partial' | 'absent'; readonly preservedPaths: readonly string[] }> {
  const marker = (await readMarker(location))?.marker;
  if (marker === undefined) return { status: 'absent', preservedPaths: [] };
  const original = await readRegular(location.settingsPath);
  const parsed = parseSettings(original?.text);
  const env = { ...parsed.env };
  const preserved: ManagedKey[] = [];
  let restored = false;
  for (const key of MANAGED_KEYS) {
    const { before } = marker.fields[key];
    if (isEqual(slotOf(parsed.env, key), before)) continue;
    if (!isApplied(parsed.env, key, marker)) {
      preserved.push(key);
      continue;
    }
    if (before.present) env[key] = before.value;
    else delete env[key];
    restored = true;
  }
  if (restored) {
    const next =
      marker.createdEnv && Object.keys(env).length === 0 ? omit(parsed.settings, ['env']) : { ...parsed.settings, env };
    await replaceFile(location.settingsPath, serialize(next), original);
  }
  await removeMarker(location);
  return { status: preserved.length === 0 ? 'removed' : 'partial', preservedPaths: pathsOf(preserved) };
}
