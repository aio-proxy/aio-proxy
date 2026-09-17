import { ProviderProtocol } from '@aio-proxy/types';

import type { TestProtocolContext, TestProtocolRequest } from './types';
export declare function createProtocolContext(): TestProtocolContext;
export declare function defineProtocolAdapter(
  protocol?: ProviderProtocol,
  options?: {
    readonly modelInvocationError?: Error;
    readonly onModelEgress?: (value: unknown) => void;
    readonly parseError?: Error;
  },
): import('@aio-proxy/core').ProtocolAdapter<TestProtocolRequest, TestProtocolContext>;
//# sourceMappingURL=adapter.d.ts.map
