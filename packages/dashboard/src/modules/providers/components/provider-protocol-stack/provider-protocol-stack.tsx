import type { ProviderProtocol } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { ProtocolLabel } from '@/components/protocol-label';

import { PROVIDER_FRAME_SIZE, PROVIDER_ICON_INSET } from '../../lib/constants';

const MAX_VISIBLE = 3;
const ICON_SIZE = Math.round(PROVIDER_FRAME_SIZE * PROVIDER_ICON_INSET);
// Tailwind cannot read a JS value, so the frame is sized inline to keep one source of truth with
// `ProviderAvatar` rather than a `size-6` that silently drifts from `PROVIDER_FRAME_SIZE`.
const FRAME = { width: PROVIDER_FRAME_SIZE, height: PROVIDER_FRAME_SIZE };

interface ProviderProtocolStackProps {
  readonly protocols: readonly ProviderProtocol[];
  readonly className?: string;
}

export const ProviderProtocolStack: React.FC<ProviderProtocolStackProps> = ({ protocols, className }) => {
  if (protocols.length === 0) return null;
  const visible = protocols.slice(0, MAX_VISIBLE);
  const overflow = protocols.length - visible.length;
  return (
    <span className={cn('inline-flex -space-x-1.5', className)} data-testid="provider-protocol-stack">
      {visible.map((protocol) => (
        <span
          key={protocol}
          style={FRAME}
          className="inline-flex items-center justify-center rounded-md bg-card ring-2 ring-card"
        >
          {/* The label is the accessible name; only the icon is drawn. Same inset as a single-mark
              avatar, so a stacked Provider's icons read at the same size as an unstacked one's. */}
          <ProtocolLabel protocol={protocol} showIcon iconSize={ICON_SIZE} className="[&>span:last-child]:sr-only" />
        </span>
      ))}
      {overflow > 0 ? (
        <span
          style={FRAME}
          className="inline-flex items-center justify-center rounded-md bg-muted text-[10px] font-medium ring-2 ring-card"
        >
          {`+${overflow}`}
        </span>
      ) : null}
    </span>
  );
};
