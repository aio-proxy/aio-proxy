import { describe, expect, it } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { countResponseItems, createResponseItemCounter, withItemCounts } from './event-counts';

describe('countResponseItems', () => {
  it('counts image and web-search items in a Responses output array', () => {
    expect(
      countResponseItems(ProviderProtocol.OpenAIResponse, {
        output: [
          { type: 'image_generation_call' },
          { type: 'image_generation_call' },
          { type: 'web_search_call' },
          { type: 'message' },
        ],
      }),
    ).toEqual({ imageCount: 2, webSearchCount: 1 });
  });

  it('unwraps a top-level response envelope', () => {
    expect(
      countResponseItems(ProviderProtocol.OpenAIResponse, {
        response: { output: [{ type: 'web_search_call' }] },
      }),
    ).toEqual({ webSearchCount: 1 });
  });

  it('omits zero counts (absent, not 0)', () => {
    expect(countResponseItems(ProviderProtocol.OpenAIResponse, { output: [{ type: 'message' }] })).toEqual({});
  });

  it('returns {} for non-Responses protocols even with an output-looking array', () => {
    expect(
      countResponseItems(ProviderProtocol.OpenAICompatible, {
        output: [{ type: 'image_generation_call' }, { type: 'web_search_call' }],
      }),
    ).toEqual({});
  });

  it('never throws on malformed shapes', () => {
    expect(countResponseItems(ProviderProtocol.OpenAIResponse, undefined)).toEqual({});
    expect(countResponseItems(ProviderProtocol.OpenAIResponse, { output: 'nope' })).toEqual({});
    expect(countResponseItems(ProviderProtocol.OpenAIResponse, { output: [null, 42, { notype: true }, {}] })).toEqual(
      {},
    );
  });
});

describe('createResponseItemCounter', () => {
  it('accumulates counts across output_item.done events (by event name)', () => {
    const counter = createResponseItemCounter(ProviderProtocol.OpenAIResponse);
    counter.observe('response.output_item.done', { item: { type: 'image_generation_call' } });
    counter.observe('response.output_item.done', { item: { type: 'web_search_call' } });
    counter.observe('response.output_item.done', { item: { type: 'web_search_call' } });
    counter.observe('response.output_item.done', { item: { type: 'message' } });
    expect(counter.totals()).toEqual({ imageCount: 1, webSearchCount: 2 });
  });

  it('keys off the parsed type when the event name is absent', () => {
    const counter = createResponseItemCounter(ProviderProtocol.OpenAIResponse);
    counter.observe(undefined, {
      type: 'response.output_item.done',
      item: { type: 'image_generation_call' },
    });
    expect(counter.totals()).toEqual({ imageCount: 1 });
  });

  it('ignores non-terminal events and missing items', () => {
    const counter = createResponseItemCounter(ProviderProtocol.OpenAIResponse);
    counter.observe('response.output_text.delta', { delta: 'x' });
    counter.observe('response.output_item.done', {});
    counter.observe('response.output_item.done', undefined);
    expect(counter.totals()).toEqual({});
  });

  it('is a no-op for non-Responses protocols', () => {
    const counter = createResponseItemCounter(ProviderProtocol.OpenAICompatible);
    counter.observe('response.output_item.done', { item: { type: 'image_generation_call' } });
    expect(counter.totals()).toEqual({});
  });
});

describe('withItemCounts', () => {
  it('returns the original usage unchanged when there are no counts', () => {
    const usage = { inputTokens: 1 };
    expect(withItemCounts(usage, {})).toBe(usage);
  });

  it('returns undefined when neither usage nor counts exist', () => {
    expect(withItemCounts(undefined, {})).toBeUndefined();
  });

  it('surfaces a usage object carrying counts even when token usage is absent', () => {
    expect(withItemCounts(undefined, { imageCount: 1 })).toEqual({ imageCount: 1 });
  });

  it('merges counts into existing usage', () => {
    expect(withItemCounts({ inputTokens: 2 }, { imageCount: 1, webSearchCount: 3 })).toEqual({
      inputTokens: 2,
      imageCount: 1,
      webSearchCount: 3,
    });
  });
});
