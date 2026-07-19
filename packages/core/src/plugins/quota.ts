import { type LocalizedText, LocalizedTextSchema, type OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { isProxy } from "node:util/types";

type Path = readonly (string | number)[];

export class OAuthQuotaValidationError extends Error {
  readonly path: Path;

  constructor(path: Path) {
    super("Plugin quota snapshot is invalid");
    this.name = "OAuthQuotaValidationError";
    this.path = path;
  }
}

function invalid(path: Path): never {
  throw new OAuthQuotaValidationError(path);
}

function withPlainRecord<T>(
  value: unknown,
  path: Path,
  allowedKeys: ReadonlySet<string>,
  ancestors: Set<object>,
  validate: (record: Readonly<Record<string, unknown>>) => T,
): T {
  if (typeof value !== "object" || value === null || isProxy(value)) invalid(path);
  if (ancestors.has(value)) invalid(path);

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid(path);
  }
  if (prototype !== Object.prototype && prototype !== null) invalid(path);

  const record = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") invalid(path);
    if (!allowedKeys.has(key)) invalid([...path, key]);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid([...path, key]);
    }
    if (descriptor === undefined || !("value" in descriptor)) invalid([...path, key]);
    record[key] = descriptor.value;
  }

  ancestors.add(value);
  try {
    return validate(record);
  } finally {
    ancestors.delete(value);
  }
}

function withDenseArray<T>(
  value: unknown,
  path: Path,
  ancestors: Set<object>,
  validate: (items: readonly unknown[]) => T,
): T {
  if (typeof value !== "object" || value === null || isProxy(value)) invalid(path);
  if (ancestors.has(value)) invalid(path);
  if (!Array.isArray(value)) invalid(path);

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid(path);
  }
  if (prototype !== Array.prototype) invalid(path);

  let length: number | undefined;
  const indexedValues: { readonly index: number; readonly value: unknown }[] = [];
  for (const key of keys) {
    if (typeof key !== "string") invalid(path);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid(key === "length" ? path : [...path, key]);
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      invalid(key === "length" ? path : [...path, key]);
    }
    if (key === "length") {
      if (typeof descriptor.value !== "number" || !Number.isSafeInteger(descriptor.value)) invalid(path);
      length = descriptor.value;
      continue;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= 0xffffffff || String(index) !== key) {
      invalid([...path, key]);
    }
    indexedValues.push({ index, value: descriptor.value });
  }

  if (length === undefined) invalid(path);
  indexedValues.sort((left, right) => left.index - right.index);
  if (indexedValues.length !== length) {
    let expectedIndex = 0;
    for (const { index } of indexedValues) {
      if (index !== expectedIndex) invalid([...path, expectedIndex]);
      expectedIndex++;
    }
    invalid([...path, expectedIndex]);
  }
  const items = indexedValues.map(({ value: item }) => item);

  ancestors.add(value);
  try {
    return validate(items);
  } finally {
    ancestors.delete(value);
  }
}

function quotaId(value: unknown, path: Path): string {
  if (typeof value !== "string" || value.trim() === "") invalid(path);
  return value;
}

function localizedText(value: unknown, path: Path): LocalizedText {
  if (typeof value === "object" && value !== null && isProxy(value)) invalid(path);
  const result = LocalizedTextSchema.safeParse(value);
  if (!result.success) invalid(path);
  return result.data;
}

function optionalRatio(value: unknown, path: Path): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid(path);
  return value;
}

function optionalTimestamp(value: unknown, path: Path): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) invalid(path);
  return value as number;
}

function resetCount(value: unknown, path: Path): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(path);
  return value as number;
}

const SNAPSHOT_KEYS = new Set(["items", "resetCredits"]);
const ITEM_KEYS = new Set(["id", "label", "remainingRatio", "resetsAt"]);
const RESET_KEYS = new Set(["availableCount", "items"]);
const CREDIT_KEYS = new Set(["id", "expiresAt"]);

export function validateOAuthQuotaSnapshot(value: unknown): OAuthQuotaSnapshot {
  const ancestors = new Set<object>();
  return withPlainRecord(value, [], SNAPSHOT_KEYS, ancestors, (snapshot) => {
    const { items: snapshotItems, resetCredits: snapshotResetCredits } = snapshot;
    const itemIds = new Set<string>();
    const items = withDenseArray(snapshotItems, ["items"], ancestors, (inputItems) =>
      inputItems.map((input, index) =>
        withPlainRecord(input, ["items", index], ITEM_KEYS, ancestors, (item) => {
          const { id: itemId, label, remainingRatio: inputRatio, resetsAt: inputResetsAt } = item;
          const id = quotaId(itemId, ["items", index, "id"]);
          if (itemIds.has(id)) invalid(["items", index, "id"]);
          itemIds.add(id);
          const remainingRatio = optionalRatio(inputRatio, ["items", index, "remainingRatio"]);
          const resetsAt = optionalTimestamp(inputResetsAt, ["items", index, "resetsAt"]);
          return {
            id,
            label: localizedText(label, ["items", index, "label"]),
            ...(remainingRatio === undefined ? {} : { remainingRatio }),
            ...(resetsAt === undefined ? {} : { resetsAt }),
          };
        }),
      ),
    );

    const resetCredits =
      snapshotResetCredits === undefined
        ? undefined
        : withPlainRecord(snapshotResetCredits, ["resetCredits"], RESET_KEYS, ancestors, (reset) => {
            const { availableCount: inputCount, items: inputCreditsValue } = reset;
            const creditIds = new Set<string>();
            const credits =
              inputCreditsValue === undefined
                ? undefined
                : withDenseArray(inputCreditsValue, ["resetCredits", "items"], ancestors, (inputCredits) =>
                    inputCredits.map((input, index) =>
                      withPlainRecord(input, ["resetCredits", "items", index], CREDIT_KEYS, ancestors, (credit) => {
                        const { id: creditId, expiresAt: inputExpiresAt } = credit;
                        const id = quotaId(creditId, ["resetCredits", "items", index, "id"]);
                        if (creditIds.has(id)) invalid(["resetCredits", "items", index, "id"]);
                        creditIds.add(id);
                        const expiresAt = optionalTimestamp(inputExpiresAt, [
                          "resetCredits",
                          "items",
                          index,
                          "expiresAt",
                        ]);
                        return { id, ...(expiresAt === undefined ? {} : { expiresAt }) };
                      }),
                    ),
                  );
            return {
              availableCount: resetCount(inputCount, ["resetCredits", "availableCount"]),
              ...(credits === undefined ? {} : { items: credits }),
            };
          });

    return { items, ...(resetCredits === undefined ? {} : { resetCredits }) };
  });
}
