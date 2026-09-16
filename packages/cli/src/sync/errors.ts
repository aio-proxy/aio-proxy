export class SyncCliError extends Error {
  override readonly name = 'SyncCliError';

  constructor(
    readonly code: string,
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}
