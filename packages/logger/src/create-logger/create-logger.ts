import type { LogBindings, Logger } from "@aio-proxy/plugin-sdk";

import { getLogger } from "@logtape/logtape";

import { redactLogText, redactLogValue } from "../redact";

type LoggerOptions = {
  readonly bindings?: LogBindings;
  readonly redactSecretValues?: readonly string[];
};

type LogMethod = Logger["info"];
type Emit = (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;

export function createLogger(category: readonly string[], options: LoggerOptions = {}): Logger {
  const logTapeLogger = getLogger(category);
  const bindings = options.bindings ?? {};
  const secrets = options.redactSecretValues ?? [];
  const shouldRedact = secrets.some((secret) => secret.length > 0);

  const redactionFailure = (): LogBindings => {
    const redacted = redactLogValue({ message: "log redaction failed" }, secrets);
    return isLogBindings(redacted) ? redacted : {};
  };

  const mergeProperties = (properties: LogBindings): LogBindings => {
    const redacted = redactLogValue([bindings, properties], secrets);
    if (!Array.isArray(redacted) || redacted.length !== 2) return redactionFailure();
    const [redactedBindings, redactedProperties] = redacted;
    if (!isLogBindings(redactedBindings) || !isLogBindings(redactedProperties)) return redactionFailure();
    return { ...redactedBindings, ...redactedProperties };
  };

  const emit = (level: "debug" | "info" | "warning" | "error"): Emit => {
    const method = logTapeLogger[level].bind(logTapeLogger) as LogMethod;
    return (messageOrProps, propsOrMessage) => {
      if (typeof messageOrProps === "string") {
        const message = shouldRedact ? redactLogText(messageOrProps, secrets) : messageOrProps;
        const properties =
          propsOrMessage !== null && typeof propsOrMessage === "object"
            ? mergeProperties(propsOrMessage)
            : mergeProperties({});
        method(message, properties);
        return;
      }

      const properties = mergeProperties(messageOrProps);
      if (typeof propsOrMessage === "string") {
        method(shouldRedact ? redactLogText(propsOrMessage, secrets) : propsOrMessage, properties);
      } else {
        method(properties);
      }
    };
  };

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warning"),
    error: emit("error"),
    child: (childBindings) =>
      createLogger(category, {
        bindings: mergeProperties(childBindings),
        redactSecretValues: secrets,
      }),
  };
}

function isLogBindings(value: unknown): value is LogBindings {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
