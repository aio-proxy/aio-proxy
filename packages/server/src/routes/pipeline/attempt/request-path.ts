export function requestPathProperty(
  request: Request,
  urlTemplate?: string,
): { readonly requestPath?: string; readonly urlTemplate?: string } {
  try {
    return {
      requestPath: new URL(request.url).pathname,
      ...(urlTemplate === undefined ? {} : { urlTemplate }),
    };
  } catch {
    return urlTemplate === undefined ? {} : { urlTemplate };
  }
}
