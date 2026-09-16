import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { definePlugin, zod, type SyncBackendDefinition } from '@aio-proxy/plugin-sdk';

import { ensureNativeArtifact, NativeManifestSchema, type NativeManifest } from './native-artifact';
import { connectNative } from './native-session';

export interface CloudKitOptions {
  containerId: string;
}

const backend: SyncBackendDefinition<CloudKitOptions> = {
  id: 'cloudkit',
  displayName: 'iCloud',
  options: { schema: zod.object({ containerId: zod.string().default('iCloud.dev.aioproxy') }), form: [] },
  async connect(options, context) {
    const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const manifest = NativeManifestSchema.parse(
      await Bun.file(join(packageRoot, 'dist/native/manifest.json')).json(),
    ) as NativeManifest;
    const artifact = await ensureNativeArtifact({
      packageRoot,
      cacheRoot: join(context.dataDirectory, 'native'),
      manifest,
      signal: context.signal,
    });
    return connectNative({ executable: artifact.executable, containerId: options.containerId, signal: context.signal });
  },
};

export default definePlugin((api) => api.sync.register(backend));
