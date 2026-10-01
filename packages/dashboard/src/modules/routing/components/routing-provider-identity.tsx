import { ProviderKind } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { ProviderAvatar } from '@/components/provider-avatar';
import type { ProviderLabelView } from '@/components/provider-label';
import { ProviderMark } from '@/components/provider-mark';
import { PROVIDER_FRAME_SIZE } from '@/lib/provider-frame';

interface RoutingProviderIdentityProps {
  readonly view: ProviderLabelView;
  /** Dims the mark and drops the weight, for a Provider that takes no traffic. */
  readonly muted?: boolean;
  /** Drops the account or package line where only the name fits. */
  readonly compact?: boolean;
}

/**
 * OAuth Providers are recognized by service first and account second; AI SDK Providers by name and
 * package. API Providers go by name alone: the protocol is plumbing, not identity.
 */
const identity = (view: ProviderLabelView): { readonly title: string; readonly detail: React.ReactNode } => {
  const provider = view.provider;
  if (provider?.kind === ProviderKind.OAuth) {
    // The service leads even when a name is configured: OAuth names are usually the account itself,
    // and a list of bare emails hides which upstream each one is.
    const title = view.oauthService ?? view.name;
    const detail = provider.name ?? view.accountLabel;
    return { title, detail: detail === title ? undefined : detail };
  }
  if (provider?.kind === ProviderKind.AiSdk) return { title: view.name, detail: provider.packageName };
  return { title: view.name, detail: undefined };
};

/** Mark, title and detail of a Provider as inline siblings; the caller supplies the flex container. */
export const RoutingProviderIdentity: React.FC<RoutingProviderIdentityProps> = ({
  view,
  muted = false,
  compact = false,
}) => {
  const { title, detail } = identity(view);
  return (
    <>
      <span className={cn('inline-flex shrink-0', muted && 'opacity-50')}>
        {view.provider === undefined ? (
          <ProviderAvatar name={view.name} icon={undefined} size={PROVIDER_FRAME_SIZE} />
        ) : (
          <ProviderMark provider={view.provider} pluginIcon={view.pluginIcon} />
        )}
      </span>
      {/* The detail gives up its room first; the title only truncates once it alone would overflow. */}
      <span
        className={cn(
          'truncate',
          compact || detail === undefined ? 'min-w-0' : 'max-w-2/3 shrink-0',
          !muted && 'font-medium',
        )}
      >
        {title}
      </span>
      {compact || detail === undefined ? null : (
        <span className="max-w-[22ch] min-w-0 truncate text-muted-foreground">{detail}</span>
      )}
    </>
  );
};
