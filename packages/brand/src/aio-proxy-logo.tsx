import { cn } from 'cn';
import type { ComponentProps } from 'react';

import { WORDMARK_PATH, WORDMARK_VIEW_BOX } from './logo-geometry';

type AioProxyLogoProps = Omit<ComponentProps<'svg'>, 'viewBox' | 'children'>;

export function AioProxyLogo({ className, ...props }: AioProxyLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={WORDMARK_VIEW_BOX}
      fill="currentColor"
      aria-label="AIO Proxy"
      role="img"
      className={cn('h-[1.333em] w-auto shrink-0 text-lg text-foreground', className)}
      {...props}
    >
      <title>AIO Proxy</title>
      <path d={WORDMARK_PATH} />
    </svg>
  );
}
