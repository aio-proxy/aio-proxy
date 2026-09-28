import { cn } from 'cn';

export function Panel({ className, children }: { readonly className?: string; readonly children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-3xl border border-border bg-card/80 home-shadow backdrop-blur-sm dark:border-white/10 dark:bg-olive-900/60',
        className,
      )}
    >
      {children}
    </div>
  );
}
