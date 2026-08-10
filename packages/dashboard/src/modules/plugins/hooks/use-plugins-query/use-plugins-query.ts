import { useQuery } from '@tanstack/react-query';

import { pluginEditViewQueryOptions, pluginsQueryOptions } from '../../services/plugins-service';

export const usePluginsQuery = () => useQuery(pluginsQueryOptions());

export const usePluginEditViewQuery = (packageName: string | null) =>
  useQuery({
    ...pluginEditViewQueryOptions(packageName ?? ''),
    enabled: packageName !== null,
  });
