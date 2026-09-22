import { m } from '@aio-proxy/i18n';
import { confirm, isCancel, multiselect, password, select, text } from '@clack/prompts';

export type PromptContext = { readonly signal?: AbortSignal };

export type TextAsk = {
  readonly message: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
};

export type PasswordAsk = { readonly message: string; readonly mask?: string };

export type ConfirmAsk = { readonly message: string; readonly initialValue?: boolean };

export type SelectChoice<T> = {
  readonly label: string;
  readonly value: T;
  readonly hint?: string;
};

export type SelectAsk<T> = {
  readonly message: string;
  readonly choices: readonly SelectChoice<T>[];
  readonly initialValue?: T;
};

export type PluginFormPrompts = {
  readonly input: (ask: TextAsk, context?: PromptContext) => Promise<string>;
  readonly password: (ask: PasswordAsk, context?: PromptContext) => Promise<string>;
  readonly confirm: (ask: ConfirmAsk, context?: PromptContext) => Promise<boolean>;
  readonly select: <T>(ask: SelectAsk<T>, context?: PromptContext) => Promise<T>;
};

export type ClackStreams = {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
};

export type ClackPromptFns = {
  text: (options: Record<string, unknown>) => Promise<unknown>;
  password: (options: Record<string, unknown>) => Promise<unknown>;
  confirm: (options: Record<string, unknown>) => Promise<unknown>;
  select: (options: Record<string, unknown>) => Promise<unknown>;
  multiselect: (options: Record<string, unknown>) => Promise<unknown>;
  isCancel: (value: unknown) => boolean;
};

const defaultFns: ClackPromptFns = {
  text: (options) => text(options as never),
  password: (options) => password(options as never),
  confirm: (options) => confirm(options as never),
  select: (options) => select(options as never),
  multiselect: (options) => multiselect(options as never),
  isCancel: (value) => isCancel(value),
};

export class PromptCancelledError extends Error {
  override readonly name = 'PromptCancelledError';
  constructor() {
    super('');
  }
}

function rejectIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

async function settle<T>(
  run: () => Promise<unknown>,
  signal: AbortSignal | undefined,
  cancelled: (value: unknown) => boolean,
): Promise<T> {
  rejectIfAborted(signal);
  const value = await run();
  rejectIfAborted(signal);
  if (cancelled(value)) throw new PromptCancelledError();
  return value as T;
}

export function createClackPrompts(
  streams: ClackStreams,
  fns: ClackPromptFns = defaultFns,
): PluginFormPrompts & {
  multiselect<T>(
    ask: SelectAsk<T> & { readonly initialValues?: readonly T[] },
    context?: PromptContext,
  ): Promise<readonly T[]>;
} {
  const io = { input: streams.input, output: streams.output };
  return {
    input: (ask, context) =>
      settle<string>(
        () =>
          fns.text({
            ...io,
            message: ask.message,
            ...(ask.placeholder === undefined ? {} : { placeholder: ask.placeholder }),
            ...(ask.defaultValue === undefined
              ? {}
              : { defaultValue: ask.defaultValue, initialValue: ask.defaultValue }),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    password: (ask, context) =>
      settle<string>(
        () =>
          fns.password({
            ...io,
            message: ask.message,
            mask: ask.mask ?? '*',
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    confirm: (ask, context) =>
      settle<boolean>(
        () =>
          fns.confirm({
            ...io,
            message: ask.message,
            initialValue: ask.initialValue ?? false,
            active: m['cli.ui.yes'](),
            inactive: m['cli.ui.no'](),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    select: <T>(ask: SelectAsk<T>, context?: PromptContext) =>
      settle<T>(
        () =>
          fns.select({
            ...io,
            message: ask.message,
            options: ask.choices.map((choice) => ({
              value: choice.value,
              label: choice.label,
              ...(choice.hint === undefined ? {} : { hint: choice.hint }),
            })),
            ...(ask.initialValue === undefined ? {} : { initialValue: ask.initialValue }),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
    multiselect: <T>(ask: SelectAsk<T> & { readonly initialValues?: readonly T[] }, context?: PromptContext) =>
      settle<readonly T[]>(
        () =>
          fns.multiselect({
            ...io,
            message: ask.message,
            required: false,
            options: ask.choices.map((choice) => ({
              value: choice.value,
              label: choice.label,
              ...(choice.hint === undefined ? {} : { hint: choice.hint }),
            })),
            ...(ask.initialValues === undefined ? {} : { initialValues: [...ask.initialValues] }),
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
          }),
        context?.signal,
        fns.isCancel,
      ),
  };
}
