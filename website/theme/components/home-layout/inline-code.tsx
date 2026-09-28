// Renders `inline code` spans inside short copy strings without pulling in a markdown parser.
export function InlineCode({ text }: { readonly text: string }) {
  return (
    <>
      {text.split('`').map((part, index) =>
        index % 2 === 1 ? (
          <code
            key={part}
            className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground dark:bg-white/10"
          >
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
