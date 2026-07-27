import { join } from 'node:path';

import { createLogger } from '@aio-proxy/logger';
import { file } from 'bun';
import { z } from 'zod';

import { tmpDir } from '../paths/paths';

const cacheItemSchema = z.object({
  value: z.unknown(),
  updatedAt: z.iso.datetime(),
});

interface GetCacheOptions<T = unknown> {
  ttl?: number;
  schema?: z.ZodType<T>;
}

class FileCacheStorage {
  #getFilePath(key: string): string {
    // encodeURIComponent strips path separators, so keys cannot escape the dir.
    return join(tmpDir(), 'cache-storage', `${encodeURIComponent(key)}.json`);
  }

  #logger = createLogger(['cache-storage', 'file']);

  async setItem(key: string, value: unknown) {
    const filePath = this.#getFilePath(key);
    await file(filePath).write(
      JSON.stringify({
        value,
        updatedAt: new Date().toISOString(),
      }),
    );
  }
  async getItem<T = unknown>(key: string, options?: GetCacheOptions<T>): Promise<T | null> {
    const filePath = this.#getFilePath(key);

    try {
      const cacheItem = await file(filePath).json();
      const { success, data, error } = cacheItemSchema.safeParse(cacheItem);
      if (!success) {
        this.#logger.warn(`Invalid cache item for key {key}: {error}`, {
          key,
          error: z.prettifyError(error),
        });
        return null;
      }
      const { value, updatedAt } = data;
      const { ttl, schema } = options ?? {};
      if (ttl && new Date(updatedAt).getTime() + ttl < Date.now()) {
        this.#logger.info(`Cache item for key {key} has expired`, { key });
        return null;
      }
      if (schema) {
        const { success: schemaSuccess, data: schemaData, error: schemaError } = schema.safeParse(value);
        if (!schemaSuccess) {
          this.#logger.warn(`Invalid cache item for key {key}: {error}`, {
            key,
            error: z.prettifyError(schemaError),
          });
          return null;
        }
        return schemaData;
      }
      return value as T;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return null;
      }
      if (error instanceof SyntaxError) {
        this.#logger.warn(`Malformed cache file for key {key}: {error}`, {
          key,
          error: error.message,
        });
        return null;
      }
      throw error;
    }
  }
  async removeItem(key: string) {
    const filePath = this.#getFilePath(key);
    try {
      await file(filePath).delete();
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

export const fileCacheStorage = new FileCacheStorage();
