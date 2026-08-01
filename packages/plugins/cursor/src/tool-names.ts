export const CURSOR_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'read',
  'write',
  'delete',
  'ls',
  'grep',
  'lsp',
  'todo',
]);

export const AIO_PROXY_TOOL_PREFIX = 'aio_proxy__';

// Pure, deterministic escaping: prefix a caller tool only when it collides with
// a Cursor native name, and strip the prefix only when the remainder is itself
// reserved. Outbound same-name collision (a caller tool literally named
// `aio_proxy__read`) is intentionally not handled.
export function toWireName(name: string): string {
  return CURSOR_NATIVE_TOOL_NAMES.has(name) ? `${AIO_PROXY_TOOL_PREFIX}${name}` : name;
}

export function fromWireName(name: string): string {
  if (!name.startsWith(AIO_PROXY_TOOL_PREFIX)) return name;
  const original = name.slice(AIO_PROXY_TOOL_PREFIX.length);
  return CURSOR_NATIVE_TOOL_NAMES.has(original) ? original : name;
}
