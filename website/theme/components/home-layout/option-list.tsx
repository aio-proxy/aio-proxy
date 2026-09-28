import { cn } from 'cn';

export function OptionList<T extends { readonly id: string; readonly name: string }>({
  label,
  items,
  selected,
  onSelect,
  detail,
}: {
  readonly label: string;
  readonly items: readonly T[];
  readonly selected: string;
  readonly onSelect: (id: T['id']) => void;
  readonly detail?: (item: T) => string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      <p className="mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">{label}</p>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={selected === item.id}
          onClick={() => onSelect(item.id)}
          className={cn(
            'rounded-xl border px-4 py-2.5 text-left text-sm transition-all',
            selected === item.id
              ? 'border-teal-500 bg-teal-50 font-semibold text-teal-900 dark:bg-teal-950/70 dark:text-teal-100'
              : 'border-border bg-background/60 hover:border-teal-500/40 dark:border-white/10 dark:bg-white/5',
          )}
        >
          <span className="block">{item.name}</span>
          {detail ? <span className="block font-mono text-[11px] text-muted-foreground">{detail(item)}</span> : null}
        </button>
      ))}
    </div>
  );
}
