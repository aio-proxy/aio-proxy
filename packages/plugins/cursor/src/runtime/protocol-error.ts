export type CursorProtocolErrorCode =
  | 'cursor_interaction_unsupported'
  | 'cursor_tool_input_incomplete'
  | 'cursor_tool_input_invalid'
  | 'cursor_tool_identity_conflict'
  | 'cursor_stream_incomplete'
  | 'cursor_first_frame_timeout'
  | 'cursor_frame_silence_timeout'
  | 'cursor_no_progress_timeout';

export class CursorProtocolError extends Error {
  readonly code: CursorProtocolErrorCode;
  constructor(code: CursorProtocolErrorCode, message: string) {
    super(message);
    this.name = 'CursorProtocolError';
    this.code = code;
  }
}
