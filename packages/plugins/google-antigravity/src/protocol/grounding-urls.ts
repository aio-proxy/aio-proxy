const GROUNDING_REDIRECT_ORIGIN = "https://vertexaisearch.cloud.google.com";
const GROUNDING_REDIRECT_PREFIX = "/grounding-api-redirect/";
const REPAIR_TIMEOUT_MS = 1_500;

export type GroundingRepairDependencies = {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutSignal?: () => AbortSignal;
};

type GroundingRepairContext = GroundingRepairDependencies & {
  readonly resolvedUrls?: Map<string, Promise<string | undefined>>;
};

export async function repairGroundingUrls(
  payload: unknown,
  dependencies: GroundingRepairDependencies = {},
): Promise<unknown> {
  try {
    throwIfCallerAborted(dependencies.signal);
    const context = dependencies as GroundingRepairContext;
    const urls = groundingUrls(payload);
    if (urls.size === 0) return payload;
    const signal = combinedSignal(dependencies);
    const replacements = new Map<string, string>();
    await Promise.all(
      [...urls].map(async (url) => {
        let task = context.resolvedUrls?.get(url);
        if (task === undefined) {
          task = resolveGroundingUrl(url, signal, dependencies.fetch ?? globalThis.fetch);
          context.resolvedUrls?.set(url, task);
        }
        const replacement = await task;
        if (replacement !== undefined && replacement !== url) replacements.set(url, replacement);
      }),
    );
    throwIfCallerAborted(dependencies.signal);
    if (replacements.size === 0) return payload;
    const repaired = structuredClone(payload);
    replaceGroundingUrls(repaired, replacements);
    return repaired;
  } catch {
    throwIfCallerAborted(dependencies.signal);
    return payload;
  }
}

export function repairGroundingSse(
  stream: ReadableStream<Uint8Array>,
  dependencies: GroundingRepairDependencies = {},
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const cancellation = new AbortController();
  const repairDependencies = {
    ...dependencies,
    resolvedUrls: new Map<string, Promise<string | undefined>>(),
    signal:
      dependencies.signal === undefined
        ? cancellation.signal
        : AbortSignal.any([dependencies.signal, cancellation.signal]),
  };
  let buffered = "";
  let ended = false;
  let state: "active" | "canceling" | "released" = "active";
  const release = () => {
    if (state !== "active") return;
    state = "released";
    reader.releaseLock();
  };
  const cancel = async (reason?: unknown) => {
    if (state !== "active") return;
    state = "canceling";
    cancellation.abort(reason);
    try {
      await reader.cancel(reason);
    } finally {
      state = "released";
      reader.releaseLock();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        let frame = takeFrame();
        while (frame === undefined && !ended && state === "active") {
          const chunk = await reader.read();
          if (chunk.done) {
            buffered += decoder.decode();
            ended = true;
            frame = takeFrame();
            if (frame === undefined && buffered !== "") {
              frame = buffered;
              buffered = "";
            }
            if (frame === undefined) release();
          } else {
            buffered += decoder.decode(chunk.value, { stream: true });
            frame = takeFrame();
          }
        }
        if (frame !== undefined) {
          const repaired = await repairTerminalFrame(frame, repairDependencies);
          if (ended) release();
          controller.enqueue(encoder.encode(repaired));
        } else if (ended) controller.close();
      } catch (error) {
        await cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    cancel,
  });

  function takeFrame(): string | undefined {
    const boundary = /\r?\n\r?\n/u.exec(buffered);
    if (boundary?.index === undefined) return undefined;
    const end = boundary.index + boundary[0].length;
    const frame = buffered.slice(0, end);
    buffered = buffered.slice(end);
    return frame;
  }
}

async function repairTerminalFrame(frame: string, dependencies: GroundingRepairDependencies): Promise<string> {
  try {
    const data = frame
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data === "") return frame;
    const payload: unknown = JSON.parse(data);
    if (!isTerminal(payload)) return frame;
    const repaired = await repairGroundingUrls(payload, dependencies);
    return repaired === payload ? frame : `data: ${JSON.stringify(repaired)}\n\n`;
  } catch {
    throwIfCallerAborted(dependencies.signal);
    return frame;
  }
}

async function resolveGroundingUrl(
  url: string,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "follow", signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const finalUrl = new URL(response.url);
    return finalUrl.protocol === "http:" || finalUrl.protocol === "https:" ? finalUrl.href : undefined;
  } catch {
    return undefined;
  }
}

function groundingUrls(payload: unknown): Set<string> {
  const urls = new Set<string>();
  for (const chunk of groundingChunks(payload)) {
    const web = record(Reflect.get(chunk, "web"));
    const uri = Reflect.get(web ?? {}, "uri");
    if (typeof uri === "string" && isGroundingRedirect(uri)) urls.add(uri);
  }
  return urls;
}

function replaceGroundingUrls(payload: unknown, replacements: ReadonlyMap<string, string>): void {
  for (const chunk of groundingChunks(payload)) {
    const web = record(Reflect.get(chunk, "web"));
    const uri = Reflect.get(web ?? {}, "uri");
    if (typeof uri !== "string") continue;
    const replacement = replacements.get(uri);
    if (replacement !== undefined && web !== undefined) Reflect.set(web, "uri", replacement);
  }
}

function groundingChunks(payload: unknown): Record<string, unknown>[] {
  const root = record(payload);
  const response = record(Reflect.get(root ?? {}, "response")) ?? root;
  const candidateValue = Reflect.get(response ?? {}, "candidates");
  const candidates = Array.isArray(candidateValue) ? candidateValue : [];
  return candidates.flatMap((candidate) => {
    const groundingMetadata = record(Reflect.get(record(candidate) ?? {}, "groundingMetadata"));
    const chunks = Reflect.get(groundingMetadata ?? {}, "groundingChunks");
    return Array.isArray(chunks) ? chunks.filter(isRecord) : [];
  });
}

function isTerminal(payload: unknown): boolean {
  const root = record(payload);
  const response = record(Reflect.get(root ?? {}, "response")) ?? root;
  const candidateValue = Reflect.get(response ?? {}, "candidates");
  const candidates = Array.isArray(candidateValue) ? candidateValue : [];
  return candidates.some((candidate) => Reflect.get(record(candidate) ?? {}, "finishReason") !== undefined);
}

function isGroundingRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === GROUNDING_REDIRECT_ORIGIN && url.pathname.startsWith(GROUNDING_REDIRECT_PREFIX);
  } catch {
    return false;
  }
}

function combinedSignal(dependencies: GroundingRepairDependencies): AbortSignal {
  const timeout = (dependencies.timeoutSignal ?? (() => AbortSignal.timeout(REPAIR_TIMEOUT_MS)))();
  return dependencies.signal === undefined ? timeout : AbortSignal.any([dependencies.signal, timeout]);
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  throw reason ?? new DOMException("The operation was aborted", "AbortError");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
