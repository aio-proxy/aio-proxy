import { z } from 'zod';

import {
  content,
  exampleSchema,
  jsonContent,
  operation,
  parameter,
  textContent,
  upstreamObject,
} from './documentation-content';

const offer = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const callParameter = parameter('call_id', 'path');
const websocketResponse = [
  {
    status: '101',
    description:
      'WebSocket upgrade. Subsequent messages are WebSocket frames, not an HTTP JSON response. Requires an eligible realtime provider.',
  },
];
const createResponse = [
  {
    status: '2XX',
    description: 'Upstream success status with an SDP answer and a rewritten Location header.',
    headers: {
      Location: { description: 'Proxy-relative URL for the created call.', schema: { type: 'string' as const } },
    },
    content: [textContent('application/sdp', offer), jsonContent(upstreamObject({ sdp: offer, type: 'answer' }))],
  },
];

export const realtimeOperations = [
  ...(
    [
      ['/v1/live', 'createLiveCall', 'create-live-call'],
      ['/v1/realtime', 'createRealtime', 'create-realtime'],
      ['/v1/realtime/calls', 'createRealtimeCall', 'create-realtime-call'],
    ] as const
  ).map(([path, id, slug], index) =>
    operation('post', path, id, slug, 'Realtime', 27 + index, {
      requestVariants: [
        textContent('application/sdp', offer),
        textContent('text/plain', offer),
        content(
          'application/json',
          exampleSchema(
            z
              .object({
                sdp: z.string().optional(),
                model: z.string().optional(),
                session: z.record(z.string(), z.unknown()).optional(),
              })
              .loose()
              .describe(
                'The proxy routes this JSON object by model/session; offer fields are validated by the upstream provider.',
              ),
            { sdp: offer },
          ),
        ),
        content(
          'multipart/form-data',
          exampleSchema(
            z.object({
              sdp: z.string().min(1),
              session: z.string().optional().describe('JSON-encoded session object.'),
            }),
            { sdp: offer },
          ),
        ),
      ],
      responseVariants: createResponse,
    }),
  ),
  operation(
    'post',
    '/v1/realtime/calls/{call_id}/hangup',
    'hangupRealtimeCall',
    'hangup-realtime-call',
    'Realtime',
    30,
    {
      routePath: '/v1/realtime/calls/:call_id/hangup',
      parameters: [callParameter],
      responseVariants: [{ status: '204', description: 'Call removed and attached socket closed. No response body.' }],
    },
  ),
  operation('get', '/v1/live/{call_id}', 'attachLiveCall', 'attach-live-call', 'Realtime', 31, {
    routePath: '/v1/live/:call_id',
    parameters: [callParameter],
    responseVariants: websocketResponse,
  }),
  operation('get', '/v1/realtime/calls/{call_id}', 'attachRealtimeCall', 'attach-realtime-call', 'Realtime', 32, {
    routePath: '/v1/realtime/calls/:call_id',
    parameters: [callParameter],
    responseVariants: websocketResponse,
  }),
  operation('get', '/v1/realtime', 'connectRealtime', 'connect-realtime', 'Realtime', 33, {
    parameters: [parameter('call_id', 'query'), parameter('model', 'query')],
    responseVariants: websocketResponse,
  }),
];
