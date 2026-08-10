import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

// Built-in AI SDK stream parts billed per-occurrence. Image generations arrive
// as `file` parts (media type image/*); web searches arrive as provider-executed
// `tool-call` parts. These counts never appear in the `finish` usage object, so
// they are accumulated separately and merged in at trace settlement.
export type StreamEventCounter = {
  // Classify one stream part, incrementing the relevant counter when it matches.
  readonly observe: (part: TextStreamPart<ToolSet>) => void;
  // Merge accumulated counts into the finish usage. `usage` may be undefined
  // (empty token usage) yet still carry billable events, so a minimal row is
  // synthesized in that case. exactOptionalPropertyTypes: emit a field only > 0.
  readonly withCounts: (usage: UsageRow | undefined) => UsageRow | undefined;
};

export function createStreamEventCounter(providerId: string, modelId: string): StreamEventCounter {
  let imageCount = 0;
  let webSearchCount = 0;
  return {
    observe(part) {
      if (part.type === 'file') {
        // A generated file part counts as an image only for image/* media types;
        // guard against generated audio/other files.
        if (part.file?.mediaType?.startsWith('image/')) imageCount += 1;
      } else if (part.type === 'tool-call') {
        // Built-in provider-run tools set providerExecuted; ordinary client
        // function calls do not. Web-search tool names vary by provider
        // (web_search, web_search_preview, web_search_20250305, ...), so match
        // the substring plus providerExecuted rather than an exact name.
        if (
          part.providerExecuted === true &&
          typeof part.toolName === 'string' &&
          part.toolName.includes('web_search')
        ) {
          webSearchCount += 1;
        }
      }
    },
    withCounts(usage) {
      if (imageCount === 0 && webSearchCount === 0) return usage;
      return {
        ...(usage ?? { providerId, modelId }),
        ...(imageCount > 0 ? { imageCount } : {}),
        ...(webSearchCount > 0 ? { webSearchCount } : {}),
      };
    },
  };
}
