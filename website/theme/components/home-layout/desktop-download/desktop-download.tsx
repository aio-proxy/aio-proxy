import { Download } from 'lucide-react';
import { type ReactNode, useSyncExternalStore } from 'react';

import { useHomeCopy, useLocalePath } from '../use-home-copy';
import { type DesktopPlatform, detectPlatform } from './detect-platform';

// desktop/scripts/publish.ts (macOS) and publish-latest.ts (Linux, Windows) keep the feed's newest builds
// under these unversioned names.
const files: Record<DesktopPlatform, string> = {
  macos: 'aio-proxy-arm64.dmg',
  windows: 'aio-proxy-x64-setup.exe',
  'linux-x86_64': 'aio-proxy-x86_64.AppImage',
  'linux-aarch64': 'aio-proxy-aarch64.AppImage',
};

const noSubscription = () => () => {};
const currentPlatform = () => detectPlatform(navigator.userAgent, navigator.maxTouchPoints);

/** The desktop app download for the visitor's OS, or `fallback` where there is no build for it. */
export function DesktopDownload({ className, fallback }: { readonly className: string; readonly fallback: ReactNode }) {
  const copy = useHomeCopy();
  const docsLink = useLocalePath('/guide/start/install-deploy/desktop');
  // The page is prerendered without a navigator; the server snapshot keeps hydration on the fallback.
  const platform = useSyncExternalStore(noSubscription, currentPlatform, () => undefined);
  if (platform === undefined) return fallback;

  const { label, note } = copy.hero.downloads[platform];
  return (
    <div className="flex flex-col items-center gap-1.5">
      <a
        href={`https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/${files[platform]}`}
        className={className}
      >
        <Download className="size-4" aria-hidden />
        {label}
      </a>
      <span className="text-xs text-muted-foreground">
        {note} ·{' '}
        <a href={docsLink} className="underline underline-offset-2 hover:text-foreground">
          {copy.hero.otherDownloads}
        </a>
      </span>
    </div>
  );
}
