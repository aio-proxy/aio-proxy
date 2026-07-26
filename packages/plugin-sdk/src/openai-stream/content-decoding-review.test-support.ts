import { createRequire } from 'node:module';
import type { Transform } from 'node:stream';
import type * as Zlib from 'node:zlib';

const require = createRequire(import.meta.url);
export const actualZlib = require('node:zlib') as typeof Zlib;
export const actualCreateGunzip = actualZlib.createGunzip.bind(actualZlib);
export const actualCreateBrotliDecompress = actualZlib.createBrotliDecompress.bind(
  actualZlib,
) as typeof actualZlib.createBrotliDecompress;

export const DELAYED_ERROR_MARKER = Uint8Array.of(0x5b, 0xae, 0x03, 0x04);
export const DELAYED_ERROR = new Error('between-operations decoder failure');
export const trackedStages: Transform[] = [];
export const destroyCounts = new WeakMap<Transform, number>();

export function trackStage<T extends Transform>(stage: T): T {
  const originalDestroy = stage.destroy.bind(stage);
  stage.destroy = ((error?: Error) => {
    destroyCounts.set(stage, (destroyCounts.get(stage) ?? 0) + 1);
    return originalDestroy(error);
  }) as typeof stage.destroy;
  trackedStages.push(stage);
  return stage;
}
