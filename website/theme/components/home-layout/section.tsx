import { cn } from 'cn';

interface SectionProps {
  readonly id?: string;
  readonly kicker: string;
  readonly title: string;
  readonly body?: React.ReactNode;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export function Section({ id, kicker, title, body, className, children }: SectionProps) {
  return (
    <section id={id} className={cn('mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 lg:py-28', className)}>
      <div className="max-w-2xl">
        <p className="font-mono text-xs font-medium tracking-[0.2em] text-teal-700 uppercase dark:text-teal-400">
          {kicker}
        </p>
        <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
        {body ? <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">{body}</p> : null}
      </div>
      <div className="mt-12">{children}</div>
    </section>
  );
}
