import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { PluginIcon } from '@/components/plugin-icon';

import { PROVIDER_ICON_INSET } from '../../lib/constants';

interface ProviderAvatarProps {
  readonly name: string;
  readonly icon: string | undefined;
  readonly size: number;
  readonly className?: string;
}

/**
 * A plugin without an icon still needs a stable visual anchor, so the display name's first letter
 * stands in. Shared by the card and the quota dialog so both render the same mark for one Provider.
 *
 * The artwork carries its own inconsistent padding — some Lobe icons are ink edge-to-edge
 * (`codex-color`, `claude-color`), others reach only ~70% of the canvas (`anthropic`, `deepseek`).
 * Drawn at the raw box size they look like different sizes, so the icon is inset inside a fixed
 * frame: the frame is what the eye lines up on, and the padding difference shrinks with the art.
 *
 * The frame is a rounded square, not a circle: the full-bleed marks put ink in their corners, and a
 * circle would slice it off. The icon itself is never clipped — it is inset well inside the frame.
 */
export const ProviderAvatar: React.FC<ProviderAvatarProps> = ({ name, icon, size, className }) => (
  <span
    aria-hidden={icon === undefined ? 'true' : undefined}
    style={{ width: size, height: size }}
    className={cn('inline-flex shrink-0 items-center justify-center rounded-md bg-muted', className)}
  >
    {icon === undefined ? (
      <span className="text-xs font-medium">{name.charAt(0).toUpperCase()}</span>
    ) : (
      <PluginIcon icon={icon} size={Math.round(size * PROVIDER_ICON_INSET)} className="shrink-0" />
    )}
  </span>
);
