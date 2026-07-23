import type { Migration } from "./db/migrations.manifest";

export class AioProxyError extends Error {
  override readonly name: string;

  constructor(name: string, message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = name;
  }
}

export class RouterModelNotFoundError extends AioProxyError {
  readonly code = "MODEL_NOT_FOUND";
  readonly status = 404;

  constructor(readonly model: string) {
    super("RouterModelNotFoundError", `Model not found: ${model}`);
  }
}

export class RouterModelCollisionError extends AioProxyError {
  constructor(
    readonly alias: string,
    readonly firstProviderId: string,
    readonly secondProviderId: string,
  ) {
    super(
      "RouterModelCollisionError",
      `Model alias "${alias}" is exposed by both "${firstProviderId}" and "${secondProviderId}"`,
    );
  }
}

export class AiSdkProviderError extends AioProxyError {
  constructor(
    readonly providerId: string,
    cause: unknown,
  ) {
    super("AiSdkProviderError", `${providerId}: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

export class ProviderNotInstalledError extends AioProxyError {
  readonly hint: string;

  constructor(
    readonly providerId: string,
    readonly packageName: string,
  ) {
    const hint = `run aio-proxy provider install ${packageName}`;
    super(
      "ProviderNotInstalledError",
      `${providerId}: ai-sdk provider package "${packageName}" is not installed; ${hint}`,
    );
    this.hint = hint;
  }
}

export class AiSdkProviderLoaderError extends AioProxyError {
  constructor(message?: string) {
    super("AiSdkProviderLoaderError", message);
  }
}

export class NpmPackageNameError extends AioProxyError {
  constructor(readonly pkg: string) {
    super("NpmPackageNameError", `Invalid npm package name: ${pkg}`);
  }
}

export class NpmPackageJsonError extends AioProxyError {
  constructor(readonly path: string) {
    super("NpmPackageJsonError", `Invalid package.json: ${path}`);
  }
}

export class NpmPackageEntrypointError extends AioProxyError {
  constructor(readonly pkg: string) {
    super("NpmPackageEntrypointError", `Unable to resolve entrypoint for ${pkg}`);
  }
}

export class NpmInstallError extends AioProxyError {
  constructor(
    readonly pkg: string,
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super("NpmInstallError", `Runtime install failed for ${pkg}: ${output.trim()}`);
  }
}

export class NpmLockError extends AioProxyError {
  constructor(readonly pkg: string) {
    super("NpmLockError", `Unable to acquire install lock for ${pkg}`);
  }
}

export class DatabaseSchemaTooNewError extends AioProxyError {
  constructor(
    readonly actualVersion: number,
    readonly compiledVersion: number,
  ) {
    super(
      "DatabaseSchemaTooNewError",
      `database schema version ${actualVersion} is newer than this binary schema version ${compiledVersion}; please upgrade aio-proxy`,
    );
  }
}

export class MigrationHashMismatchError extends AioProxyError {
  constructor(
    readonly migration: Migration,
    readonly actualSha256: string,
  ) {
    super(
      "MigrationHashMismatchError",
      `migration v${migration.version} (${migration.file}) hash mismatch; binary expected ${migration.sha256}, got ${actualSha256}. Restore historical migration ${migration.file}. To change the schema, update the Drizzle schema and run \`bun run build:migrations\` to generate a new migration.`,
    );
  }
}

export class GeminiInlineDataTooLargeError extends AioProxyError {
  readonly code = "INLINE_DATA_TOO_LARGE";
  readonly status = 413;

  constructor(
    readonly path: string,
    readonly limitBytes: number,
    readonly actualBytes: number,
  ) {
    super(
      "GeminiInlineDataTooLargeError",
      `Gemini inlineData at ${path} is ${actualBytes} bytes; limit is ${limitBytes}`,
    );
  }
}

export class OpenAIResponsesUnsupportedFeatureError extends AioProxyError {
  readonly code = "UNSUPPORTED_OPENAI_RESPONSES_FEATURE";
  readonly status = 501;

  constructor(
    readonly feature: string,
    readonly path: string,
  ) {
    super("OpenAIResponsesUnsupportedFeatureError", `OpenAI Responses feature is not supported: ${feature} at ${path}`);
  }
}

export type ImageInputUnsupportedReason =
  | "assistant-image"
  | "gemini-assistant-url"
  | "gemini-tool-url"
  | "gemini-url-mime"
  | "image-detail"
  | "provider-reference"
  | "unknown-target";

export class ImageInputUnsupportedError extends AioProxyError {
  readonly code = "UNSUPPORTED_IMAGE_INPUT";

  constructor(
    readonly reason: ImageInputUnsupportedReason,
    readonly path: string,
  ) {
    super("ImageInputUnsupportedError", `Image input cannot be represented: ${reason} at ${path}`);
  }
}

export class OpenAICompletionsTransformError extends AioProxyError {
  constructor(readonly path: string) {
    super("OpenAICompletionsTransformError", `Invalid OpenAI Completions request at ${path}`);
  }
}

export class OpenAIResponsesTransformError extends AioProxyError {
  constructor(readonly path: string) {
    super("OpenAIResponsesTransformError", `Invalid OpenAI Responses request at ${path}`);
  }
}

export class AnthropicMessagesTransformError extends AioProxyError {
  constructor(readonly path: string) {
    super("AnthropicMessagesTransformError", `Invalid Anthropic Messages request at ${path}`);
  }
}

export class GeminiGenerateContentTransformError extends AioProxyError {
  constructor(readonly path: string) {
    super("GeminiGenerateContentTransformError", `Invalid Gemini generateContent request at ${path}`);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
