import { type DashboardProviderSummary, ProviderKind } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import { AlertTriangle, Package, Plug } from 'lucide-react';

import { ProviderAvatar } from '@/components/provider-avatar';
import { providerDisplayName } from '@/lib/provider-display-name';
import { PROVIDER_FRAME_SIZE } from '@/lib/provider-frame';

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
  if (provider.kind === ProviderKind.Api || provider.kind === ProviderKind.AiSdk) {
    // Neither kind has plugin artwork. A name's first letter reads as a broken logo, and protocol
    // logos read as the upstream vendor, which a third-party gateway is not. The glyph says only what
    // kind of Provider this is; protocols and packages are spelled out in text beside it.
    const Glyph = provider.kind === ProviderKind.Api ? Plug : Package;
    return (
      <span
        aria-hidden="true"
        data-testid="provider-kind-mark"
        style={{ width: PROVIDER_FRAME_SIZE, height: PROVIDER_FRAME_SIZE }}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground',
          faded,
        )}
      >
        <Glyph className="size-3.5" />
      </span>
    );
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
