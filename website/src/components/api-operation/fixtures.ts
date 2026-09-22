export type ApiOperationSlug = 'list-models' | 'chat-completions';

export const listModelsDocument = {
  openapi: '3.1.0',
  info: {
    title: 'List models',
    version: '1.0.0',
  },
  paths: {
    '/v1/models': {
      get: {
        operationId: 'listModels',
        summary: 'List models',
        description: 'Lists the models available through AIO Proxy.',
        responses: {
          '200': {
            description: 'The available models.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['object', 'data'],
                  properties: {
                    object: { type: 'string', const: 'list' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'object', 'created', 'owned_by'],
                        properties: {
                          id: { type: 'string', example: 'gpt-5' },
                          object: { type: 'string', const: 'model' },
                          created: { type: 'integer', example: 1_757_289_600 },
                          owned_by: { type: 'string', example: 'aio-proxy' },
                        },
                      },
                    },
                  },
                },
                example: {
                  object: 'list',
                  data: [{ id: 'gpt-5', object: 'model', created: 1_757_289_600, owned_by: 'aio-proxy' }],
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const chatCompletionsDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Create chat completion',
    version: '1.0.0',
  },
  paths: {
    '/v1/chat/completions': {
      post: {
        operationId: 'createChatCompletion',
        summary: 'Create chat completion',
        description: 'Creates a chat completion. Set `stream` to `true` to receive server-sent events.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'messages'],
                properties: {
                  model: { type: 'string', example: 'gpt-5' },
                  messages: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['role', 'content'],
                      properties: {
                        role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
                        content: { type: 'string' },
                      },
                    },
                  },
                  stream: { type: 'boolean', default: false },
                },
              },
              example: {
                model: 'gpt-5',
                messages: [{ role: 'user', content: 'Introduce AIO Proxy in one sentence.' }],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'A chat completion or a stream of chat completion chunks.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id', 'object', 'model', 'choices'],
                  properties: {
                    id: { type: 'string' },
                    object: { type: 'string', const: 'chat.completion' },
                    model: { type: 'string' },
                    choices: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['index', 'message', 'finish_reason'],
                        properties: {
                          index: { type: 'integer' },
                          message: {
                            type: 'object',
                            required: ['role', 'content'],
                            properties: {
                              role: { type: 'string', const: 'assistant' },
                              content: { type: 'string' },
                            },
                          },
                          finish_reason: { type: ['string', 'null'] },
                        },
                      },
                    },
                  },
                },
                example: {
                  id: 'chatcmpl-123',
                  object: 'chat.completion',
                  model: 'gpt-5',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'AIO Proxy routes model requests across providers.' },
                      finish_reason: 'stop',
                    },
                  ],
                },
              },
              'text/event-stream': {
                schema: { type: 'string' },
                example:
                  'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"AIO Proxy"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
              },
            },
          },
        },
      },
    },
  },
} as const;
