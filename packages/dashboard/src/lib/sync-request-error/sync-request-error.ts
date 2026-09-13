/** Thrown by the sync service and matched on by both the Settings and Providers modules. */
export class SyncRequestError extends Error {
  override readonly name = 'SyncRequestError';

  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
