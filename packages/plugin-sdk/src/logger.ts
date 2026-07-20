export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogBindings = Readonly<Record<string, unknown>>;
export type Logger = {
  readonly debug: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly info: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly warn: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly error: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly child: (bindings: LogBindings) => Logger;
};
