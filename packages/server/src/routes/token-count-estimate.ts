import type { ModelInvocation } from '@aio-proxy/core';
import type { ProtocolId } from '@aio-proxy/plugin-sdk';

// Per-provider character-class weights (tokens contributed by each class),
// ported from new-api's empirical BPE averages
// (.reference/new-api/service/token_estimator.go). The count endpoint's real
// tokenizer is not public, so this fallback only aims to beat a flat bytes/N
// ratio; it is intentionally approximate.
type Weights = {
  readonly word: number; // per latin word
  readonly number: number; // per contiguous digit run
  readonly cjk: number; // per CJK char
  readonly symbol: number; // per ordinary punctuation char
  readonly newline: number; // per \n or \t
  readonly space: number; // per space
};

const WEIGHTS: Record<'claude' | 'openai' | 'gemini', Weights> = {
  claude: { word: 1.13, number: 1.63, cjk: 1.21, symbol: 0.4, newline: 0.89, space: 0.39 },
  openai: { word: 1.02, number: 1.55, cjk: 0.85, symbol: 0.4, newline: 0.5, space: 0.42 },
  gemini: { word: 1.15, number: 2.8, cjk: 0.68, symbol: 0.38, newline: 1.15, space: 0.2 },
};

function weightsFor(protocol: ProtocolId): Weights {
  if (protocol === 'anthropic') return WEIGHTS.claude;
  if (protocol === 'gemini') return WEIGHTS.gemini;
  return WEIGHTS.openai;
}

// CJK ideographs, Hiragana/Katakana, Hangul.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

// Character-class state machine: latin/number runs collapse into one token each,
// CJK/space/newline/symbol score per character. Mirrors token_estimator.go's loop.
function estimateText(text: string, w: Weights): number {
  let count = 0;
  let run: 'none' | 'latin' | 'number' = 'none';
  for (const ch of text) {
    if (ch === '\n' || ch === '\t') {
      run = 'none';
      count += w.newline;
      continue;
    }
    if (ch === ' ' || /\s/u.test(ch)) {
      run = 'none';
      count += w.space;
      continue;
    }
    if (CJK.test(ch)) {
      run = 'none';
      count += w.cjk;
      continue;
    }
    if (/[\p{L}\p{N}]/u.test(ch)) {
      const next = /\p{N}/u.test(ch) ? 'number' : 'latin';
      if (run === 'none' || run !== next) {
        count += next === 'number' ? w.number : w.word;
        run = next;
      }
      continue;
    }
    run = 'none';
    count += w.symbol;
  }
  return count;
}

// Pull user-visible text from a message, ignoring binary parts (base64
// images/files) whose serialized size would inflate a byte count.
function messageText(content: ModelInvocation['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'tool-result') text += JSON.stringify(part.output);
  }
  return text;
}

export function estimateInputTokens(protocol: ProtocolId, invocation: ModelInvocation): number {
  const w = weightsFor(protocol);
  let total = 0;
  for (const message of invocation.messages) total += estimateText(messageText(message.content), w);
  // Tool schemas are serialized into the model prompt verbatim, so they count.
  if (invocation.tools !== undefined) total += estimateText(JSON.stringify(invocation.tools), w);
  return Math.max(1, Math.ceil(total));
}
