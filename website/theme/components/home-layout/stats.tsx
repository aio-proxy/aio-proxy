import { useHomeCopy } from './use-home-copy';

export function Stats() {
  const copy = useHomeCopy();
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-border bg-border sm:grid-cols-4 dark:border-white/10 dark:bg-white/10">
        {copy.stats.map((stat) => (
          <div key={stat.label} className="flex flex-col gap-1 bg-background px-6 py-6 dark:bg-olive-950">
            <dt className="order-2 text-sm text-muted-foreground">{stat.label}</dt>
            <dd className="order-1 font-heading text-3xl font-semibold tracking-tight text-teal-700 dark:text-teal-300">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
