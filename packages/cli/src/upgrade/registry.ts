import { fetchLatestNpmVersion } from '@aio-proxy/core';

import { PACKAGE } from './constants';

export const fetchLatestVersion = async (registry: string, fetchImpl: typeof fetch = fetch): Promise<string> =>
  fetchLatestNpmVersion(PACKAGE, registry, fetchImpl);
