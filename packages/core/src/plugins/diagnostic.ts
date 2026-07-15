import { m } from "@aio-proxy/i18n";
import { type Diagnostic, type DiagnosticCode, PluginPackageNameSchema } from "@aio-proxy/types";

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

function diagnosticSummary(code: DiagnosticCode, context: DiagnosticContext): string {
  const pluginResult = PluginPackageNameSchema.safeParse(context.plugin);
  const plugin = pluginResult.success ? pluginResult.data : "<plugin>";
  const capability = /^[a-z0-9][a-z0-9._-]*$/u.test(context.capability ?? "")
    ? (context.capability as string)
    : "<capability>";
  const provider = /^[a-z0-9][a-z0-9._~-]*$/iu.test(context.providerId ?? "")
    ? (context.providerId as string)
    : "<provider>";
  switch (code) {
    case "PLUGIN_NOT_INSTALLED":
      return m.cli_plugin_diagnostic_plugin_not_installed({ plugin });
    case "PLUGIN_API_INCOMPATIBLE":
      return m.cli_plugin_diagnostic_plugin_api_incompatible({ plugin });
    case "PLUGIN_LOAD_FAILED":
      return m.cli_plugin_diagnostic_plugin_load_failed({ plugin });
    case "PLUGIN_OPTIONS_INVALID":
      return m.cli_plugin_diagnostic_plugin_options_invalid({ plugin });
    case "PROVIDER_CONFIG_INVALID":
      return m.cli_plugin_diagnostic_provider_config_invalid({ provider });
    case "LEGACY_OAUTH_CONFIG_UNSUPPORTED":
      return m.cli_plugin_diagnostic_legacy_oauth_config_unsupported({ provider });
    case "CAPABILITY_MISSING":
      return m.cli_plugin_diagnostic_capability_missing({ plugin, capability });
    case "ACCOUNT_OPTIONS_INVALID":
      return m.cli_plugin_diagnostic_account_options_invalid({ provider });
    case "CREDENTIALS_MISSING_OR_INVALID":
      return m.cli_plugin_diagnostic_credentials_missing_or_invalid({ provider });
    case "CREDENTIAL_REFRESH_FAILED":
      return m.cli_plugin_diagnostic_credential_refresh_failed({ provider });
    case "AUTHORIZATION_FAILED":
      return m.cli_plugin_diagnostic_authorization_failed({ provider });
    case "CATALOG_UNAVAILABLE":
      return m.cli_plugin_diagnostic_catalog_unavailable({ provider });
    case "RUNTIME_CREATE_FAILED":
      return m.cli_plugin_diagnostic_runtime_create_failed({ provider });
  }
}

export function createPluginDiagnosticFactory(now: () => number = Date.now): DiagnosticFactory {
  return (code, options) => ({
    code,
    summary: diagnosticSummary(code, options),
    retryable: options.retryable,
    occurredAt: new Date(now()).toISOString(),
    ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
  });
}

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
