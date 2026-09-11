export class SyncPreviewError extends Error {
  override readonly name = 'SyncPreviewError';

  constructor(readonly code: 'preview-stale' | 'not-connected' | 'invalid-request') {
    super(code);
  }
}
