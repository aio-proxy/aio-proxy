import { Buffer } from 'node:buffer';

import type { LanguageModelV4Prompt, LanguageModelV4ToolResultPart } from '@ai-sdk/provider';
import { isPlainObject } from 'es-toolkit/predicate';

import { readCursorBlob, storeCursorBlob } from '../../store/blobs/index';
import { toWireName } from '../../tool-names/index';
import { rootToolResult, toolResultText } from './tool-result';
import { extractV4UserText } from './user-message/index';

function rootToolCallId(id: string): string {
  return 'aio_' + Buffer.from(id, 'utf8').toString('base64url');
}

function buildRootMessages(prompt: LanguageModelV4Prompt, knownCallIds: Set<string>): Record<string, unknown>[] {
  const knownFromCache = new Set(knownCallIds);
  for (const message of prompt) {
    if (message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') knownCallIds.add(rootToolCallId(part.toolCallId));
    }
  }
  const messages: Record<string, unknown>[] = [];
  const pushResult = (part: LanguageModelV4ToolResultPart) => {
    const id = rootToolCallId(part.toolCallId);
    messages.push(
      knownCallIds.has(id)
        ? {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: id,
                toolName: toWireName(part.toolName),
                ...rootToolResult(part),
              },
            ],
          }
        : { role: 'user', content: [{ type: 'text', text: toolResultText(part) }] },
    );
  };
  for (const message of prompt) {
    if (message.role === 'user') {
      const text = extractV4UserText(message.content);
      const content: unknown[] = text.length > 0 ? [{ type: 'text', text }] : [];
      for (const part of message.content) {
        if (
          part.type !== 'file' ||
          (part.mediaType !== 'image' && !part.mediaType.startsWith('image/')) ||
          part.data.type !== 'data'
        )
          continue;
        const data =
          part.data.data instanceof Uint8Array
            ? Buffer.from(part.data.data).toString('base64')
            : Buffer.from(part.data.data, 'base64').toString('base64');
        content.push({ type: 'file', mediaType: part.mediaType, data: { type: 'data', data } });
      }
      if (content.length > 0) messages.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      let content: Record<string, unknown>[] = [];
      const flush = () => {
        if (content.length > 0) messages.push({ role: 'assistant', content });
        content = [];
      };
      for (const part of message.content) {
        if (part.type === 'text' && part.text) content.push({ type: 'text', text: part.text });
        else if (part.type === 'tool-call') {
          const id = rootToolCallId(part.toolCallId);
          if (knownFromCache.has(id)) continue;
          content.push({
            type: 'tool-call',
            toolCallId: id,
            toolName: toWireName(part.toolName),
            args: part.input,
          });
        } else if (part.type === 'tool-result') {
          flush();
          pushResult(part);
        }
      }
      flush();
    } else if (message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') pushResult(part);
      }
    }
  }
  return messages;
}

function readRootMessage(id: Uint8Array, store: ReadonlyMap<string, Uint8Array>): Record<string, unknown> | undefined {
  const bytes = readCursorBlob(store, id);
  if (bytes === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRootSystemMessage(id: Uint8Array, store: ReadonlyMap<string, Uint8Array>): boolean {
  return readRootMessage(id, store)?.['role'] === 'system';
}

function collectRootCallIds(ids: readonly Uint8Array[], store: ReadonlyMap<string, Uint8Array>): Set<string> {
  const known = new Set<string>();
  for (const id of ids) {
    const message = readRootMessage(id, store);
    if (message?.['role'] !== 'assistant' || !Array.isArray(message['content'])) continue;
    for (const part of message['content']) {
      if (isPlainObject(part) && part['type'] === 'tool-call' && typeof part['toolCallId'] === 'string') {
        known.add(part['toolCallId']);
      }
    }
  }
  return known;
}

export function buildCursorRootMessages(
  prompt: LanguageModelV4Prompt,
  systemPromptIds: Uint8Array[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const history = activeUserMessageIndex < 0 ? prompt : prompt.slice(0, activeUserMessageIndex);
  return [
    ...systemPromptIds,
    ...buildRootMessages(history, new Set()).map((message) =>
      storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(message))),
    ),
  ];
}

export function appendCursorRootHistory(input: {
  rootPromptMessagesJson: readonly Uint8Array[];
  prompt: LanguageModelV4Prompt;
  blobStore: Map<string, Uint8Array>;
}): Uint8Array[] {
  const base = [...input.rootPromptMessagesJson];
  const known = collectRootCallIds(base, input.blobStore);
  const explicitSystem = input.prompt
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  const prefix =
    explicitSystem.length === 0
      ? base
      : [
          ...explicitSystem.map((content) =>
            storeCursorBlob(input.blobStore, new TextEncoder().encode(JSON.stringify({ role: 'system', content }))),
          ),
          ...base.filter((id) => !isRootSystemMessage(id, input.blobStore)),
        ];
  const tail = buildRootMessages(
    input.prompt.filter((m) => m.role !== 'system'),
    known,
  );
  return [...prefix, ...tail.map((m) => storeCursorBlob(input.blobStore, new TextEncoder().encode(JSON.stringify(m))))];
}
