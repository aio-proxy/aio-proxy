import { Link } from '@rspress/core/theme';
import { ArrowRight, Download } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { GithubIcon } from '../icons';
import { InstallCommand } from './install-command';
import { RoutingVisual } from './routing-visual';
import { useHomeCopy, useLocalePath } from './use-home-copy';

// desktop/scripts/publish.ts keeps the feed's newest .dmg under this unversioned name.
const desktopDownloadUrl = 'https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/aio-proxy-arm64.dmg';
const secondaryClassName =
  'inline-flex items-center gap-2 rounded-full border border-border bg-background/70 px-6 py-3 text-sm font-semibold transition hover:bg-muted dark:border-white/15 dark:bg-white/5 dark:hover:bg-white/10';

// iPadOS reports a Macintosh user agent, so touch support tells it apart. Browsers do not reliably
// expose Intel vs Apple Silicon, so the button states the requirement instead of guessing.
const isMac = () => /Mac/u.test(navigator.userAgent) && navigator.maxTouchPoints <= 1;
const noSubscription = () => () => {};

export function Hero() {
  const copy = useHomeCopy();
  const startLink = useLocalePath('/guide/start/getting-started');
  // The page is prerendered without a navigator; the server snapshot keeps hydration on the GitHub button.
  const mac = useSyncExternalStore(noSubscription, isMac, () => false);

  return (
    <section className="relative mx-auto grid w-full max-w-6xl items-center gap-14 grid-cols-1 px-4 pt-16 pb-12 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-24">
      <div className="flex min-w-0 flex-col items-start gap-7">
        <span className="inline-flex items-center gap-2 rounded-full border border-teal-600/20 bg-teal-50/80 px-3 py-1 text-xs font-medium text-teal-800 dark:border-teal-400/20 dark:bg-teal-950/60 dark:text-teal-200">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full bg-teal-500 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-teal-500" />
          </span>
          {copy.hero.eyebrow}
        </span>
        <h1 className="break-keep font-heading text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-6xl">
          <span className="block">{copy.hero.titleLead}</span>
          <span className="block bg-linear-to-r from-teal-500 to-teal-800 bg-clip-text text-transparent dark:from-teal-300 dark:to-teal-500">
            {copy.hero.titleAccent}
          </span>
        </h1>
        <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">{copy.hero.tagline}</p>
        <div className="flex flex-wrap items-start gap-3">
          <Link
            href={startLink}
            className="group inline-flex items-center gap-2 rounded-full bg-teal-700 px-6 py-3 text-sm font-semibold text-white home-shadow transition hover:bg-teal-800 dark:bg-teal-500 dark:text-olive-950 dark:hover:bg-teal-400"
          >
            {copy.hero.primary}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          {mac ? (
            <div className="flex flex-col items-center gap-1.5">
              <a href={desktopDownloadUrl} className={secondaryClassName}>
                <Download className="size-4" aria-hidden />
                {copy.hero.download}
              </a>
              <span className="text-xs text-muted-foreground">{copy.hero.downloadRequirement}</span>
            </div>
          ) : (
            <a
              href="https://github.com/aio-proxy/aio-proxy"
              target="_blank"
              rel="noreferrer"
              className={secondaryClassName}
            >
              <GithubIcon className="size-4" aria-hidden />
              {copy.hero.secondary}
            </a>
          )}
        </div>
        <InstallCommand />
      </div>
      <RoutingVisual />
    </section>
  );
}
