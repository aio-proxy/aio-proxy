export type CursorCompletedToolCall = {
  readonly outerCallId: string;
  readonly nestedToolCallId: string;
  readonly toolName: string;
  readonly input: string;
};
