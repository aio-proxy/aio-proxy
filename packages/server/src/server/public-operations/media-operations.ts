import {
  OpenAIImageEditsInputSchema,
  OpenAIImageGenerationsInputSchema,
  EDITS_MULTIPART_MAX_IMAGES,
  OpenAISpeechInputSchema,
  OpenAITranscriptionFieldsSchema,
  OpenAIVideoCreateInputSchema,
  OpenAIVideoEditInputSchema,
  OpenAIVideoRemixInputSchema,
} from '@aio-proxy/core';
import { z } from 'zod';

import {
  binary,
  content,
  exampleSchema,
  jsonContent,
  ok,
  operation,
  parameter,
  textContent,
  upstreamObject,
  upstreamStream,
} from './documentation-content';

const imageReply = exampleSchema(
  z
    .object({
      // Same-protocol image providers can forward JSON outside this envelope.
      created: z.number().optional(),
      data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().optional() }).loose()).optional(),
      usage: z.record(z.string(), z.unknown()).optional(),
    })
    .loose(),
  { created: 0, data: [{ b64_json: 'aW1hZ2U=' }] },
);
const videoReply = upstreamObject({
  id: 'video_example',
  object: 'video',
  status: 'queued',
  model: 'sora-2',
  created_at: 0,
});
const videoResponses = [
  {
    status: '2XX',
    description: 'Upstream successful video response; status and fields depend on the provider.',
    content: [jsonContent(videoReply)],
  },
];
const videoParams = [parameter('video_id', 'path', z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u))];
const nonBlankVideoPrompt = z.string().regex(/\S/u);
const videoCreateRequest = OpenAIVideoCreateInputSchema.safeExtend({ prompt: nonBlankVideoPrompt });
const videoEditRequest = OpenAIVideoEditInputSchema.safeExtend({ prompt: nonBlankVideoPrompt });
const videoRemixRequest = OpenAIVideoRemixInputSchema.safeExtend({ prompt: nonBlankVideoPrompt });
const transcriptionRequest = OpenAITranscriptionFieldsSchema.extend({ file: binary.min(1) });
const transcript = jsonContent(exampleSchema(z.object({ text: z.string() }).loose(), { text: 'Hello.' }));
const rawSubtitle = z
  .string()
  .describe('Subtitle text forwarded from a compatible raw provider; conversion cannot render subtitles.');
const inputValue = z.union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);

// SystemOne uses a handwritten parser, not Zod. This wire description is checked against that parser in tests.
export const systemOneRequest = z
  .object({
    model: z.string().min(1),
    state: inputValue,
    questions: z
      .record(
        z.string(),
        z.discriminatedUnion('type', [
          z
            .object({
              type: z.literal('noul'),
              instructions: inputValue,
              criteria: z.object({ true: z.string().optional(), false: z.string().optional() }).loose().optional(),
            })
            .loose(),
          z
            .object({
              type: z.literal('choice'),
              instructions: inputValue,
              criteria: z
                .record(z.string(), z.string().nullable())
                .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 255)
                .meta({ minProperties: 1, maxProperties: 255 }),
            })
            .loose(),
          z
            .object({
              type: z.literal('score'),
              instructions: inputValue,
              criteria: z.array(z.string()).min(2).max(10),
            })
            .loose(),
        ]),
      )
      .refine((value) => Object.keys(value).length > 0)
      .meta({ minProperties: 1 }),
  })
  .loose();

export const mediaOperations = [
  operation('post', '/v1/images/generations', 'generateImages', 'generate-images', 'OpenAI', 14, {
    requestVariants: [
      jsonContent(
        exampleSchema(OpenAIImageGenerationsInputSchema, {
          model: 'gpt-image-2.5-sunburst',
          prompt: 'A red apple.',
          n: 1,
        }),
      ),
    ],
    responseVariants: ok(jsonContent(imageReply), upstreamStream),
  }),
  operation('post', '/v1/images/edits', 'editImages', 'edit-images', 'OpenAI', 15, {
    requestVariants: [
      jsonContent(
        exampleSchema(OpenAIImageEditsInputSchema, {
          prompt: 'Make the sky blue.',
          images: [{ image_url: 'https://example.com/image.png' }],
        }),
      ),
      content(
        'multipart/form-data',
        exampleSchema(
          OpenAIImageGenerationsInputSchema.safeExtend({
            image: z
              .union([binary, z.array(binary).min(1).max(EDITS_MULTIPART_MAX_IMAGES)])
              .describe('Upload image files; repeated image parts are supported.'),
            mask: binary.optional(),
          }),
          { prompt: 'Make the sky blue.', image: 'image.png' },
        ),
      ),
    ],
    responseVariants: ok(jsonContent(imageReply), upstreamStream),
  }),
  operation('post', '/v1/audio/speech', 'createSpeech', 'speech', 'OpenAI', 16, {
    requestVariants: [
      jsonContent(
        exampleSchema(OpenAISpeechInputSchema, {
          model: 'tts-1',
          input: 'Hello.',
          voice: 'alloy',
          response_format: 'mp3',
        }),
      ),
    ],
    responseVariants: ok(
      content('audio/mpeg', binary),
      content('audio/wav', binary),
      content('audio/opus', binary),
      content('audio/flac', binary),
      content('audio/aac', binary),
      content('audio/pcm', binary),
      content('audio/*', binary),
      content('application/octet-stream', binary),
      upstreamStream,
    ),
  }),
  ...(['transcriptions', 'translations'] as const).map((action, index) =>
    operation(
      'post',
      `/v1/audio/${action}`,
      action === 'transcriptions' ? 'transcribeAudio' : 'translateAudio',
      action,
      'OpenAI',
      17 + index,
      {
        requestVariants: [
          content(
            'multipart/form-data',
            exampleSchema(transcriptionRequest, { model: 'whisper-1', file: 'audio.wav' }),
          ),
        ],
        responseVariants: ok(
          transcript,
          textContent('text/plain', 'Hello.'),
          content('text/vtt', exampleSchema(rawSubtitle, 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello.')),
          content('application/x-subrip', exampleSchema(rawSubtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello.')),
          content('text/srt', exampleSchema(rawSubtitle, '1\n00:00:00,000 --> 00:00:01,000\nHello.')),
          content('*/*', binary),
          upstreamStream,
        ),
      },
    ),
  ),
  operation('post', '/v1/systemone', 'evaluateSystemOne', 'systemone', 'SystemOne', 19, {
    requestVariants: [
      jsonContent(
        exampleSchema(systemOneRequest, {
          model: 'systemone',
          state: 'Hello.',
          questions: { greeting: { type: 'noul', instructions: 'Is this a greeting?' } },
        }),
      ),
    ],
    responseVariants: ok(
      jsonContent(upstreamObject({ model: 'systemone', answers: { greeting: { type: 'noul', noul: 0.9 } } })),
    ),
  }),
  operation('post', '/v1/videos', 'createVideo', 'create-video', 'OpenAI', 20, {
    requestVariants: [
      jsonContent(
        exampleSchema(videoCreateRequest, { model: 'sora-2', prompt: 'A red apple rotating.', seconds: '4' }),
      ),
      content(
        'multipart/form-data',
        exampleSchema(videoCreateRequest.extend({ input_reference: binary.optional() }), {
          model: 'sora-2',
          prompt: 'A red apple rotating.',
        }),
      ),
    ],
    responseVariants: videoResponses,
  }),
  ...(['edits', 'extensions'] as const).map((action, index) =>
    operation(
      'post',
      `/v1/videos/${action}`,
      action === 'edits' ? 'editVideo' : 'extendVideo',
      action === 'edits' ? 'edit-video' : 'extend-video',
      'OpenAI',
      21 + index,
      {
        requestVariants: [
          jsonContent(
            exampleSchema(videoEditRequest, {
              prompt: 'Continue the scene.',
              video: { id: 'video_example' },
            }),
          ),
        ],
        responseVariants: videoResponses,
      },
    ),
  ),
  operation('post', '/v1/videos/{video_id}/remix', 'remixVideo', 'remix-video', 'OpenAI', 23, {
    routePath: '/v1/videos/:video_id/remix',
    parameters: videoParams,
    requestVariants: [jsonContent(exampleSchema(videoRemixRequest, { prompt: 'Make it brighter.' }))],
    responseVariants: videoResponses,
  }),
  operation('get', '/v1/videos/{video_id}', 'retrieveVideo', 'retrieve-video', 'OpenAI', 24, {
    routePath: '/v1/videos/:video_id',
    parameters: videoParams,
    responseVariants: videoResponses,
  }),
  operation('get', '/v1/videos/{video_id}/content', 'downloadVideo', 'download-video', 'OpenAI', 25, {
    routePath: '/v1/videos/:video_id/content',
    parameters: [...videoParams, parameter('variant', 'query')],
    responseVariants: ok(content('video/mp4', binary), content('application/octet-stream', binary)),
  }),
  operation('delete', '/v1/videos/{video_id}', 'deleteVideo', 'delete-video', 'OpenAI', 26, {
    routePath: '/v1/videos/:video_id',
    parameters: videoParams,
    responseVariants: [
      {
        status: '2XX',
        description: 'Upstream deletion response is forwarded; its status and optional body depend on the provider.',
        content: [content('*/*', binary)],
      },
    ],
  }),
];
