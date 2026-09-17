import { type ModelEventStream, Router } from '@aio-proxy/core';
import { type Config, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { LogicalSessionStore } from '../../src/logical-session-store';
import { ProviderCooldownStore } from '../../src/routes/pipeline/provider-cooldown';
import type { ModelTransport, ProviderRouteSource, RawTransport, RuntimeProviderInstance } from '../../src/runtime';
import {
  type EmbeddingUsageOptions,
  type PassthroughUsageOptions,
  type StreamUsageOptions,
  type UsageCapture,
  type UsageCompletion,
} from '../../src/usage-capture';
import { type FakeProvider } from './types';
export declare function rawProvider(options: {
  readonly id: string;
  readonly invoke?: RawTransport['invoke'];
  readonly model?: {
    readonly ensureAvailable?: () => Promise<void>;
    readonly invoke: ModelTransport['invoke'];
  };
  readonly modelId?: string;
  readonly protocol?: ProviderProtocol;
  readonly priority?: number;
  readonly weight?: number;
}): FakeProvider;
export declare function modelProvider(options: {
  readonly ensureAvailable?: () => Promise<void>;
  readonly id: string;
  readonly invoke: ModelTransport['invoke'];
  readonly modelId?: string;
  readonly targetProtocol?: ProviderProtocol;
  readonly priority?: number;
  readonly weight?: number;
}): FakeProvider;
export declare function defineProviderRouteSource(
  fixtures: readonly FakeProvider[],
  immediateStreamCompletion?: UsageCompletion,
  debugLogging?: boolean,
  routing?: {
    readonly config?: Config;
    readonly random?: () => number;
  },
): {
  logs: unknown[];
  recording: import('./types').Recording & {
    readonly recorder: import('../../src/request-tracing').RequestTraceRecorder;
  };
  source: {
    acquireProviderSnapshot: () => {
      snapshot: {
        providers: RuntimeProviderInstance[];
        router: Router<RuntimeProviderInstance>;
        config?:
          | {
              server: {
                host: string;
                port: number;
                apiKeys: {
                  key: string;
                  label?: string | undefined;
                }[];
                password?: string | undefined;
                logging?:
                  | {
                      enabled: boolean;
                      dir?: string | undefined;
                      retentionDays: number;
                      level: 'debug' | 'error' | 'info' | 'warn';
                    }
                  | undefined;
                retry: {
                  retryAfterCapMs: number;
                };
                requireApiKey: boolean;
              };
              plugins: (
                | {
                    packageName: string;
                    options?: undefined;
                  }
                | {
                    packageName: string;
                    options: unknown;
                  }
              )[];
              proxy: string | undefined;
              proxyBackup?: string | undefined;
              proxyFallback?: boolean | undefined;
              router: {
                modelContextAggregation: 'max' | 'min';
                models: Record<
                  string,
                  {
                    metadata?:
                      | {
                          [x: string]: unknown;
                          name?: string | undefined;
                          description?: string | undefined;
                          extend?: string | undefined;
                          limit?:
                            | {
                                [x: string]: unknown;
                                context?: number | undefined;
                                input?: number | undefined;
                                output?: number | undefined;
                              }
                            | undefined;
                          capabilities?:
                            | {
                                [x: string]: unknown;
                                reasoning?: boolean | undefined;
                                temperature?: boolean | undefined;
                                toolCall?: boolean | undefined;
                                attachment?: boolean | undefined;
                                structuredOutput?: boolean | undefined;
                                reasoningOptions?:
                                  | (
                                      | {
                                          [x: string]: unknown;
                                          type: 'toggle';
                                        }
                                      | {
                                          [x: string]: unknown;
                                          type: 'effort';
                                          values: (
                                            | 'default'
                                            | 'high'
                                            | 'low'
                                            | 'max'
                                            | 'medium'
                                            | 'minimal'
                                            | 'none'
                                            | 'xhigh'
                                            | null
                                          )[];
                                        }
                                      | {
                                          [x: string]: unknown;
                                          type: 'budgetTokens';
                                          min?: number | undefined;
                                          max?: number | undefined;
                                        }
                                    )[]
                                  | undefined;
                                modalities?:
                                  | {
                                      [x: string]: unknown;
                                      input?: ('audio' | 'image' | 'pdf' | 'text' | 'video')[] | undefined;
                                      output?: ('audio' | 'image' | 'pdf' | 'text' | 'video')[] | undefined;
                                    }
                                  | undefined;
                                knowledge?: string | undefined;
                                releaseDate?: string | undefined;
                                lastUpdated?: string | undefined;
                              }
                            | undefined;
                          cost?:
                            | {
                                [x: string]: unknown;
                                input?: number | undefined;
                                output?: number | undefined;
                                cacheRead?: number | undefined;
                                cacheWrite?: number | undefined;
                                reasoning?: number | undefined;
                                inputAudio?: number | undefined;
                                outputAudio?: number | undefined;
                                image?: number | undefined;
                                webSearch?: number | undefined;
                                request?: number | undefined;
                                tiers?:
                                  | {
                                      input?: number | undefined;
                                      output?: number | undefined;
                                      cacheRead?: number | undefined;
                                      cacheWrite?: number | undefined;
                                      reasoning?: number | undefined;
                                      inputAudio?: number | undefined;
                                      outputAudio?: number | undefined;
                                      tier: {
                                        type: 'context';
                                        size: number;
                                      };
                                    }[]
                                  | undefined;
                              }
                            | undefined;
                        }
                      | undefined;
                    providers: Record<
                      string,
                      {
                        priority?: number | undefined;
                        weight?: number | undefined;
                        cost?:
                          | {
                              [x: string]: unknown;
                              input?: number | undefined;
                              output?: number | undefined;
                              cacheRead?: number | undefined;
                              cacheWrite?: number | undefined;
                              reasoning?: number | undefined;
                              inputAudio?: number | undefined;
                              outputAudio?: number | undefined;
                              image?: number | undefined;
                              webSearch?: number | undefined;
                              request?: number | undefined;
                              tiers?:
                                | {
                                    input?: number | undefined;
                                    output?: number | undefined;
                                    cacheRead?: number | undefined;
                                    cacheWrite?: number | undefined;
                                    reasoning?: number | undefined;
                                    inputAudio?: number | undefined;
                                    outputAudio?: number | undefined;
                                    tier: {
                                      type: 'context';
                                      size: number;
                                    };
                                  }[]
                                | undefined;
                            }
                          | undefined;
                        limit?:
                          | {
                              [x: string]: unknown;
                              context?: number | undefined;
                              input?: number | undefined;
                              output?: number | undefined;
                            }
                          | undefined;
                      }
                    >;
                  }
                >;
              };
              providers: (
                | {
                    id: string;
                    enabled: boolean;
                    priority: number;
                    weight: number;
                    name?: string | undefined;
                    transforms?:
                      | {
                          request: {
                            name?: string | undefined;
                            when?: Record<string, import('zod').JSONType> | undefined;
                            update: Record<string, import('zod').JSONType>[];
                          }[];
                        }
                      | undefined;
                    models?: string[] | undefined;
                    alias?:
                      | Record<
                          string,
                          {
                            model: string;
                            preserve: boolean;
                            variants?:
                              | {
                                  when: {
                                    effort?: string | undefined;
                                    thinking?: boolean | undefined;
                                    speed?: 'fast' | 'flex' | 'standard' | undefined;
                                  };
                                  model: string;
                                  preserve: boolean;
                                }[]
                              | {
                                  when: {
                                    effort: string;
                                  };
                                  model: string;
                                  preserve: boolean;
                                }[]
                              | undefined;
                          }
                        >
                      | undefined;
                    kind: ProviderKind.Api;
                    protocol?: import('@aio-proxy/types').ProviderProtocol | undefined;
                    apiKey?: string | undefined;
                    headers?: Readonly<Record<string, string>> | undefined;
                    endpoints?:
                      | {
                          protocol: import('@aio-proxy/types').ProviderProtocol;
                          baseURL: string;
                          auth?: 'bearer' | 'x-api-key' | undefined;
                        }[]
                      | {
                          baseURL: string;
                          protocol: import('@aio-proxy/types').ProviderProtocol[];
                        }
                      | undefined;
                    baseURL?: string | undefined;
                    proxy?: string | false | undefined;
                    proxyBackup?: string | undefined;
                    proxyFallback?: boolean | undefined;
                  }
                | {
                    id: string;
                    enabled: boolean;
                    priority: number;
                    weight: number;
                    name?: string | undefined;
                    transforms?:
                      | {
                          request: {
                            name?: string | undefined;
                            when?: Record<string, import('zod').JSONType> | undefined;
                            update: Record<string, import('zod').JSONType>[];
                          }[];
                        }
                      | undefined;
                    excludedModels?: string[] | undefined;
                    alias?:
                      | Record<
                          string,
                          | false
                          | {
                              model: string;
                              preserve: boolean;
                              variants?:
                                | {
                                    when: {
                                      effort?: string | undefined;
                                      thinking?: boolean | undefined;
                                      speed?: 'fast' | 'flex' | 'standard' | undefined;
                                    };
                                    model: string;
                                    preserve: boolean;
                                  }[]
                                | {
                                    when: {
                                      effort: string;
                                    };
                                    model: string;
                                    preserve: boolean;
                                  }[]
                                | undefined;
                            }
                        >
                      | undefined;
                    kind: ProviderKind.OAuth;
                    plugin: string;
                    capability: string;
                    options?: Record<string, unknown> | undefined;
                    proxy?: string | false | undefined;
                    proxyBackup?: string | undefined;
                    proxyFallback?: boolean | undefined;
                  }
                | {
                    id: string;
                    enabled: boolean;
                    priority: number;
                    weight: number;
                    name?: string | undefined;
                    transforms?:
                      | {
                          request: {
                            name?: string | undefined;
                            when?: Record<string, import('zod').JSONType> | undefined;
                            update: Record<string, import('zod').JSONType>[];
                          }[];
                        }
                      | undefined;
                    models?: string[] | undefined;
                    alias?:
                      | Record<
                          string,
                          {
                            model: string;
                            preserve: boolean;
                            variants?:
                              | {
                                  when: {
                                    effort?: string | undefined;
                                    thinking?: boolean | undefined;
                                    speed?: 'fast' | 'flex' | 'standard' | undefined;
                                  };
                                  model: string;
                                  preserve: boolean;
                                }[]
                              | {
                                  when: {
                                    effort: string;
                                  };
                                  model: string;
                                  preserve: boolean;
                                }[]
                              | undefined;
                          }
                        >
                      | undefined;
                    kind: ProviderKind.AiSdk;
                    packageName: string;
                    options?: Record<string, unknown> | undefined;
                    parseReasoningContent?: boolean | undefined;
                    proxy?: string | false | undefined;
                    proxyBackup?: string | undefined;
                    proxyFallback?: boolean | undefined;
                  }
              )[];
              invalidProviders: import('@aio-proxy/types').InvalidProviderConfig[];
            }
          | undefined;
      };
      release(): void;
    };
    cooldown: ProviderCooldownStore;
    currentProviderSnapshot: () => {
      providers: RuntimeProviderInstance[];
      router: Router<RuntimeProviderInstance>;
      config?:
        | {
            server: {
              host: string;
              port: number;
              apiKeys: {
                key: string;
                label?: string | undefined;
              }[];
              password?: string | undefined;
              logging?:
                | {
                    enabled: boolean;
                    dir?: string | undefined;
                    retentionDays: number;
                    level: 'debug' | 'error' | 'info' | 'warn';
                  }
                | undefined;
              retry: {
                retryAfterCapMs: number;
              };
              requireApiKey: boolean;
            };
            plugins: (
              | {
                  packageName: string;
                  options?: undefined;
                }
              | {
                  packageName: string;
                  options: unknown;
                }
            )[];
            proxy: string | undefined;
            proxyBackup?: string | undefined;
            proxyFallback?: boolean | undefined;
            router: {
              modelContextAggregation: 'max' | 'min';
              models: Record<
                string,
                {
                  metadata?:
                    | {
                        [x: string]: unknown;
                        name?: string | undefined;
                        description?: string | undefined;
                        extend?: string | undefined;
                        limit?:
                          | {
                              [x: string]: unknown;
                              context?: number | undefined;
                              input?: number | undefined;
                              output?: number | undefined;
                            }
                          | undefined;
                        capabilities?:
                          | {
                              [x: string]: unknown;
                              reasoning?: boolean | undefined;
                              temperature?: boolean | undefined;
                              toolCall?: boolean | undefined;
                              attachment?: boolean | undefined;
                              structuredOutput?: boolean | undefined;
                              reasoningOptions?:
                                | (
                                    | {
                                        [x: string]: unknown;
                                        type: 'toggle';
                                      }
                                    | {
                                        [x: string]: unknown;
                                        type: 'effort';
                                        values: (
                                          | 'default'
                                          | 'high'
                                          | 'low'
                                          | 'max'
                                          | 'medium'
                                          | 'minimal'
                                          | 'none'
                                          | 'xhigh'
                                          | null
                                        )[];
                                      }
                                    | {
                                        [x: string]: unknown;
                                        type: 'budgetTokens';
                                        min?: number | undefined;
                                        max?: number | undefined;
                                      }
                                  )[]
                                | undefined;
                              modalities?:
                                | {
                                    [x: string]: unknown;
                                    input?: ('audio' | 'image' | 'pdf' | 'text' | 'video')[] | undefined;
                                    output?: ('audio' | 'image' | 'pdf' | 'text' | 'video')[] | undefined;
                                  }
                                | undefined;
                              knowledge?: string | undefined;
                              releaseDate?: string | undefined;
                              lastUpdated?: string | undefined;
                            }
                          | undefined;
                        cost?:
                          | {
                              [x: string]: unknown;
                              input?: number | undefined;
                              output?: number | undefined;
                              cacheRead?: number | undefined;
                              cacheWrite?: number | undefined;
                              reasoning?: number | undefined;
                              inputAudio?: number | undefined;
                              outputAudio?: number | undefined;
                              image?: number | undefined;
                              webSearch?: number | undefined;
                              request?: number | undefined;
                              tiers?:
                                | {
                                    input?: number | undefined;
                                    output?: number | undefined;
                                    cacheRead?: number | undefined;
                                    cacheWrite?: number | undefined;
                                    reasoning?: number | undefined;
                                    inputAudio?: number | undefined;
                                    outputAudio?: number | undefined;
                                    tier: {
                                      type: 'context';
                                      size: number;
                                    };
                                  }[]
                                | undefined;
                            }
                          | undefined;
                      }
                    | undefined;
                  providers: Record<
                    string,
                    {
                      priority?: number | undefined;
                      weight?: number | undefined;
                      cost?:
                        | {
                            [x: string]: unknown;
                            input?: number | undefined;
                            output?: number | undefined;
                            cacheRead?: number | undefined;
                            cacheWrite?: number | undefined;
                            reasoning?: number | undefined;
                            inputAudio?: number | undefined;
                            outputAudio?: number | undefined;
                            image?: number | undefined;
                            webSearch?: number | undefined;
                            request?: number | undefined;
                            tiers?:
                              | {
                                  input?: number | undefined;
                                  output?: number | undefined;
                                  cacheRead?: number | undefined;
                                  cacheWrite?: number | undefined;
                                  reasoning?: number | undefined;
                                  inputAudio?: number | undefined;
                                  outputAudio?: number | undefined;
                                  tier: {
                                    type: 'context';
                                    size: number;
                                  };
                                }[]
                              | undefined;
                          }
                        | undefined;
                      limit?:
                        | {
                            [x: string]: unknown;
                            context?: number | undefined;
                            input?: number | undefined;
                            output?: number | undefined;
                          }
                        | undefined;
                    }
                  >;
                }
              >;
            };
            providers: (
              | {
                  id: string;
                  enabled: boolean;
                  priority: number;
                  weight: number;
                  name?: string | undefined;
                  transforms?:
                    | {
                        request: {
                          name?: string | undefined;
                          when?: Record<string, import('zod').JSONType> | undefined;
                          update: Record<string, import('zod').JSONType>[];
                        }[];
                      }
                    | undefined;
                  models?: string[] | undefined;
                  alias?:
                    | Record<
                        string,
                        {
                          model: string;
                          preserve: boolean;
                          variants?:
                            | {
                                when: {
                                  effort?: string | undefined;
                                  thinking?: boolean | undefined;
                                  speed?: 'fast' | 'flex' | 'standard' | undefined;
                                };
                                model: string;
                                preserve: boolean;
                              }[]
                            | {
                                when: {
                                  effort: string;
                                };
                                model: string;
                                preserve: boolean;
                              }[]
                            | undefined;
                        }
                      >
                    | undefined;
                  kind: ProviderKind.Api;
                  protocol?: import('@aio-proxy/types').ProviderProtocol | undefined;
                  apiKey?: string | undefined;
                  headers?: Readonly<Record<string, string>> | undefined;
                  endpoints?:
                    | {
                        protocol: import('@aio-proxy/types').ProviderProtocol;
                        baseURL: string;
                        auth?: 'bearer' | 'x-api-key' | undefined;
                      }[]
                    | {
                        baseURL: string;
                        protocol: import('@aio-proxy/types').ProviderProtocol[];
                      }
                    | undefined;
                  baseURL?: string | undefined;
                  proxy?: string | false | undefined;
                  proxyBackup?: string | undefined;
                  proxyFallback?: boolean | undefined;
                }
              | {
                  id: string;
                  enabled: boolean;
                  priority: number;
                  weight: number;
                  name?: string | undefined;
                  transforms?:
                    | {
                        request: {
                          name?: string | undefined;
                          when?: Record<string, import('zod').JSONType> | undefined;
                          update: Record<string, import('zod').JSONType>[];
                        }[];
                      }
                    | undefined;
                  excludedModels?: string[] | undefined;
                  alias?:
                    | Record<
                        string,
                        | false
                        | {
                            model: string;
                            preserve: boolean;
                            variants?:
                              | {
                                  when: {
                                    effort?: string | undefined;
                                    thinking?: boolean | undefined;
                                    speed?: 'fast' | 'flex' | 'standard' | undefined;
                                  };
                                  model: string;
                                  preserve: boolean;
                                }[]
                              | {
                                  when: {
                                    effort: string;
                                  };
                                  model: string;
                                  preserve: boolean;
                                }[]
                              | undefined;
                          }
                      >
                    | undefined;
                  kind: ProviderKind.OAuth;
                  plugin: string;
                  capability: string;
                  options?: Record<string, unknown> | undefined;
                  proxy?: string | false | undefined;
                  proxyBackup?: string | undefined;
                  proxyFallback?: boolean | undefined;
                }
              | {
                  id: string;
                  enabled: boolean;
                  priority: number;
                  weight: number;
                  name?: string | undefined;
                  transforms?:
                    | {
                        request: {
                          name?: string | undefined;
                          when?: Record<string, import('zod').JSONType> | undefined;
                          update: Record<string, import('zod').JSONType>[];
                        }[];
                      }
                    | undefined;
                  models?: string[] | undefined;
                  alias?:
                    | Record<
                        string,
                        {
                          model: string;
                          preserve: boolean;
                          variants?:
                            | {
                                when: {
                                  effort?: string | undefined;
                                  thinking?: boolean | undefined;
                                  speed?: 'fast' | 'flex' | 'standard' | undefined;
                                };
                                model: string;
                                preserve: boolean;
                              }[]
                            | {
                                when: {
                                  effort: string;
                                };
                                model: string;
                                preserve: boolean;
                              }[]
                            | undefined;
                        }
                      >
                    | undefined;
                  kind: ProviderKind.AiSdk;
                  packageName: string;
                  options?: Record<string, unknown> | undefined;
                  parseReasoningContent?: boolean | undefined;
                  proxy?: string | false | undefined;
                  proxyBackup?: string | undefined;
                  proxyFallback?: boolean | undefined;
                }
            )[];
            invalidProviders: import('@aio-proxy/types').InvalidProviderConfig[];
          }
        | undefined;
    };
    debugLogging?: boolean | undefined;
    logger: (entry: import('../../src').ServerLog) => number;
    logicalSessionStore: LogicalSessionStore;
    requestRecorder: import('../../src/request-tracing').RequestTraceRecorder;
    usageCapture: UsageCapture;
  };
  usage: {
    capturedStreams: ModelEventStream[];
    embedding: EmbeddingUsageOptions[];
    passthrough: PassthroughUsageOptions[];
    stream: StreamUsageOptions[];
  };
};
export declare function withSnapshotConfigs(
  source: ProviderRouteSource,
  acquired: Config,
  current?: {
    server: {
      host: string;
      port: number;
      apiKeys: {
        key: string;
        label?: string | undefined;
      }[];
      password?: string | undefined;
      logging?:
        | {
            enabled: boolean;
            dir?: string | undefined;
            retentionDays: number;
            level: 'debug' | 'error' | 'info' | 'warn';
          }
        | undefined;
      retry: {
        retryAfterCapMs: number;
      };
      requireApiKey: boolean;
    };
    plugins: (
      | {
          packageName: string;
          options?: undefined;
        }
      | {
          packageName: string;
          options: unknown;
        }
    )[];
    proxy: string | undefined;
    proxyBackup?: string | undefined;
    proxyFallback?: boolean | undefined;
    router: {
      modelContextAggregation: 'max' | 'min';
      models: Record<
        string,
        {
          metadata?:
            | {
                [x: string]: unknown;
                name?: string | undefined;
                description?: string | undefined;
                extend?: string | undefined;
                limit?:
                  | {
                      [x: string]: unknown;
                      context?: number | undefined;
                      input?: number | undefined;
                      output?: number | undefined;
                    }
                  | undefined;
                capabilities?:
                  | {
                      [x: string]: unknown;
                      reasoning?: boolean | undefined;
                      temperature?: boolean | undefined;
                      toolCall?: boolean | undefined;
                      attachment?: boolean | undefined;
                      structuredOutput?: boolean | undefined;
                      reasoningOptions?:
                        | (
                            | {
                                [x: string]: unknown;
                                type: 'toggle';
                              }
                            | {
                                [x: string]: unknown;
                                type: 'effort';
                                values: (
                                  | 'default'
                                  | 'high'
                                  | 'low'
                                  | 'max'
                                  | 'medium'
                                  | 'minimal'
                                  | 'none'
                                  | 'xhigh'
                                  | null
                                )[];
                              }
                            | {
                                [x: string]: unknown;
                                type: 'budgetTokens';
                                min?: number | undefined;
                                max?: number | undefined;
                              }
                          )[]
                        | undefined;
                      modalities?:
                        | {
                            [x: string]: unknown;
                            input?: ('audio' | 'image' | 'pdf' | 'text' | 'video')[] | undefined;
                            output?: ('audio' | 'image' | 'pdf' | 'text' | 'video')[] | undefined;
                          }
                        | undefined;
                      knowledge?: string | undefined;
                      releaseDate?: string | undefined;
                      lastUpdated?: string | undefined;
                    }
                  | undefined;
                cost?:
                  | {
                      [x: string]: unknown;
                      input?: number | undefined;
                      output?: number | undefined;
                      cacheRead?: number | undefined;
                      cacheWrite?: number | undefined;
                      reasoning?: number | undefined;
                      inputAudio?: number | undefined;
                      outputAudio?: number | undefined;
                      image?: number | undefined;
                      webSearch?: number | undefined;
                      request?: number | undefined;
                      tiers?:
                        | {
                            input?: number | undefined;
                            output?: number | undefined;
                            cacheRead?: number | undefined;
                            cacheWrite?: number | undefined;
                            reasoning?: number | undefined;
                            inputAudio?: number | undefined;
                            outputAudio?: number | undefined;
                            tier: {
                              type: 'context';
                              size: number;
                            };
                          }[]
                        | undefined;
                    }
                  | undefined;
              }
            | undefined;
          providers: Record<
            string,
            {
              priority?: number | undefined;
              weight?: number | undefined;
              cost?:
                | {
                    [x: string]: unknown;
                    input?: number | undefined;
                    output?: number | undefined;
                    cacheRead?: number | undefined;
                    cacheWrite?: number | undefined;
                    reasoning?: number | undefined;
                    inputAudio?: number | undefined;
                    outputAudio?: number | undefined;
                    image?: number | undefined;
                    webSearch?: number | undefined;
                    request?: number | undefined;
                    tiers?:
                      | {
                          input?: number | undefined;
                          output?: number | undefined;
                          cacheRead?: number | undefined;
                          cacheWrite?: number | undefined;
                          reasoning?: number | undefined;
                          inputAudio?: number | undefined;
                          outputAudio?: number | undefined;
                          tier: {
                            type: 'context';
                            size: number;
                          };
                        }[]
                      | undefined;
                  }
                | undefined;
              limit?:
                | {
                    [x: string]: unknown;
                    context?: number | undefined;
                    input?: number | undefined;
                    output?: number | undefined;
                  }
                | undefined;
            }
          >;
        }
      >;
    };
    providers: (
      | {
          id: string;
          enabled: boolean;
          priority: number;
          weight: number;
          name?: string | undefined;
          transforms?:
            | {
                request: {
                  name?: string | undefined;
                  when?: Record<string, import('zod').JSONType> | undefined;
                  update: Record<string, import('zod').JSONType>[];
                }[];
              }
            | undefined;
          models?: string[] | undefined;
          alias?:
            | Record<
                string,
                {
                  model: string;
                  preserve: boolean;
                  variants?:
                    | {
                        when: {
                          effort?: string | undefined;
                          thinking?: boolean | undefined;
                          speed?: 'fast' | 'flex' | 'standard' | undefined;
                        };
                        model: string;
                        preserve: boolean;
                      }[]
                    | {
                        when: {
                          effort: string;
                        };
                        model: string;
                        preserve: boolean;
                      }[]
                    | undefined;
                }
              >
            | undefined;
          kind: ProviderKind.Api;
          protocol?: import('@aio-proxy/types').ProviderProtocol | undefined;
          apiKey?: string | undefined;
          headers?: Readonly<Record<string, string>> | undefined;
          endpoints?:
            | {
                protocol: import('@aio-proxy/types').ProviderProtocol;
                baseURL: string;
                auth?: 'bearer' | 'x-api-key' | undefined;
              }[]
            | {
                baseURL: string;
                protocol: import('@aio-proxy/types').ProviderProtocol[];
              }
            | undefined;
          baseURL?: string | undefined;
          proxy?: string | false | undefined;
          proxyBackup?: string | undefined;
          proxyFallback?: boolean | undefined;
        }
      | {
          id: string;
          enabled: boolean;
          priority: number;
          weight: number;
          name?: string | undefined;
          transforms?:
            | {
                request: {
                  name?: string | undefined;
                  when?: Record<string, import('zod').JSONType> | undefined;
                  update: Record<string, import('zod').JSONType>[];
                }[];
              }
            | undefined;
          excludedModels?: string[] | undefined;
          alias?:
            | Record<
                string,
                | false
                | {
                    model: string;
                    preserve: boolean;
                    variants?:
                      | {
                          when: {
                            effort?: string | undefined;
                            thinking?: boolean | undefined;
                            speed?: 'fast' | 'flex' | 'standard' | undefined;
                          };
                          model: string;
                          preserve: boolean;
                        }[]
                      | {
                          when: {
                            effort: string;
                          };
                          model: string;
                          preserve: boolean;
                        }[]
                      | undefined;
                  }
              >
            | undefined;
          kind: ProviderKind.OAuth;
          plugin: string;
          capability: string;
          options?: Record<string, unknown> | undefined;
          proxy?: string | false | undefined;
          proxyBackup?: string | undefined;
          proxyFallback?: boolean | undefined;
        }
      | {
          id: string;
          enabled: boolean;
          priority: number;
          weight: number;
          name?: string | undefined;
          transforms?:
            | {
                request: {
                  name?: string | undefined;
                  when?: Record<string, import('zod').JSONType> | undefined;
                  update: Record<string, import('zod').JSONType>[];
                }[];
              }
            | undefined;
          models?: string[] | undefined;
          alias?:
            | Record<
                string,
                {
                  model: string;
                  preserve: boolean;
                  variants?:
                    | {
                        when: {
                          effort?: string | undefined;
                          thinking?: boolean | undefined;
                          speed?: 'fast' | 'flex' | 'standard' | undefined;
                        };
                        model: string;
                        preserve: boolean;
                      }[]
                    | {
                        when: {
                          effort: string;
                        };
                        model: string;
                        preserve: boolean;
                      }[]
                    | undefined;
                }
              >
            | undefined;
          kind: ProviderKind.AiSdk;
          packageName: string;
          options?: Record<string, unknown> | undefined;
          parseReasoningContent?: boolean | undefined;
          proxy?: string | false | undefined;
          proxyBackup?: string | undefined;
          proxyFallback?: boolean | undefined;
        }
    )[];
    invalidProviders: import('@aio-proxy/types').InvalidProviderConfig[];
  },
): ProviderRouteSource;
export declare function retryConfig(overrides?: Partial<Config['server']['retry']>): Config;
//# sourceMappingURL=providers.d.ts.map
