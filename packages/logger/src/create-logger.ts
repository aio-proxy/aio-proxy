import type { LogBindings, Logger } from "@aio-proxy/plugin-sdk";

import { getLogger } from "@logtape/logtape";

import { redactSecretValues } from "./redact";

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

  const emit = (level: "debug" | "info" | "warning" | "error"): Emit => {
    const method = logTapeLogger[level].bind(logTapeLogger) as LogMethod;
    return (messageOrProps, propsOrMessage) => {
      if (typeof messageOrProps === "string") {
        const message = redactSecretValues(messageOrProps, secrets);
        const properties =
          propsOrMessage !== null && typeof propsOrMessage === "object" ? { ...bindings, ...propsOrMessage } : bindings;
        method(message, redactSecretValues(properties, secrets));
        return;
      }

      const properties = redactSecretValues({ ...bindings, ...messageOrProps }, secrets);
      if (typeof propsOrMessage === "string") {
        method(redactSecretValues(propsOrMessage, secrets), properties);
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
        bindings: { ...bindings, ...childBindings },
        redactSecretValues: secrets,
      }),
  };
}
