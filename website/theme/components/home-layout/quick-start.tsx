import { Link } from '@rspress/core/theme';
import { ArrowRight } from 'lucide-react';

import { GithubIcon } from '../icons';
import { Section } from './section';
import { useHomeCopy, useLocalePath } from './use-home-copy';

export function QuickStart() {
  const copy = useHomeCopy();
  const startLink = useLocalePath('/guide/start/getting-started');

  return (
    <Section kicker={copy.start.kicker} title={copy.start.title} className="pb-10 lg:pb-14">
      <ol className="grid gap-4 md:grid-cols-3">
        {copy.start.steps.map((step, index) => (
          <li
            key={step.title}
            className="flex flex-col gap-4 rounded-3xl border border-border bg-card/70 p-6 dark:border-white/10 dark:bg-white/5"
          >
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-teal-700 font-heading text-sm font-semibold text-white dark:bg-teal-500 dark:text-olive-950">
                {index + 1}
              </span>
              <h3 className="font-heading text-lg font-semibold">{step.title}</h3>
            </div>
            <p className="text-sm text-muted-foreground">{step.body}</p>
            <code className="mt-auto block overflow-x-auto rounded-xl border border-(--home-code-border) bg-(--home-code-bg) px-4 py-3 font-mono text-xs whitespace-nowrap text-(--home-code-fg)">
              <span className="text-(--home-code-accent) select-none">$ </span>
              {step.code}
            </code>
          </li>
        ))}
      </ol>

      <div className="relative mt-16 overflow-hidden rounded-[2rem] border border-teal-600/15 bg-teal-50 px-6 py-14 text-center sm:px-12 dark:border-white/10 dark:bg-olive-950">
        <div
          className="absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,var(--color-teal-200),transparent)] dark:bg-[radial-gradient(60%_80%_at_50%_0%,var(--color-teal-700),transparent)] dark:opacity-60"
          aria-hidden
        />
        <div className="relative flex flex-col items-center gap-5">
          <h2 className="max-w-2xl font-heading text-3xl font-semibold tracking-tight text-balance text-olive-950 sm:text-4xl dark:text-olive-50">
            {copy.start.ctaTitle}
          </h2>
          <p className="text-olive-600 dark:text-olive-300">{copy.start.ctaBody}</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              href={startLink}
              className="inline-flex items-center gap-2 rounded-full bg-teal-700 px-6 py-3 text-sm font-semibold text-white home-shadow transition hover:bg-teal-800 dark:bg-teal-400 dark:text-olive-950 dark:hover:bg-teal-300"
            >
              {copy.hero.primary}
              <ArrowRight className="size-4" />
            </Link>
            <a
              href="https://github.com/aio-proxy/aio-proxy"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-olive-300 bg-white/70 px-6 py-3 text-sm font-semibold text-olive-950 transition hover:bg-white dark:border-white/20 dark:bg-transparent dark:text-olive-50 dark:hover:bg-white/10"
            >
              <GithubIcon className="size-4" aria-hidden />
              GitHub
            </a>
          </div>
        </div>
      </div>
    </Section>
  );
}
