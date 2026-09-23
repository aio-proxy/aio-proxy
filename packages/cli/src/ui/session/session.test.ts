import { describe, expect, test } from 'bun:test';
import { Readable, Writable } from 'node:stream';

import { spinner } from '@clack/prompts';

import { PromptCancelledError } from '../prompts';
import { createCommandSession, shouldAnimateSpinner, type SessionChrome } from './session';

const copy = { cancelled: 'Cancelled', error: 'Something went wrong' };
const title = 'aio-proxy · Configure plugin';

function memoryOutput(): { output: Writable; text: () => string } {
  let body = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
  });
  return { output, text: () => body };
}

function recording(): { chrome: SessionChrome; events: string[]; cancelSpinner: () => void } {
  const events: string[] = [];
  let cancelled = false;
  let onCancel: (() => void) | undefined;
  return {
    events,
    cancelSpinner() {
      cancelled = true;
      onCancel?.();
    },
    chrome: {
      intro(value) {
        events.push(`intro:${value ?? ''}`);
      },
      outro(value) {
        events.push(`outro:${value ?? ''}`);
      },
      cancel(value) {
        events.push(`cancel:${value ?? ''}`);
      },
      note(value, noteTitle) {
        events.push(`note:${value ?? ''}:${noteTitle ?? ''}`);
      },
      updateSettings(settings) {
        events.push(`settings:${settings.messages?.cancel ?? ''}:${settings.messages?.error ?? ''}`);
      },
      spinner(options) {
        onCancel = options?.onCancel;
        return {
          start(message) {
            events.push(`start:${message ?? ''}`);
          },
          clear() {
            events.push('clear');
          },
          get isCancelled() {
            return cancelled;
          },
        };
      },
      prompts: {
        text: async () => 'ok',
        password: async () => '',
        confirm: async () => false,
        select: async () => 'us',
        multiselect: async () => [],
        isCancel: () => false,
      },
    },
  };
}

function open(chrome: SessionChrome, output: Writable = memoryOutput().output) {
  return createCommandSession(
    title,
    { stdinIsTTY: true, stderrIsTTY: true, env: {}, input: process.stdin, output },
    copy,
    chrome,
  );
}

describe('createCommandSession', () => {
  test('refuses a non-TTY session without reading stdin', () => {
    let read = false;
    const input = new Readable({
      read() {
        read = true;
        this.destroy(new Error('read stdin'));
      },
    });
    expect(() =>
      createCommandSession(
        title,
        { stdinIsTTY: false, stderrIsTTY: true, env: {}, input, output: memoryOutput().output },
        copy,
        recording().chrome,
      ),
    ).toThrow('Refusing to open a prompt session without a TTY');
    expect(read).toBe(false);
  });

  test('prints one intro on the first prompt and one outro only after that intro', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    expect(session.finish('Saved')).toBe(false);
    expect(rec.events.some((event) => event.startsWith('outro:'))).toBe(false);
    await session.prompts.input({ message: 'Name' });
    await session.prompts.input({ message: 'Name again' });
    expect(rec.events.filter((event) => event.startsWith('intro:'))).toEqual([`intro:${title}`]);
    expect(session.finish('Saved')).toBe(true);
    expect(session.finish('Saved')).toBe(false);
    const later = new Error('later');
    session.close(later);
    expect(later.message).toBe('later');
    expect(rec.events.filter((event) => event.startsWith('outro:'))).toEqual(['outro:Saved']);
    expect(rec.events.some((event) => event.startsWith('cancel:'))).toBe(false);
  });

  test('cancel after a prompt is one cancel line', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    await session.prompts.input({ message: 'Name' });
    session.close(new PromptCancelledError());
    expect(rec.events).toContain('cancel:Cancelled');
    expect(rec.events.some((event) => event.startsWith('outro:'))).toBe(false);
  });

  test('a business error after a prompt is not printed and is not mutated', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    await session.prompts.input({ message: 'Name' });
    const error = new Error('unknown plugin secret');
    session.close(error);
    expect(error.message).toBe('unknown plugin secret');
    expect(rec.events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);
    expect(rec.events.join('\n')).not.toContain('unknown plugin secret');
  });

  test('close with no error or an empty message prints nothing', async () => {
    const silent = recording();
    const session = open(silent.chrome);
    await session.prompts.input({ message: 'Name' });
    session.close();
    expect(silent.events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);

    const empty = recording();
    const second = open(empty.chrome);
    await second.prompts.input({ message: 'Name' });
    second.close(new Error(''));
    expect(empty.events.some((event) => event.startsWith('outro:') || event.startsWith('cancel:'))).toBe(false);
  });

  test('a note introduces the session once and spin does not', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    session.note('No key');
    expect(rec.events).toContain('note:No key:');
    expect(rec.events.filter((event) => event.startsWith('intro:'))).toHaveLength(1);
    await expect(session.spin('load', async () => 7)).resolves.toBe(7);
    expect(rec.events).toContain('start:load');
    expect(rec.events).toContain('clear');
    expect(rec.events.filter((event) => event.startsWith('intro:'))).toHaveLength(1);
  });

  test('cancelling a spinner aborts the still-running task before spin settles', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    let sawAbort = false;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = session.spin('load', (signal) => {
      started();
      return new Promise<number>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            resolve(1);
          },
          { once: true },
        );
      });
    });
    await ready;
    rec.cancelSpinner();
    await expect(pending).rejects.toBeInstanceOf(PromptCancelledError);
    expect(sawAbort).toBe(true);
    session.close(new PromptCancelledError());
    expect(rec.events.filter((event) => event.startsWith('cancel:'))).toEqual([]);
    expect(rec.events.some((event) => event.startsWith('intro:'))).toBe(false);
  });

  test('an external abort rejects signal.reason while the task is still running', async () => {
    const rec = recording();
    const session = open(rec.chrome);
    const controller = new AbortController();
    const reason = new Error('stop-scan');
    let sawAbort = false;
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = session.spin(
      'load',
      (signal) => {
        started();
        return new Promise<number>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve(1);
            },
            { once: true },
          );
        });
      },
      { signal: controller.signal },
    );
    await ready;
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(sawAbort).toBe(true);
    expect(rec.events.some((event) => event.startsWith('cancel:'))).toBe(false);
  });

  test('a real Clack spinner prints its cancel line before onCancel and clear cannot remove it', () => {
    let body = '';
    const output = new Writable({
      write(chunk, _encoding, callback) {
        body += String(chunk);
        callback();
      },
    });
    let onCancelRan = false;
    const ui = spinner({
      output,
      cancelMessage: 'spinner-cancelled',
      onCancel: () => {
        onCancelRan = true;
      },
    });
    const exit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
      return undefined as never;
    }) as typeof process.exit;
    try {
      ui.start('scan');
      process.emit('SIGINT');
      const afterCancel = body;
      ui.clear();
      expect(onCancelRan).toBe(true);
      expect(afterCancel).toContain('spinner-cancelled');
      expect(body).toBe(afterCancel);
      expect(exited).toBe(false);
    } finally {
      ui.clear();
      process.exit = exit;
    }
  });

  test('progress is one static line and settings are applied once', () => {
    const rec = recording();
    const sink = memoryOutput();
    const session = open(rec.chrome, sink.output);
    session.progress('Loading');
    expect(sink.text()).toBe('Loading\n');
    expect(sink.text()).not.toContain('\u001b');
    expect(rec.events.some((event) => event.startsWith('intro:'))).toBe(false);
    expect(rec.events.filter((event) => event.startsWith('settings:'))).toEqual([
      'settings:Cancelled:Something went wrong',
    ]);
  });
});

describe('shouldAnimateSpinner', () => {
  test('animates only a stderr TTY outside CI', () => {
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: true, env: {} })).toBe(true);
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: false, env: {} })).toBe(false);
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: true, env: { CI: 'true' } })).toBe(false);
    expect(shouldAnimateSpinner({ stdinIsTTY: true, stderrIsTTY: true, env: { CI: '0' } })).toBe(true);
  });
});
