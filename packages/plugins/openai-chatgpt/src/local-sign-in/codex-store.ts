import { open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { type OAuthLocalSignIn, zod } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';
import { decodeJwt } from 'jose';

import { extractAccountId, extractEmail } from '../jwt';
import type { ChatGPTCredential } from '../schema';

const codexStoreSchema = zod
  .object({
    auth_mode: zod
      .string()
      .regex(/^chatgpt/)
      .optional(),
    tokens: zod
      .object({
        access_token: zod.string().min(1),
        refresh_token: zod.string().min(1),
        id_token: zod.string().optional(),
        account_id: zod.string().min(1).optional(),
      })
      .loose(),
  })
  .loose();

type CodexStore = zod.infer<typeof codexStoreSchema>;

export class CodexSignInInvalidError extends Error {
  override readonly name = 'CodexSignInInvalidError';

  constructor() {
    super('Codex local sign-in is invalid or incomplete');
  }
}

export function codexHome(env: Record<string, string | undefined> = process.env): string {
  return env['CODEX_HOME'] ?? join(homedir(), '.codex');
}

export function createCodexLocalSignIn(
  input: { readonly home?: () => string; readonly now?: () => number } = {},
): OAuthLocalSignIn<Record<string, unknown>, ChatGPTCredential> {
  const home = input.home ?? codexHome;
  const now = input.now ?? Date.now;
  return {
    source: 'Codex',
    detect: async () => Bun.file(join(home(), 'auth.json')).exists(),
    read: async () => {
      try {
        const store = await readCodexStore(join(home(), 'auth.json'));
        if (store === undefined) throw new CodexSignInInvalidError();
        const { tokens } = store;
        const accountId = codexAccountId(store);
        const exp = decodeJwt(tokens.access_token).exp;
        const expiresAt = typeof exp === 'number' ? exp * 1_000 : Number.NaN;
        if (accountId === undefined || !Number.isFinite(expiresAt)) throw new CodexSignInInvalidError();
        const email =
          (tokens.id_token === undefined ? undefined : extractEmail(tokens.id_token)) ??
          extractEmail(tokens.access_token);
        return {
          fingerprint: accountId,
          suggestedKey: `chatgpt-${accountId}`,
          accountLabel: email ?? accountId,
          credentials: {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            accountId,
            expiresAt,
            ...(tokens.id_token === undefined ? {} : { idToken: tokens.id_token }),
            ...(email === undefined ? {} : { email }),
          },
          expiresAt,
        };
      } catch {
        // Parsing and filesystem errors can carry host-store contents or paths.
        throw new CodexSignInInvalidError();
      }
    },
    write: async (_context, next, previous) => {
      try {
        const path = await realpath(join(home(), 'auth.json'));
        const store = await readCodexStore(path);
        if (!holdsPrevious(store, previous)) return;
        const updated = {
          ...store,
          tokens: {
            ...store.tokens,
            access_token: next.accessToken,
            refresh_token: next.refreshToken,
            id_token: next.idToken ?? store.tokens.id_token,
            account_id: next.accountId,
          },
          last_refresh: new Date(now()).toISOString(),
        };
        const temporary = join(dirname(path), `.auth.json.${crypto.randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try {
          try {
            await Bun.write(Bun.file(file.fd), JSON.stringify(updated));
          } finally {
            await file.close();
          }
          // Codex has no shared lock: recheck at the last await before atomic replacement.
          if (!holdsPrevious(await readCodexStore(path), previous)) return;
          await rename(temporary, path);
        } finally {
          await unlink(temporary).catch(() => {});
        }
      } catch {
        throw new CodexSignInInvalidError();
      }
    },
  };
}

async function readCodexStore(path: string): Promise<CodexStore | undefined> {
  try {
    const raw: unknown = await Bun.file(path).json();
    if (!isPlainObject(raw)) return undefined;
    const result = codexStoreSchema.safeParse(raw);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function codexAccountId(store: CodexStore): string | undefined {
  return (
    store.tokens.account_id ??
    extractAccountId(store.tokens.access_token) ??
    (store.tokens.id_token === undefined ? undefined : extractAccountId(store.tokens.id_token))
  );
}

function holdsPrevious(store: CodexStore | undefined, previous: ChatGPTCredential): store is CodexStore {
  return (
    store !== undefined &&
    codexAccountId(store) === previous.accountId &&
    store.tokens.refresh_token === previous.refreshToken
  );
}
