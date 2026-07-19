import type { FormField } from "@aio-proxy/plugin-sdk";

import { FormSchemaValidationError } from "./errors";

function jsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const safe = Array.isArray(value)
    ? value.every((item) => jsonSafe(item, seen))
    : Object.entries(value).every(([key, item]) => typeof key === "string" && jsonSafe(item, seen));
  seen.delete(value);
  return safe;
}

function stableJsonValue(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value !== "object" || seen.has(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      seen.add(value);
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          items.push("hole");
          continue;
        }
        const item = stableJsonValue(value[index], seen);
        if (item === undefined) return undefined;
        items.push(`value:${item}`);
      }
      return `[${items.join(",")}]`;
    }
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const fields: string[] = [];
    for (const key of (keys as string[]).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      const encoded = stableJsonValue(descriptor.value, seen);
      if (encoded === undefined) return undefined;
      fields.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${fields.join(",")}}`;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

export function jsonSafeEqual(left: unknown, right: unknown): boolean {
  const encoded = stableJsonValue(left);
  return encoded !== undefined && encoded === stableJsonValue(right);
}

function inertJsonError(): never {
  throw new FormSchemaValidationError([{ key: "<root>", message: "Expected inert JSON data" }]);
}

function arrayIndex(key: string, length: number): number | undefined {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && index < length && String(index) === key
    ? index
    : undefined;
}

function cloneInertJsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : inertJsonError();
  if (typeof value !== "object" || seen.has(value)) return inertJsonError();
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return inertJsonError();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 0xffff_ffff
      ) {
        return inertJsonError();
      }
      // oxlint-disable-next-line unicorn/no-new-array -- must preserve holes for skipped indices; Array.from would fill them with `undefined`
      const clone: unknown[] = new Array(lengthDescriptor.value);
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string") return inertJsonError();
        const index = arrayIndex(key, lengthDescriptor.value);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (index === undefined || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return inertJsonError();
        }
        clone[index] = cloneInertJsonValue(descriptor.value, seen);
      }
      return clone;
    }
    if (prototype !== Object.prototype && prototype !== null) return inertJsonError();
    const clone = Object.create(prototype) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return inertJsonError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return inertJsonError();
      Object.defineProperty(clone, key, {
        value: cloneInertJsonValue(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } catch (error) {
    if (error instanceof FormSchemaValidationError) throw error;
    return inertJsonError();
  } finally {
    seen.delete(value);
  }
}

export function cloneInertJson<T>(value: T): T {
  return cloneInertJsonValue(value, new Set<object>()) as T;
}

export function compatibleDefault(field: FormField, current: unknown): unknown {
  switch (field.type) {
    case "text":
      return typeof current === "string" ? current : undefined;
    case "secret":
      return current;
    case "number":
      return typeof current === "number" && Number.isFinite(current) ? current : undefined;
    case "boolean":
      return typeof current === "boolean" ? current : field.defaultValue;
    case "select":
      return field.options.some((option) => option.value === current) ? current : undefined;
    case "json":
      return jsonSafe(current) ? current : field.defaultValue;
  }
}

export function plainRecordEntries(value: unknown): readonly (readonly [string, unknown])[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FormSchemaValidationError([{ key: "<root>", message: "Expected an object" }]);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new FormSchemaValidationError([{ key: "<root>", message: "Expected a plain object" }]);
    }
    return Reflect.ownKeys(value).map((key) => {
      if (typeof key !== "string") {
        throw new FormSchemaValidationError([{ key: "<root>", message: "Expected string record keys" }]);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new FormSchemaValidationError([{ key, message: "Expected a plain record value" }]);
      }
      return [key, descriptor.value] as const;
    });
  } catch (error) {
    if (error instanceof FormSchemaValidationError) throw error;
    throw new FormSchemaValidationError([{ key: "<root>", message: "Expected a plain object" }]);
  }
}
