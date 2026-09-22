import { m } from '@aio-proxy/i18n';
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  password,
  select,
  spinner,
  text,
  updateSettings,
} from '@clack/prompts';

import { canPrompt, type PromptIo } from './mode';
import {
  createClackPrompts,
  PromptCancelledError,
  type ClackPromptFns,
  type ClackStreams,
  type ConfirmAsk,
  type PluginFormPrompts,
  type PromptContext,
  type SelectAsk,
} from './prompts';

export type SessionIo = PromptIo & ClackStreams;
export type SessionCopy = { readonly cancelled: string; readonly error: string };

type SpinnerUi = {
  start: (message?: string) => void;
  clear: () => void;
  readonly isCancelled: boolean;
};

export type SessionChrome = {
  intro: (title?: string, options?: { output?: NodeJS.WritableStream }) => void;
  outro: (message?: string, options?: { output?: NodeJS.WritableStream }) => void;
  cancel: (message?: string, options?: { output?: NodeJS.WritableStream }) => void;
  note: (message?: string, title?: string, options?: { output?: NodeJS.WritableStream }) => void;
  updateSettings: (settings: { messages?: { cancel?: string; error?: string } }) => void;
  spinner: (options?: {
    output?: NodeJS.WritableStream;
    onCancel?: () => void;
    signal?: AbortSignal;
    cancelMessage?: string;
  }) => SpinnerUi;
  prompts: ClackPromptFns;
};

export type CommandSession = {
  readonly prompts: PluginFormPrompts;
  confirm(ask: ConfirmAsk, context?: PromptContext): Promise<boolean>;
  select<T>(ask: SelectAsk<T>, context?: PromptContext): Promise<T>;
  multiselect<T>(
    ask: SelectAsk<T> & { readonly initialValues?: readonly T[] },
    context?: PromptContext,
  ): Promise<readonly T[]>;
  spin<T>(message: string, task: (signal: AbortSignal) => Promise<T>, context?: PromptContext): Promise<T>;
  note(message: string): void;
  progress(message: string): void;
  finish(success: string): boolean;
  close(error?: unknown): void;
};

function blocksCi(env: NodeJS.ProcessEnv): boolean {
  const value = env['CI'];
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function shouldAnimateSpinner(io: PromptIo): boolean {
  return io.stderrIsTTY && !blocksCi(io.env);
}

function defaultChrome(): SessionChrome {
  return {
    intro: (value, options) => intro(value, options as never),
    outro: (value, options) => outro(value, options as never),
    cancel: (value, options) => cancel(value, options as never),
    note: (value, noteTitle, options) => note(value, noteTitle, options as never),
    updateSettings: (settings) => updateSettings(settings),
    spinner: (options) => {
      const ui = spinner(options as never);
      return {
        start: (message) => ui.start(message),
        clear: () => ui.clear(),
        get isCancelled() {
          return ui.isCancelled;
        },
      };
    },
    prompts: {
      text: (options) => text(options as never),
      password: (options) => password(options as never),
      confirm: (options) => confirm(options as never),
      select: (options) => select(options as never),
      multiselect: (options) => multiselect(options as never),
      isCancel: (value) => isCancel(value),
    },
  };
}

export function createCommandSession(
  title: string,
  io: SessionIo,
  copy: SessionCopy,
  chrome: SessionChrome = defaultChrome(),
): CommandSession {
  if (!canPrompt(io)) throw new Error('Refusing to open a prompt session without a TTY');
  chrome.updateSettings({ messages: { cancel: copy.cancelled, error: copy.error } });
  const raw = createClackPrompts(io, chrome.prompts);
  let introduced = false;
  let settled = false;
  let spinnerCancelLine = false;
  let activeSpinner: SpinnerUi | undefined;
  const ensureIntro = (): void => {
    if (introduced) return;
    introduced = true;
    chrome.intro(title, { output: io.output });
  };
  const prompts: PluginFormPrompts = {
    input: async (ask, context) => {
      ensureIntro();
      return raw.input(ask, context);
    },
    password: async (ask, context) => {
      ensureIntro();
      return raw.password(ask, context);
    },
    confirm: async (ask, context) => {
      ensureIntro();
      return raw.confirm(ask, context);
    },
    select: async (ask, context) => {
      ensureIntro();
      return raw.select(ask, context);
    },
  };
  return {
    prompts,
    confirm: prompts.confirm,
    select: prompts.select,
    multiselect: async (ask, context) => {
      ensureIntro();
      return raw.multiselect(ask, context);
    },
    note(message) {
      ensureIntro();
      chrome.note(message, undefined, { output: io.output });
    },
    progress(message) {
      io.output.write(`${message}\n`);
    },
    async spin<T>(message: string, task: (signal: AbortSignal) => Promise<T>, context?: PromptContext): Promise<T> {
      const external = context?.signal;
      if (external?.aborted) throw external.reason;
      if (!shouldAnimateSpinner(io)) {
        try {
          const result = await task(external ?? new AbortController().signal);
          if (external?.aborted) throw external.reason;
          return result;
        } catch (error) {
          if (external?.aborted) throw external.reason;
          throw error;
        }
      }
      const controller = new AbortController();
      const onExternal = (): void => {
        if (!controller.signal.aborted) controller.abort(external?.reason);
      };
      external?.addEventListener('abort', onExternal, { once: true });
      let userCancelled = false;
      const ui = chrome.spinner({
        output: io.output,
        signal: external,
        cancelMessage: copy.cancelled,
        onCancel: () => {
          spinnerCancelLine = true;
          userCancelled = true;
          if (controller.signal.aborted) return;
          controller.abort(external?.aborted ? external.reason : new PromptCancelledError());
        },
      });
      activeSpinner = ui;
      ui.start(message);
      try {
        const result = await task(controller.signal);
        if (external?.aborted) throw external.reason;
        if (userCancelled || ui.isCancelled) throw new PromptCancelledError();
        return result;
      } catch (error) {
        if (external?.aborted) throw external.reason;
        if (userCancelled || ui.isCancelled) throw new PromptCancelledError();
        throw error;
      } finally {
        external?.removeEventListener('abort', onExternal);
        ui.clear();
        if (activeSpinner === ui) activeSpinner = undefined;
      }
    },
    finish(success) {
      if (!introduced || settled) return false;
      chrome.outro(success, { output: io.output });
      settled = true;
      return true;
    },
    close(error) {
      activeSpinner?.clear();
      activeSpinner = undefined;
      if (settled || !introduced) return;
      settled = true;
      if (error instanceof PromptCancelledError && !spinnerCancelLine) {
        chrome.cancel(copy.cancelled, { output: io.output });
      }
    },
  };
}

export function openProductionSession(title: string): CommandSession {
  return createCommandSession(
    title,
    {
      stdinIsTTY: process.stdin.isTTY === true,
      stderrIsTTY: process.stderr.isTTY === true,
      env: process.env,
      input: process.stdin,
      output: process.stderr,
    },
    { cancelled: m['cli.ui.cancelled'](), error: m['cli.ui.error']() },
  );
}
