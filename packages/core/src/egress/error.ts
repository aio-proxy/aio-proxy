import { AiSdkProviderError, ProviderNotInstalledError } from "../error";

type IngressProtocol = "openai";

type OpenAIErrorEnvelope = {
  readonly error: {
    readonly message: string;
    readonly type: "invalid_request_error";
    readonly code: string;
    readonly param?: string;
  };
};

export type IngressError = {
  readonly status: number;
  readonly body: OpenAIErrorEnvelope;
};

export function toIngressError(error: unknown, ingressProtocol: IngressProtocol): IngressError {
  switch (ingressProtocol) {
    case "openai":
      return toOpenAIError(error);
  }
}

function toOpenAIError(error: unknown): IngressError {
  const cause = unwrappedCause(error);

  if (isAbortError(cause)) {
    return envelope(499, "aborted", errorMessage(cause));
  }

  if (cause instanceof ProviderNotInstalledError) {
    return envelope(503, "provider_not_installed", cause.message);
  }

  const upstreamStatus = statusCode(cause);
  if (upstreamStatus !== undefined) {
    return envelope(upstreamStatus, "upstream_error", errorMessage(cause));
  }

  return envelope(500, "internal_error", errorMessage(cause));
}

function unwrappedCause(error: unknown): unknown {
  if (error instanceof AiSdkProviderError) {
    return error.cause;
  }

  return error;
}

function envelope(status: number, code: string, message: string): IngressError {
  return {
    status,
    body: {
      error: {
        code,
        message,
        type: "invalid_request_error",
      },
    },
  };
}

function statusCode(error: unknown): number | undefined {
  const statusCodeValue = property(error, "statusCode");
  if (typeof statusCodeValue === "number") {
    return statusCodeValue;
  }

  const statusValue = property(error, "status");
  if (typeof statusValue === "number") {
    return statusValue;
  }

  const responseValue = property(error, "response");
  const responseStatus = property(responseValue, "status");
  return typeof responseStatus === "number" ? responseStatus : undefined;
}

function isAbortError(error: unknown): boolean {
  return property(error, "name") === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  const message = property(error, "message");
  if (typeof message === "string") {
    return message;
  }

  return "Upstream provider error";
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return Reflect.get(value, key);
}
