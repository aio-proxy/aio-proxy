import type { ReasoningReplay, ReplayPart } from "../../protocol/replay-cache";
import { validThoughtSignature } from "../../protocol/signatures";
import { asArray, asRecord } from "./payload-shape";
import {
  appendFunctionCallPart,
  createStreamedFunctionCalls,
  type StreamedFunctionCalls,
} from "./streamed-function-calls";

export type SseReplayState = {
  readonly candidates: Map<string, "active" | "success">;
  contentIndex: number;
  outcome: "failure" | "pending" | "success";
  readonly parts: ReplayPart[];
  readonly streamedCalls: StreamedFunctionCalls;
};

export function createSseReplayState(): SseReplayState {
  return {
    candidates: new Map(),
    contentIndex: 0,
    outcome: "pending",
    parts: [],
    streamedCalls: createStreamedFunctionCalls(),
  };
}

export function appendSseReplayPayload(state: SseReplayState, modelId: string, payload: unknown): void {
  if (state.outcome === "failure") return;
  const root = asRecord(payload);
  if (root === undefined || Object.hasOwn(root, "error")) {
    failSseReplay(state);
    return;
  }
  const response = asRecord(Reflect.get(root, "response"));
  if (response === undefined) return;
  appendResponse(state, modelId, response);
}

export function failSseReplay(state: SseReplayState): void {
  state.outcome = "failure";
  state.candidates.clear();
  state.parts.length = 0;
  state.streamedCalls.active.clear();
}

export function completedSseReplay(state: SseReplayState): ReasoningReplay | undefined {
  return state.outcome === "success" && state.streamedCalls.active.size === 0
    ? replayFromParts(state.parts)
    : undefined;
}

export function replayFromJsonPayload(modelId: string, payload: unknown): ReasoningReplay | undefined {
  const root = asRecord(payload);
  if (root === undefined || Object.hasOwn(root, "error")) return undefined;
  const response = asRecord(Reflect.get(root, "response") ?? root);
  if (response === undefined) return undefined;
  const state = createSseReplayState();
  appendResponse(state, modelId, response);
  return completedSseReplay(state);
}

function appendResponse(state: SseReplayState, modelId: string, response: Readonly<Record<string, unknown>>): void {
  const candidates = asArray(Reflect.get(response, "candidates"));
  if (candidates.length === 0) return;
  if (candidates.length > 1) {
    failSseReplay(state);
    return;
  }
  for (const [candidatePosition, candidateValue] of candidates.entries()) {
    const candidate = asRecord(candidateValue);
    if (candidate === undefined) {
      failSseReplay(state);
      return;
    }
    const key = candidateKey(candidate, candidatePosition);
    if (!state.candidates.has(key) && state.candidates.size > 0) {
      failSseReplay(state);
      return;
    }
    if (state.candidates.get(key) === "success") {
      failSseReplay(state);
      return;
    }
    const finishReason = Reflect.get(candidate, "finishReason");
    if (finishReason !== undefined && finishReason !== null && finishReason !== "STOP") {
      failSseReplay(state);
      return;
    }
    const content = asRecord(Reflect.get(candidate, "content"));
    if (content !== undefined) {
      if (!appendContentParts(state, key, modelId, content)) {
        failSseReplay(state);
        return;
      }
      state.contentIndex += 1;
    }
    state.candidates.set(key, finishReason === "STOP" ? "success" : "active");
  }
  state.outcome = [...state.candidates.values()].every((candidate) => candidate === "success") ? "success" : "pending";
}

function appendContentParts(
  state: SseReplayState,
  candidateKey: string,
  modelId: string,
  content: Readonly<Record<string, unknown>>,
): boolean {
  for (const [partIndex, value] of asArray(Reflect.get(content, "parts")).entries()) {
    const part = asRecord(value);
    if (part === undefined) continue;
    const appended = appendFunctionCallPart(
      state.streamedCalls,
      candidateKey,
      modelId,
      part,
      state.contentIndex,
      partIndex,
    );
    if (appended.invalid === true) return false;
    if (appended.handled) {
      if (appended.part !== undefined) state.parts.push(appended.part);
      continue;
    }
    const signature = Reflect.get(part, "thoughtSignature");
    const validSignature = validThoughtSignature(modelId, signature) ? signature : undefined;
    if (validSignature !== undefined) {
      state.parts.push({
        type: "thought-signature",
        contentIndex: state.contentIndex,
        partIndex,
        signature: validSignature,
      });
    }
  }
  return true;
}

function candidateKey(candidate: Readonly<Record<string, unknown>>, position: number): string {
  const index = Reflect.get(candidate, "index");
  return typeof index === "number" && Number.isSafeInteger(index) ? `index:${index}` : `position:${position}`;
}

function replayFromParts(parts: readonly ReplayPart[]): ReasoningReplay | undefined {
  return parts.some((part) => part.type === "thought-signature" || part.signature !== undefined)
    ? { parts: [...parts] }
    : undefined;
}
