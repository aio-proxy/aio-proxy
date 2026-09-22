import { type DashboardProviderSummary, ProviderKind } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { AlertTriangle } from 'lucide-react';

import { PROVIDER_FRAME_SIZE } from '../../lib/constants';
import { providerDisplayName } from '../../lib/provider-list-view';
import { ProviderAvatar } from '../provider-avatar';
import { ProviderProtocolStack } from '../provider-protocol-stack';

interface ProviderMarkProps {
  readonly provider: DashboardProviderSummary;
  readonly pluginIcon: string | undefined;
}

/** The same mark the provider card draws beside its display name. */
export const ProviderMark: React.FC<ProviderMarkProps> = ({ provider, pluginIcon }) => {
  const faded = provider.enabled === false && 'grayscale';
  if (provider.kind === 'invalid') {
    return (
      <AlertTriangle
        style={{ width: PROVIDER_FRAME_SIZE, height: PROVIDER_FRAME_SIZE }}
        className="shrink-0 text-destructive"
        aria-hidden="true"
      />
    );
  }
  if (provider.kind === ProviderKind.Api && provider.protocols.length > 0) {
    return <ProviderProtocolStack protocols={provider.protocols} className={cn('shrink-0', faded)} />;
  }
  return (
    <ProviderAvatar
      name={providerDisplayName(provider)}
      icon={pluginIcon}
      size={PROVIDER_FRAME_SIZE}
      className={cn(faded)}
    />
  );
};
