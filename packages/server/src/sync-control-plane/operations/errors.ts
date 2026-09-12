export class SyncOperationError extends Error {
  override readonly name = 'SyncOperationError';
  constructor(
    readonly code:
      | 'not-connected'
      | 'dependency-in-use'
      | 'detach-required'
      | 'operation-pending'
      | 'upgrade-required'
      | 'backend-unavailable',
  ) {
    super(code);
  }
}
