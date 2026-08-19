const CURSOR_GROK = /^cursor-grok-(.+)$/;
// Cursor keeps the pre-4.8 Claude families as `claude-4.6-sonnet`; Anthropic
// publishes them as `claude-sonnet-4-6`.
const DOTTED_CLAUDE = /^claude-(\d+)\.(\d+)-(opus|sonnet|haiku|fable)$/;

export function rewriteAliasKey(name: string): string {
  const trimmed = name.trim();
  const grok = CURSOR_GROK.exec(trimmed);
  if (grok !== null) return `grok-${grok[1]}`;
  const claude = DOTTED_CLAUDE.exec(trimmed);
  if (claude !== null) return `claude-${claude[3]}-${claude[1]}-${claude[2]}`;
  return trimmed;
}
