import type { ReasoningReplay } from "../../protocol/replay-cache";
import { asArray } from "./payload-shape";
import { enrichModelTurn } from "./prepare/model-turn";
import { orderedReplayParts, replayPart } from "./prepare/replay-parts";
import { matchingReplayBoundary } from "./prepare/response-match";

export function prepareReasoningReplay(
  body: Readonly<Record<string, unknown>>,
  modelId: string,
  replay: ReasoningReplay | undefined,
): Record<string, unknown> {
  if (replay === undefined) return body;
  const contents = asArray(Reflect.get(body, "contents"));
  const ordered = orderedReplayParts(replay.parts);
  const calls = ordered.filter((part) => part.type === "function-call");
  const boundary = matchingReplayBoundary(contents, calls);
  if (boundary === undefined) return body;
  if (boundary.modelIndex !== undefined) {
    return enrichModelTurn(body, contents, boundary.modelIndex, ordered, modelId);
  }

  const parts = ordered.flatMap((part) => replayPart(part, modelId));
  if (parts.length === 0) return body;
  return {
    ...body,
    contents: [
      ...contents.slice(0, boundary.responseIndex),
      { role: "model", parts },
      ...contents.slice(boundary.responseIndex),
    ],
  };
}
