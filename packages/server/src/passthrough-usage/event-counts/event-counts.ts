import { ProviderProtocol } from '@aio-proxy/types';

import { type ExtractedUsage, isRecord } from '../shared';

// Built-in items that carry a per-event fee. Responses counts live in the
// `output` array / `response.output_item.done` events. Images streams count
// each official `image_generation.completed` event. Neither lives in `usage`,
// so they are counted separately from token extraction. Chat Completions,
// Anthropic, and Gemini have no equivalent built-in item shape in scope.
export type ResponseItemCounts = {
  readonly imageCount?: number;
  readonly webSearchCount?: number;
};

const IMAGE_ITEM_TYPE = 'image_generation_call';
const WEB_SEARCH_ITEM_TYPE = 'web_search_call';
const OUTPUT_ITEM_DONE = 'response.output_item.done';
const IMAGE_GENERATION_COMPLETED = 'image_generation.completed';

// Count built-in tool items from a parsed NON-STREAM Responses reply. Mirrors
// `openAIResponsesUsage`'s `response` unwrapping. Guards every access so a
// malformed body yields `{}` rather than throwing.
export function countResponseItems(protocol: ProviderProtocol, value: unknown): ResponseItemCounts {
  if (protocol !== ProviderProtocol.OpenAIResponse || !isRecord(value)) return {};
  const response = isRecord(value['response']) ? value['response'] : value;
  const output = response['output'];
  if (!Array.isArray(output)) return {};
  let imageCount = 0;
  let webSearchCount = 0;
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item['type'] === IMAGE_ITEM_TYPE) imageCount += 1;
    else if (item['type'] === WEB_SEARCH_ITEM_TYPE) webSearchCount += 1;
  }
  return counts(imageCount, webSearchCount);
}

export type ResponseItemCounter = {
  readonly observe: (eventType: string | undefined, parsedData: unknown) => void;
  readonly totals: () => ResponseItemCounts;
};

// Streaming accumulator for the SSE path. Responses increments on each
// `response.output_item.done` built-in tool. Images increments on each official
// `image_generation.completed` event (one generated image, not a `data` array).
export function createResponseItemCounter(protocol: ProviderProtocol): ResponseItemCounter {
  let imageCount = 0;
  let webSearchCount = 0;
  const responses = protocol === ProviderProtocol.OpenAIResponse;
  const images = protocol === ProviderProtocol.OpenAIImage;
  return {
    observe(eventType, parsedData) {
      const type = eventType ?? (isRecord(parsedData) ? parsedData['type'] : undefined);
      if (images) {
        if (type === IMAGE_GENERATION_COMPLETED) imageCount += 1;
        return;
      }
      if (!responses) return;
      if (type !== OUTPUT_ITEM_DONE || !isRecord(parsedData)) return;
      const item = parsedData['item'];
      if (!isRecord(item)) return;
      if (item['type'] === IMAGE_ITEM_TYPE) imageCount += 1;
      else if (item['type'] === WEB_SEARCH_ITEM_TYPE) webSearchCount += 1;
    },
    totals: () => counts(imageCount, webSearchCount),
  };
}

// Fold item counts into an existing usage object. Returns `undefined` only when
// there is neither prior usage nor any counts; if counts exist they surface even
// when token usage was absent so image/web-only replies still bill.
export function withItemCounts(
  usage: ExtractedUsage | undefined,
  itemCounts: ResponseItemCounts,
): ExtractedUsage | undefined {
  if (itemCounts.imageCount === undefined && itemCounts.webSearchCount === undefined) return usage;
  return { ...usage, ...itemCounts };
}

function counts(imageCount: number, webSearchCount: number): ResponseItemCounts {
  return {
    ...(imageCount > 0 ? { imageCount } : {}),
    ...(webSearchCount > 0 ? { webSearchCount } : {}),
  };
}
