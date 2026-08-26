export function requestPathProperty(request: Request): { readonly requestPath: string } | Record<never, never> {
  try {
    return { requestPath: new URL(request.url).pathname };
  } catch {
    return {};
  }
}
