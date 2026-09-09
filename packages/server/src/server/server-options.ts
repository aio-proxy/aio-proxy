import type { BuiltInPluginDefinition } from '@aio-proxy/core';
import type { Config } from '@aio-proxy/types';

import type { DashboardEventLimits } from '../dashboard-events';
import type { RuntimeProviderInput } from '../runtime';
import type { ServerLogSink } from '../server-log';
import type { InternalServerStateOptions, ServerStateTestHooks } from '../server-state/types';

export type ServerOptionsBase = {
  readonly config: unknown;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly port?: number;
  readonly host?: string;
  readonly dashboardAssets?: import('../dashboard-assets').DashboardAssets;
  readonly logger?: ServerLogSink;
  readonly watchConfig?: boolean;
  readonly builtIns?: readonly BuiltInPluginDefinition[];
  readonly version?: string;
  readonly autoUpdate?: {
    readonly isManagedService: () => boolean;
    readonly applyUpdate: (version: string) => Promise<'installed' | 'unchanged'>;
    readonly notifyAvailable?: (latest: string) => void | Promise<void>;
    readonly fetchLatest?: (pkg: string) => Promise<string>;
  };
};

export function createServerStateOptions(input: {
  readonly config: Config;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly logger?: ServerLogSink;
  readonly watchConfig?: boolean;
  readonly builtIns?: readonly BuiltInPluginDefinition[];
  readonly dashboardAuthHealthChanged: (available: boolean) => void;
  readonly testHooks?: ServerStateTestHooks;
}): InternalServerStateOptions {
  return {
    config: input.config,
    __dashboardAuthHealthChanged: input.dashboardAuthHealthChanged,
    ...(input.testHooks === undefined ? {} : { __test: input.testHooks }),
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    ...(input.dbHome === undefined ? {} : { dbHome: input.dbHome }),
    ...(input.eventLimits === undefined ? {} : { eventLimits: input.eventLimits }),
    ...(input.providerInstances === undefined ? {} : { providerInstances: input.providerInstances }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    ...(input.watchConfig === undefined ? {} : { watchConfig: input.watchConfig }),
    ...(input.builtIns === undefined ? {} : { builtIns: input.builtIns }),
  };
}
