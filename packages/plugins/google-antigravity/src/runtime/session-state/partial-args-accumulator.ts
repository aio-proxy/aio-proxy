export type PartialArg = {
  readonly jsonPath: string;
  readonly stringValue?: string | null;
  readonly numberValue?: number | null;
  readonly boolValue?: boolean | null;
  readonly nullValue?: unknown;
  readonly willContinue?: boolean | null;
};

export class PartialArgsAccumulator {
  readonly #args: Record<string, unknown> = {};

  append(values: readonly PartialArg[]): boolean {
    try {
      for (const value of values) this.#append(value);
      return true;
    } catch {
      return false;
    }
  }

  value(): Readonly<Record<string, unknown>> {
    return this.#args;
  }

  #append(value: PartialArg): void {
    const rawPath = value.jsonPath.replace(/^\$\./, "");
    if (rawPath === "") return;
    const segments = parsePath(rawPath);
    const existing = getNestedValue(this.#args, segments);
    if (value.stringValue != null && existing !== undefined) {
      setNestedValue(this.#args, segments, (existing as string) + value.stringValue);
      return;
    }
    const resolved = value.stringValue ?? value.numberValue ?? value.boolValue;
    if (resolved != null) {
      setNestedValue(this.#args, segments, resolved);
    } else if (Object.hasOwn(value, "nullValue")) {
      setNestedValue(this.#args, segments, null);
    }
  }
}

function parsePath(rawPath: string): readonly (string | number)[] {
  const segments: (string | number)[] = [];
  for (const part of rawPath.split(".")) {
    const bracketIndex = part.indexOf("[");
    if (bracketIndex < 0) {
      segments.push(part);
      continue;
    }
    if (bracketIndex > 0) segments.push(part.slice(0, bracketIndex));
    for (const match of part.matchAll(/\[(\d+)\]/g)) segments.push(Number.parseInt(match[1] ?? "", 10));
  }
  return segments;
}

function getNestedValue(root: Record<string, unknown>, segments: readonly (string | number)[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

function setNestedValue(root: Record<string, unknown>, segments: readonly (string | number)[], value: unknown): void {
  let current: Record<string | number, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = segments[index + 1];
    if (segment === undefined) throw new Error("Invalid partial argument path");
    if (!Object.hasOwn(current, segment) || current[segment] == null) {
      defineValue(current, segment, typeof next === "number" ? [] : {});
    }
    current = current[segment] as Record<string | number, unknown>;
  }
  defineValue(current, segments.at(-1) ?? "", value);
}

function defineValue(target: Record<string | number, unknown>, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value, writable: true });
}
