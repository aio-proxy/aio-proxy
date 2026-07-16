import { z } from "zod";

export type LocaleTextMap = Readonly<{ readonly default: string } & Readonly<Record<string, string>>>;
export type LocalizedText = string | LocaleTextMap;

function materialize(value: unknown): LocalizedText | undefined {
  if (typeof value === "string") return value.trim() === "" || value.trim() !== value ? undefined : value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const copy = Object.create(null) as Record<string, string>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    if (
      typeof descriptor.value !== "string" ||
      descriptor.value.trim() === "" ||
      descriptor.value.trim() !== descriptor.value
    ) {
      return undefined;
    }
    if (key !== "default") {
      try {
        if (Intl.getCanonicalLocales(key)[0] !== key) return undefined;
      } catch {
        return undefined;
      }
    }
    copy[key] = descriptor.value;
  }
  if (!Object.hasOwn(copy, "default")) return undefined;
  return Object.fromEntries(Object.entries(copy)) as LocaleTextMap;
}

export const LocalizedTextSchema = z
  .custom<LocalizedText>((value) => materialize(value) !== undefined)
  .transform((value) => materialize(value) as LocalizedText);

export function resolveLocalizedText(text: LocalizedText, locale: string): string {
  if (typeof text === "string") return text;
  try {
    const exact = Intl.getCanonicalLocales(locale)[0];
    if (exact === undefined) return text.default;
    const parsed = new Intl.Locale(exact);
    const languageScript = parsed.script === undefined ? undefined : `${parsed.language}-${parsed.script}`;
    for (const candidate of [exact, languageScript, parsed.language]) {
      if (candidate !== undefined && text[candidate] !== undefined) return text[candidate];
    }
  } catch {}
  return text.default;
}
