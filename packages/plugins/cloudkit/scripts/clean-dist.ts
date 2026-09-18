import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

await unlink(join(import.meta.dir, '../dist/static/assets/fake-native.ts')).catch(() => undefined);
