import { lt } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { requestLog } from '../schema/request-log';
import { usage } from '../schema/usage';
import { listRequestLogs } from './list';
import { overviewRequestLogs } from './overview';
import type { RequestLogStore } from './types';

export function createRequestLogStore(db: BunSQLiteDatabase): RequestLogStore {
  return {
    insertFinal(input) {
      if (input.usage !== undefined && input.outcome !== 'success') {
        throw new Error('Only successful requests can include usage');
      }
      if (
        input.usage !== undefined &&
        (input.usage.providerId !== input.finalProviderId || input.usage.modelId !== input.finalModelId)
      ) {
        throw new Error('Usage provider and model must match the final route');
      }
      db.transaction((tx) => {
        const { usage: usageRow, ...terminal } = input;
        tx.insert(requestLog).values(terminal).run();
        if (usageRow !== undefined) {
          tx.insert(usage)
            .values({
              id: input.requestId,
              requestId: input.requestId,
              ...usageRow,
              createdAt: input.completedAt,
            })
            .run();
        }
      });
    },
    list(query) {
      return listRequestLogs(db, query);
    },
    overview(query) {
      return overviewRequestLogs(db, query);
    },
    prune(cutoff) {
      db.transaction((tx) => {
        tx.delete(usage).where(lt(usage.createdAt, cutoff)).run();
        tx.delete(requestLog).where(lt(requestLog.completedAt, cutoff)).run();
      });
    },
  };
}
