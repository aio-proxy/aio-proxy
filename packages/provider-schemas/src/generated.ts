// biome-ignore-all format: This file is deterministically generated.
import type { ProviderOptionsSchemaEntry } from "./types";

export const PROVIDER_OPTIONS_SCHEMAS = {
  "@ai-sdk/anthropic": {
    "factoryName": "createAnthropic",
    "packageName": "@ai-sdk/anthropic",
    "packageVersion": "4.0.3",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "apiKey": {
          "description": "API key that is being send using the `x-api-key` header.\nIt defaults to the `ANTHROPIC_API_KEY` environment variable.\nOnly one of `apiKey` or `authToken` is required.",
          "type": "string"
        },
        "authToken": {
          "description": "Auth token that is being sent using the `Authorization: Bearer` header.\nIt defaults to the `ANTHROPIC_AUTH_TOKEN` environment variable.\nOnly one of `apiKey` or `authToken` is required.",
          "type": "string"
        },
        "baseURL": {
          "description": "Use a different URL prefix for API calls, e.g. to use proxy servers.\nThe default prefix is `https://api.anthropic.com/v1`.",
          "type": "string"
        },
        "headers": {
          "additionalProperties": true,
          "description": "Custom headers to include in the requests.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        },
        "name": {
          "description": "Custom provider name\nDefaults to 'anthropic.messages'.",
          "type": "string"
        }
      },
      "type": "object"
    },
    "warnings": [
      {
        "code": "unresolved_optional",
        "path": "fetch"
      },
      {
        "code": "unsupported_optional",
        "path": "generateId"
      }
    ]
  },
  "@ai-sdk/google": {
    "factoryName": "createGoogle",
    "packageName": "@ai-sdk/google",
    "packageVersion": "4.0.3",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "apiKey": {
          "description": "API key that is being send using the `x-goog-api-key` header.\nIt defaults to the `GOOGLE_GENERATIVE_AI_API_KEY` environment variable.",
          "type": "string"
        },
        "baseURL": {
          "description": "Use a different URL prefix for API calls, e.g. to use proxy servers.\nThe default prefix is `https://generativelanguage.googleapis.com/v1beta`.",
          "type": "string"
        },
        "name": {
          "description": "Custom provider name\nDefaults to 'google.generative-ai'.",
          "type": "string"
        }
      },
      "type": "object"
    },
    "warnings": [
      {
        "code": "unresolved_optional",
        "path": "fetch"
      },
      {
        "code": "unsupported_optional",
        "path": "generateId"
      },
      {
        "code": "unsupported_optional",
        "path": "headers"
      }
    ]
  },
  "@ai-sdk/groq": {
    "factoryName": "createGroq",
    "packageName": "@ai-sdk/groq",
    "packageVersion": "4.0.2",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "apiKey": {
          "description": "API key for authenticating requests.",
          "type": "string"
        },
        "baseURL": {
          "description": "Base URL for the Groq API calls.",
          "type": "string"
        },
        "headers": {
          "additionalProperties": true,
          "description": "Custom headers to include in the requests.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        }
      },
      "type": "object"
    },
    "warnings": [
      {
        "code": "unresolved_optional",
        "path": "fetch"
      }
    ]
  },
  "@ai-sdk/mistral": {
    "factoryName": "createMistral",
    "packageName": "@ai-sdk/mistral",
    "packageVersion": "4.0.2",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "apiKey": {
          "description": "API key that is being send using the `Authorization` header.\nIt defaults to the `MISTRAL_API_KEY` environment variable.",
          "type": "string"
        },
        "baseURL": {
          "description": "Use a different URL prefix for API calls, e.g. to use proxy servers.\nThe default prefix is `https://api.mistral.ai/v1`.",
          "type": "string"
        },
        "headers": {
          "additionalProperties": true,
          "description": "Custom headers to include in the requests.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        }
      },
      "type": "object"
    },
    "warnings": [
      {
        "code": "unresolved_optional",
        "path": "fetch"
      },
      {
        "code": "unsupported_optional",
        "path": "generateId"
      }
    ]
  },
  "@ai-sdk/openai": {
    "factoryName": "createOpenAI",
    "packageName": "@ai-sdk/openai",
    "packageVersion": "4.0.4",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "apiKey": {
          "description": "API key for authenticating requests.",
          "type": "string"
        },
        "baseURL": {
          "description": "Base URL for the OpenAI API calls.",
          "type": "string"
        },
        "headers": {
          "additionalProperties": true,
          "description": "Custom headers to include in the requests.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        },
        "name": {
          "description": "Provider name. Overrides the `openai` default name for 3rd party providers.",
          "type": "string"
        },
        "organization": {
          "description": "OpenAI Organization.",
          "type": "string"
        },
        "project": {
          "description": "OpenAI project.",
          "type": "string"
        }
      },
      "type": "object"
    },
    "warnings": [
      {
        "code": "unresolved_optional",
        "path": "fetch"
      }
    ]
  },
  "@ai-sdk/openai-compatible": {
    "factoryName": "createOpenAICompatible",
    "packageName": "@ai-sdk/openai-compatible",
    "packageVersion": "3.0.2",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "apiKey": {
          "description": "API key for authenticating requests. If specified, adds an `Authorization`\nheader to request headers with the value `Bearer <apiKey>`. This will be added\nbefore any headers potentially specified in the `headers` option.",
          "type": "string"
        },
        "baseURL": {
          "description": "Base URL for the API calls.",
          "type": "string"
        },
        "headers": {
          "additionalProperties": true,
          "description": "Optional custom headers to include in requests. These will be added to request headers\nafter any headers potentially added by use of the `apiKey` option.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        },
        "includeUsage": {
          "description": "Include usage information in streaming responses.",
          "type": "boolean"
        },
        "name": {
          "description": "Provider name.",
          "type": "string"
        },
        "queryParams": {
          "additionalProperties": true,
          "description": "Optional custom url query parameters to include in request urls.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        },
        "supportsStructuredOutputs": {
          "description": "Whether the provider supports structured outputs in chat models.",
          "type": "boolean"
        }
      },
      "required": [
        "baseURL",
        "name"
      ],
      "type": "object"
    },
    "warnings": [
      {
        "code": "unresolved_optional",
        "path": "convertUsage"
      },
      {
        "code": "unresolved_optional",
        "path": "fetch"
      },
      {
        "code": "unresolved_optional",
        "path": "metadataExtractor"
      },
      {
        "code": "unresolved_optional",
        "path": "supportedUrls"
      },
      {
        "code": "unsupported_optional",
        "path": "transformRequestBody"
      }
    ]
  },
  "@ai-sdk/xai": {
    "factoryName": "createXai",
    "packageName": "@ai-sdk/xai",
    "packageVersion": "4.0.3",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "apiKey": {
          "description": "API key for authenticating requests.",
          "type": "string"
        },
        "baseURL": {
          "description": "Base URL for the xAI API calls.",
          "type": "string"
        },
        "headers": {
          "additionalProperties": true,
          "description": "Custom headers to include in the requests.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        }
      },
      "type": "object"
    },
    "warnings": [
      {
        "code": "unresolved_optional",
        "path": "fetch"
      }
    ]
  },
  "@openrouter/ai-sdk-provider": {
    "factoryName": "createOpenRouter",
    "packageName": "@openrouter/ai-sdk-provider",
    "packageVersion": "2.10.0",
    "schema": {
      "additionalProperties": true,
      "properties": {
        "api_keys": {
          "additionalProperties": true,
          "description": "Record of provider slugs to API keys for injecting into provider routing.\nMaps provider slugs (e.g. \"anthropic\", \"openai\") to their respective API keys.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        },
        "apiKey": {
          "description": "API key for authenticating requests.",
          "type": "string"
        },
        "appName": {
          "description": "Your app's display name. Sets the `X-OpenRouter-Title` header on\nevery request for app attribution on the openrouter.ai dashboard.",
          "type": "string"
        },
        "appUrl": {
          "description": "Your app's URL or identifier. Sets the `HTTP-Referer` header on every request,\nused to identify your app on the openrouter.ai dashboard.",
          "type": "string"
        },
        "baseUrl": {
          "description": "@deprecated Use `baseURL` instead.",
          "type": "string"
        },
        "baseURL": {
          "description": "Base URL for the OpenRouter API calls.",
          "type": "string"
        },
        "compatibility": {
          "anyOf": [
            {
              "const": "strict",
              "type": "string"
            },
            {
              "const": "compatible",
              "type": "string"
            }
          ],
          "description": "OpenRouter compatibility mode. Should be set to `strict` when using the OpenRouter API,\nand `compatible` when using 3rd party providers. In `compatible` mode, newer\ninformation such as streamOptions are not being sent. Defaults to 'compatible'."
        },
        "extraBody": {
          "additionalProperties": true,
          "description": "A JSON object to send as the request body to access OpenRouter features & upstream provider features.",
          "patternProperties": {
            "^.*$": {}
          },
          "properties": {},
          "type": "object"
        },
        "headers": {
          "additionalProperties": true,
          "description": "Custom headers to include in the requests.",
          "patternProperties": {
            "^.*$": {
              "type": "string"
            }
          },
          "properties": {},
          "type": "object"
        }
      },
      "type": "object"
    },
    "warnings": [
      {
        "code": "unsupported_optional",
        "path": "fetch"
      }
    ]
  }
} as const satisfies Readonly<Record<string, ProviderOptionsSchemaEntry>>;
