import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const tryRealpath = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

const isInsideLexical = (filePath: string, dir: string): boolean => {
  const rel = relative(resolve(dir), resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export const isPathInDirectory = (filePath: string, dir: string): boolean => {
  if (isInsideLexical(filePath, dir)) return true;
  const dirReal = tryRealpath(resolve(dir));
  if (dirReal === undefined) return false;
  const fileReal = tryRealpath(resolve(filePath));
  if (fileReal !== undefined && isInsideLexical(fileReal, dirReal)) return true;
  const parentReal = tryRealpath(dirname(resolve(filePath)));
  if (parentReal === undefined) return false;
  return isInsideLexical(join(parentReal, basename(filePath)), dirReal);
};
