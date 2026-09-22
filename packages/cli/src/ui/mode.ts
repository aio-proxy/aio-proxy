export type PromptIo = {
  readonly stdinIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly env: NodeJS.ProcessEnv;
};

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function canPrompt(io: PromptIo): boolean {
  return io.stdinIsTTY && io.stderrIsTTY && !isCi(io.env);
}

export function useColor(streamIsTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  return streamIsTTY && env.NO_COLOR === undefined;
}
