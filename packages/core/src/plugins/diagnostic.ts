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

function safeFallback(): RedactedPluginError {
  return { name: "Error", message: SAFE_ERROR_MESSAGE };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  output = output.replace(
    /((?:["'])?\b(?:access_token|refresh_token|authorization_code|code_verifier|accessToken|refreshToken|code|state)\b(?:["'])?\s*(?:=|:)\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/giu,
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
