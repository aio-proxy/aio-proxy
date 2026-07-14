import type { Diagnostic, DiagnosticCode } from "@aio-proxy/types";

export type DiagnosticContext = {
  readonly plugin?: string;
  readonly capability?: string;
  readonly providerId?: string;
};

export type DiagnosticFactory = (
  code: DiagnosticCode,
  options: DiagnosticContext & {
    readonly retryable: boolean;
    readonly suggestedCommand?: string;
  },
) => Diagnostic;

export type PluginLogSink = (entry: {
  readonly event: string;
  readonly code: DiagnosticCode;
  readonly context: DiagnosticContext;
  readonly error: { readonly name: string; readonly message: string; readonly stack?: string };
}) => void;

export type PluginErrorRedaction = {
  readonly secretValues?: readonly string[];
};

export type RedactedPluginError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
};

const SAFE_ERROR_MESSAGE = "Plugin error details unavailable";
const SENSITIVE_FIELDS = new Set([
  "access_token",
  "refresh_token",
  "authorization_code",
  "code",
  "code_verifier",
  "state",
  "accessToken",
  "refreshToken",
]);

function safeFallback(): RedactedPluginError {
  return { name: "Error", message: SAFE_ERROR_MESSAGE };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonStringEnd(input: string, start: number): number | undefined {
  for (let index = start + 1; index < input.length; index++) {
    if (input[index] === "\\") {
      index++;
    } else if (input[index] === '"') {
      return index + 1;
    }
  }
  return undefined;
}

function redactJsonQuotedFields(input: string): string {
  let output = "";
  let cursor = 0;
  let index = 0;
  while (index < input.length) {
    if (input[index] !== '"') {
      index++;
      continue;
    }
    const keyEnd = jsonStringEnd(input, index);
    if (keyEnd === undefined) break;
    let key: unknown;
    try {
      key = JSON.parse(input.slice(index, keyEnd));
    } catch {
      index = keyEnd;
      continue;
    }
    if (typeof key !== "string" || !SENSITIVE_FIELDS.has(key)) {
      index = keyEnd;
      continue;
    }
    let separator = keyEnd;
    while (/\s/u.test(input[separator] ?? "")) separator++;
    if (input[separator] !== ":") {
      index = keyEnd;
      continue;
    }
    let valueStart = separator + 1;
    while (/\s/u.test(input[valueStart] ?? "")) valueStart++;
    if (input[valueStart] !== '"') {
      index = keyEnd;
      continue;
    }
    const valueEnd = jsonStringEnd(input, valueStart);
    if (valueEnd === undefined) break;
    output += `${input.slice(cursor, valueStart)}"[REDACTED]"`;
    cursor = valueEnd;
    index = valueEnd;
  }
  return `${output}${input.slice(cursor)}`;
}

function redactText(input: string, secretValues: readonly string[]): string {
  let output = input;
  for (const secret of [...secretValues].filter((value) => value.length > 0).sort((a, b) => b.length - a.length)) {
    output = output.replace(new RegExp(escapeRegExp(secret), "gu"), "[REDACTED]");
  }
  output = output.replace(
    /\bhttps?:\/\/[^\s"'<>?]+\?[^\s"'<>]*/giu,
    (url) => `${url.slice(0, url.indexOf("?"))}?[REDACTED]`,
  );
  output = output.replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]");
  output = redactJsonQuotedFields(output);
  output = output.replace(
    /((?:["'])?\b(?:access_token|refresh_token|authorization_code|code_verifier|accessToken|refreshToken|code|state)\b(?:["'])?\s*(?:=|:)\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;&}]+)/giu,
    "$1[REDACTED]",
  );
  return output;
}

export function redactPluginError(error: unknown, redaction: PluginErrorRedaction = {}): RedactedPluginError {
  try {
    const secretValues = redaction.secretValues ?? [];
    if (error instanceof Error) {
      const name = typeof error.name === "string" ? error.name : "Error";
      const message = typeof error.message === "string" ? error.message : SAFE_ERROR_MESSAGE;
      const stack = typeof error.stack === "string" ? error.stack : undefined;
      return {
        name,
        message: redactText(message, secretValues),
        ...(stack === undefined ? {} : { stack: redactText(stack, secretValues) }),
      };
    }
    return { name: "Error", message: redactText(String(error), secretValues) };
  } catch {
    return safeFallback();
  }
}
