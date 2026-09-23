import { describe, expect, test } from 'bun:test';

import { createClackPrompts, PromptCancelledError, type ClackPromptFns } from './prompts';

const streams = { input: process.stdin, output: process.stderr };
const CANCEL = Symbol('cancel');

function fake(overrides: Partial<ClackPromptFns> = {}): { fns: ClackPromptFns; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const record =
    (name: string, value: unknown) =>
    async (options: Record<string, unknown>): Promise<unknown> => {
      calls.push({ name, ...options });
      return value;
    };
  return {
    calls,
    fns: {
      text: record('text', ''),
      password: record('password', ''),
      confirm: record('confirm', false),
      select: record('select', undefined),
      multiselect: record('multiselect', []),
      isCancel: (value) => value === CANCEL,
      ...overrides,
    },
  };
}

describe('createClackPrompts', () => {
  test('passes placeholder through and returns an empty submit as an empty string', async () => {
    const { fns, calls } = fake();
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Name', placeholder: 'Ada' })).resolves.toBe('');
    expect(calls[0]).toMatchObject({
      name: 'text',
      message: 'Name',
      placeholder: 'Ada',
      input: streams.input,
      output: streams.output,
    });
    expect(calls[0]).not.toHaveProperty('defaultValue');
    expect(calls[0]).not.toHaveProperty('initialValue');
  });

  test('sends a text default as both initialValue and defaultValue and returns that default', async () => {
    const { fns, calls } = fake({
      text: async (options) => {
        calls.push({ name: 'text', ...options });
        return options.defaultValue ?? '';
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Endpoint', defaultValue: 'https://old.test' })).resolves.toBe(
      'https://old.test',
    );
    expect(calls[0]).toMatchObject({ initialValue: 'https://old.test', defaultValue: 'https://old.test' });
  });

  test('asks for a secret with mask * and returns an empty string', async () => {
    const { fns, calls } = fake();
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.password({ message: 'Token', mask: '*' })).resolves.toBe('');
    expect(calls[0]).toMatchObject({ name: 'password', message: 'Token', mask: '*' });
    expect(calls[0]).not.toHaveProperty('defaultValue');
    expect(calls[0]).not.toHaveProperty('initialValue');
  });

  test('returns select values 0 and false unchanged', async () => {
    const { fns } = fake({
      select: async (options) => (options.options as { value: unknown }[])[0]?.value,
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.select({ message: 'Count', choices: [{ label: 'Zero', value: 0 }] })).resolves.toBe(0);
    await expect(prompts.select({ message: 'Flag', choices: [{ label: 'No', value: false }] })).resolves.toBe(false);
  });

  test('starts confirm at no when initialValue is omitted and localizes yes and no', async () => {
    const { fns, calls } = fake({
      confirm: async (options) => {
        calls.push(options);
        return options.initialValue;
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.confirm({ message: 'Trust?' })).resolves.toBe(false);
    expect(calls[0]).toMatchObject({ initialValue: false, active: 'Yes', inactive: 'No' });
    await expect(prompts.confirm({ message: 'Trust?', initialValue: true })).resolves.toBe(true);
  });

  test('turns a Clack cancel value into PromptCancelledError and does not exit', async () => {
    const exit = process.exit;
    let exited = false;
    process.exit = (() => {
      exited = true;
    }) as typeof process.exit;
    try {
      const { fns } = fake({ text: async () => CANCEL });
      const prompts = createClackPrompts(streams, fns);
      const error = await prompts.input({ message: 'Name' }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PromptCancelledError);
      expect((error as PromptCancelledError).message).toBe('');
      expect(exited).toBe(false);
    } finally {
      process.exit = exit;
    }
  });

  test('rejects an already aborted signal with signal.reason and does not call Clack', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const { fns } = fake({
      text: async () => {
        called = true;
        return 'x';
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Name' }, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(called).toBe(false);
  });

  test('prefers signal.reason when the signal aborts during the prompt', async () => {
    const controller = new AbortController();
    const { fns } = fake({
      text: async () => {
        controller.abort();
        return CANCEL;
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(prompts.input({ message: 'Name' }, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
  });

  test('multiselect passes required false, initial values, and preserves 0', async () => {
    const { fns, calls } = fake({
      multiselect: async (options) => {
        calls.push(options);
        return [0];
      },
    });
    const prompts = createClackPrompts(streams, fns);
    await expect(
      prompts.multiselect({
        message: 'Sources',
        choices: [{ label: 'Zero', value: 0 }],
        initialValues: [0],
      }),
    ).resolves.toEqual([0]);
    expect(calls[0]).toMatchObject({
      required: false,
      initialValues: [0],
      input: streams.input,
      output: streams.output,
    });
  });
});
