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

// Pure, deterministic escaping: native names and the escape namespace itself
// gain one prefix, making every valid caller name reversible.
export function toWireName(name: string): string {
  return CURSOR_NATIVE_TOOL_NAMES.has(name) || name.startsWith(AIO_PROXY_TOOL_PREFIX)
    ? `${AIO_PROXY_TOOL_PREFIX}${name}`
    : name;
}

export function fromWireName(name: string): string {
  if (!name.startsWith(AIO_PROXY_TOOL_PREFIX)) return name;
  if (name.startsWith(`${AIO_PROXY_TOOL_PREFIX}${AIO_PROXY_TOOL_PREFIX}`)) {
    return name.slice(AIO_PROXY_TOOL_PREFIX.length);
  }
  const original = name.slice(AIO_PROXY_TOOL_PREFIX.length);
  return CURSOR_NATIVE_TOOL_NAMES.has(original) ? original : name;
}
