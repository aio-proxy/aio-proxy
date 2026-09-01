import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { PluginIcon } from '@/components/plugin-icon';

interface ProviderAvatarProps {
  readonly name: string;
  readonly icon: string | undefined;
  readonly size: number;
  readonly className?: string;
}

/**
 * A plugin without an icon still needs a stable visual anchor, so the display name's first letter
 * stands in. Shared by the card and the quota dialog so both render the same mark for one Provider.
 */
export const ProviderAvatar: React.FC<ProviderAvatarProps> = ({ name, icon, size, className }) =>
  icon === undefined ? (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium',
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  ) : (
    <PluginIcon icon={icon} size={size} className={cn('shrink-0 rounded-full', className)} />
  );
