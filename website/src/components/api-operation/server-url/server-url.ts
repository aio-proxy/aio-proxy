export class InvalidDocumentationServerError extends Error {
  override name = 'InvalidDocumentationServerError';
}

export function selectedServer(input: string, pageOrigin: string): string {
  const server = input.trim();
  if (server.length === 0) throw new InvalidDocumentationServerError('empty server');

  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new InvalidDocumentationServerError('server must be an absolute HTTP or HTTPS server');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidDocumentationServerError('server must be an HTTP or HTTPS server');
  }
  if (url.origin === new URL(pageOrigin).origin) {
    throw new InvalidDocumentationServerError('server cannot use the documentation origin');
  }
  return server;
}
