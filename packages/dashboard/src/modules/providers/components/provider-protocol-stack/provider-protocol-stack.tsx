import type { ProviderProtocol } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { ProtocolLabel } from '@/components/protocol-label';

const MAX_VISIBLE = 3;

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
          className="inline-flex size-6 items-center justify-center rounded-full bg-card ring-2 ring-card"
        >
          {/* The label is the accessible name; only the icon is drawn. */}
          <ProtocolLabel protocol={protocol} showIcon className="[&>span:last-child]:sr-only" />
        </span>
      ))}
      {overflow > 0 ? (
        <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium ring-2 ring-card">
          {`+${overflow}`}
        </span>
      ) : null}
    </span>
  );
};
