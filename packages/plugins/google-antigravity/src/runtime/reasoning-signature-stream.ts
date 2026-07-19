import type { LanguageModelV4StreamPart, SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { validThoughtSignature } from "../protocol/signatures";

type ActiveReasoning = {
  readonly id: string;
  readonly source: ReasoningSource | undefined;
  hasEmittedSignature: boolean;
};

type ReasoningSource = { lateSignature: string | undefined };
type ReasoningPart = Extract<LanguageModelV4StreamPart, { type: `reasoning-${string}` }>;

export function bridgeLateReasoningSignatures(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  modelId: string,
  preserveRaw: boolean,
): ReadableStream<LanguageModelV4StreamPart> {
  let active: ActiveReasoning | undefined;
  let sourceActive: ReasoningSource | undefined;
  const pending: LanguageModelV4StreamPart[] = [];
  const sources: ReasoningSource[] = [];
  const reader = stream.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const cancel = async (reason: unknown) => {
    if (released) return;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };
  const transform = (part: LanguageModelV4StreamPart): void => {
    if (part.type === "raw") {
      const observed = observeGoogleChunk(part.rawValue, modelId, sourceActive, sources);
      sourceActive = observed.active;
      if (preserveRaw) pending.push(part);
      const source = active?.source;
      const lateSignature = source?.lateSignature;
      if (
        active !== undefined &&
        source !== undefined &&
        lateSignature !== undefined &&
        !active.hasEmittedSignature &&
        observed.signedSources.includes(source)
      ) {
        pending.push(withGoogleSignature({ type: "reasoning-delta", id: active.id, delta: "" }, lateSignature));
        active.hasEmittedSignature = true;
      }
      return;
    }
    if (part.type === "reasoning-start") {
      const sanitized = withoutInvalidGoogleSignature(part, modelId);
      const source = sources.shift();
      const inlineSignature = metadataSignature(sanitized.providerMetadata, modelId);
      const lateSignature = inlineSignature === undefined ? source?.lateSignature : undefined;
      const output = lateSignature === undefined ? sanitized : withGoogleSignature(sanitized, lateSignature);
      active = {
        id: sanitized.id,
        source,
        hasEmittedSignature: inlineSignature !== undefined || lateSignature !== undefined,
      };
      pending.push(output);
      return;
    }
    if (part.type === "reasoning-delta") {
      const sanitized = withoutInvalidGoogleSignature(part, modelId);
      if (active?.id !== sanitized.id) {
        active = { id: sanitized.id, source: sources.shift(), hasEmittedSignature: false };
      }
      const inlineSignature = metadataSignature(sanitized.providerMetadata, modelId);
      const lateSignature =
        inlineSignature === undefined && !active.hasEmittedSignature ? active.source?.lateSignature : undefined;
      pending.push(lateSignature === undefined ? sanitized : withGoogleSignature(sanitized, lateSignature));
      active.hasEmittedSignature ||= inlineSignature !== undefined || lateSignature !== undefined;
      return;
    }
    if (part.type !== "reasoning-end") {
      pending.push(part);
      return;
    }
    const sanitized = withoutInvalidGoogleSignature(part, modelId);
    const current = active?.id === sanitized.id ? active : undefined;
    const hasEndSignature = metadataSignature(sanitized.providerMetadata, modelId) !== undefined;
    const enriched =
      current !== undefined &&
      !current.hasEmittedSignature &&
      !hasEndSignature &&
      current.source?.lateSignature !== undefined
        ? withGoogleSignature(sanitized, current.source.lateSignature)
        : sanitized;
    if (current !== undefined) active = undefined;
    pending.push(enriched);
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        const queued = pending.shift();
        if (queued !== undefined) {
          controller.enqueue(queued);
          return;
        }
        while (true) {
          const next = await reader.read();
          if (next.done) {
            release();
            controller.close();
            return;
          }
          transform(next.value);
          const output = pending.shift();
          if (output !== undefined) {
            controller.enqueue(output);
            return;
          }
        }
      } catch (error) {
        await cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel,
  });
}

function observeGoogleChunk(
  value: unknown,
  modelId: string,
  active: ReasoningSource | undefined,
  sources: ReasoningSource[],
): { readonly active: ReasoningSource | undefined; readonly signedSources: readonly ReasoningSource[] } {
  const signedSources: ReasoningSource[] = [];
  const payload = record(value);
  const candidates = array(Reflect.get(payload ?? {}, "candidates"));
  const candidate = record(candidates[0]);
  const content = record(Reflect.get(candidate ?? {}, "content"));
  for (const value of array(Reflect.get(content ?? {}, "parts"))) {
    const part = record(value);
    if (part === undefined) continue;
    const text = Reflect.get(part, "text");
    if (typeof text === "string") {
      if (text === "") {
        const signature = Reflect.get(part, "thoughtSignature");
        if (
          active !== undefined &&
          Reflect.get(part, "thought") === true &&
          !hasNonTextPayload(part) &&
          active.lateSignature === undefined &&
          validThoughtSignature(modelId, signature)
        ) {
          active.lateSignature = signature;
          signedSources.push(active);
        }
      } else if (Reflect.get(part, "thought") === true) {
        if (active === undefined) {
          active = { lateSignature: undefined };
          sources.push(active);
        }
      } else {
        active = undefined;
      }
      continue;
    }
    if (Reflect.get(part, "inlineData") != null) active = undefined;
  }
  return { active, signedSources };
}

function hasNonTextPayload(part: Readonly<Record<string, unknown>>): boolean {
  return ["functionCall", "functionResponse", "inlineData", "fileData", "executableCode", "codeExecutionResult"].some(
    (property) => Reflect.get(part, property) != null,
  );
}

function metadataSignature(metadata: unknown, modelId: string): string | undefined {
  const google = record(Reflect.get(record(metadata) ?? {}, "google"));
  const signature = Reflect.get(google ?? {}, "thoughtSignature");
  return validThoughtSignature(modelId, signature) ? signature : undefined;
}

function withoutInvalidGoogleSignature<T extends ReasoningPart>(part: T, modelId: string): T {
  const providerMetadata = record(part.providerMetadata);
  const google = record(Reflect.get(providerMetadata ?? {}, "google"));
  if (google === undefined || !Object.hasOwn(google, "thoughtSignature")) return part;
  const signature = Reflect.get(google, "thoughtSignature");
  if (validThoughtSignature(modelId, signature)) return part;
  const { thoughtSignature: _thoughtSignature, ...sanitizedGoogle } = google;
  return {
    ...part,
    providerMetadata: {
      ...providerMetadata,
      google: sanitizedGoogle,
    } as SharedV4ProviderMetadata,
  } as T;
}

function withGoogleSignature<T extends ReasoningPart>(part: T, signature: string): T {
  const providerMetadata = record(part.providerMetadata);
  const google = record(Reflect.get(providerMetadata ?? {}, "google"));
  return {
    ...part,
    providerMetadata: {
      ...providerMetadata,
      google: { ...google, thoughtSignature: signature },
    } as SharedV4ProviderMetadata,
  } as T;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
