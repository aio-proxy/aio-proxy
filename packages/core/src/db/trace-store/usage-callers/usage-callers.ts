import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import type { UsageCaller } from '@aio-proxy/types';
import { eq } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { usageCaller, usageCallerCredential, usageIdentitySecret } from '../../schema';

export function resolveUsageCaller(
  db: BunSQLiteDatabase,
  entry: { readonly key: string; readonly label?: string; readonly id?: string },
): UsageCaller {
  return db.transaction((tx) => {
    let secret = tx.select().from(usageIdentitySecret).where(eq(usageIdentitySecret.id, 'caller')).get()?.secret;
    if (secret === undefined) {
      secret = randomBytes(32).toString('hex');
      tx.insert(usageIdentitySecret).values({ id: 'caller', secret }).run();
    }
    // A database-specific HMAC identifies legacy credentials across restarts without exposing
    // an offline verifier of short authored keys. Only random caller IDs leave the database.
    const fingerprint = createHmac('sha256', secret).update(entry.key).digest('hex');
    const previous = tx
      .select()
      .from(usageCallerCredential)
      .where(eq(usageCallerCredential.fingerprint, fingerprint))
      .get();
    const id = entry.id ?? previous?.callerId ?? randomUUID();
    const old = tx.select().from(usageCaller).where(eq(usageCaller.id, id)).get();
    const caller: UsageCaller = {
      id,
      kind: 'key',
      label: entry.label?.trim() || old?.label || `Key ${id.slice(0, 8)}`,
    };
    tx.insert(usageCaller).values(caller).onConflictDoUpdate({ target: usageCaller.id, set: caller }).run();
    tx.insert(usageCallerCredential)
      .values({ fingerprint, callerId: id })
      .onConflictDoUpdate({ target: usageCallerCredential.fingerprint, set: { callerId: id } })
      .run();
    return caller;
  });
}

export function usageCallers(db: BunSQLiteDatabase): UsageCaller[] {
  return db
    .select()
    .from(usageCaller)
    .all()
    .map((row) => ({ ...row, kind: row.kind as UsageCaller['kind'] }));
}
