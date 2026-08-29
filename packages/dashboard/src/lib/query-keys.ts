/**
 * Every dashboard query key, in one place.
 *
 * TanStack Query resolves keys against a single QueryClient, so keys are a global
 * namespace regardless of which module declares them. Declaring them per module
 * meant `['providers']` existed in six places with nothing checking they agreed,
 * and let a module reach into another module's service just to invalidate a cache.
 */
export const queryKeys = {
  auth: ['dashboard-auth'],
  modelsDevLookup: (id: string) => ['models-dev-lookup', id],
  modelsDevSlugs: ['models-dev-slugs'],
  oauthCapabilities: ['oauth-capabilities'],
  oauthSession: (id: string) => ['oauth-session', id],
  overviewActivity: ['dashboard', 'overview', 'activity'],
  overviewDiagnostics: (range: string) => ['dashboard', 'overview', 'diagnostics', range],
  overviewRange: (range: string) => ['dashboard', 'overview', 'range', range],
  pluginEditView: (packageName: string) => ['plugins', packageName, 'edit-view'],
  plugins: ['plugins'],
  providerEditView: (id: string) => ['providers', id, 'edit-view'],
  providerPackageStatus: (packageName: string) => ['providers', 'package-status', packageName],
  providerProbe: (id: string) => ['providers', id, 'probe'],
  providerUsage: ['dashboard', 'providers', 'usage'],
  providers: ['providers'],
  routingModels: ['routing', 'models'],
  settings: ['settings'],
  // Search shape stays structural: src/lib must not depend on a module's types.
  trace: (traceId: string) => ['dashboard', 'traces', traceId],
  traces: (search: object) => ['dashboard', 'traces', search],
  usage: (range: string, metric: string, groupBy: string, maxResults?: number) => [
    'dashboard',
    'usage',
    range,
    metric,
    groupBy,
    maxResults,
  ],
} as const;
