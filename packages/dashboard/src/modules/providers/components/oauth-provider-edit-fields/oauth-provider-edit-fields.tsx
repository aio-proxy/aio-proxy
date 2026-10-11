import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthCapability, DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { CircleCheckIcon } from 'lucide-react';

import { PluginIcon } from '@/components/plugin-icon';
import { resolveDashboardText } from '@/lib/localized-text';

import type { OAuthProviderForm } from '../../hooks/use-oauth-provider-form';
import { providerPluginPresentationsQueryOptions } from '../../services/provider-plugin-labels';
import { OAuthAccountFields } from '../oauth-account-fields';
import { OAuthLocalSignInButton } from '../oauth-local-sign-in-button';

interface OAuthProviderEditFieldsProps {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly accountForm: OAuthProviderForm;
  readonly onReauthorize: () => void;
  readonly isReauthorizing: boolean;
  readonly isReauthorizeBlocked: boolean;
  readonly accountLocked?: boolean;
  readonly localSignIn?: DashboardOAuthCapability['localSignIn'];
  readonly onLocalSignIn?: (() => void) | undefined;
}

export const OAuthProviderEditFields: React.FC<OAuthProviderEditFieldsProps> = ({
  provider,
  oauth,
  accountForm,
  onReauthorize,
  isReauthorizing,
  isReauthorizeBlocked,
  accountLocked = false,
  localSignIn,
  onLocalSignIn,
}) => {
  const plugin = (useQuery(providerPluginPresentationsQueryOptions()).data?.plugins ?? []).find(
    (candidate) => candidate.packageName === provider.plugin,
  );
  const pluginLabel = plugin?.displayName === undefined ? provider.plugin : resolveDashboardText(plugin.displayName);
  const serviceLabel = provider.capability === 'default' ? pluginLabel : `${pluginLabel} / ${provider.capability}`;

  return (
    <>
      <dl className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <dt>{m['dashboard.providers.oauth.service_label']()}</dt>
        <dd className="flex min-w-0 items-center gap-2 font-medium text-foreground">
          {plugin?.icon === undefined ? null : <PluginIcon icon={plugin.icon} size={16} className="shrink-0" />}
          <span className="min-w-0 break-all">{serviceLabel}</span>
        </dd>
      </dl>
      <OAuthAccountFields fields={oauth.form} form={accountForm} locked={accountLocked} />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onReauthorize}
          disabled={isReauthorizing || isReauthorizeBlocked || accountLocked}
        >
          {m['dashboard.providers.oauth.reauthorize']()}
        </Button>
        {localSignIn === undefined ? null : (
          <OAuthLocalSignInButton
            source={localSignIn.source}
            disabled={isReauthorizing || isReauthorizeBlocked || accountLocked || onLocalSignIn === undefined}
            onConfirm={onLocalSignIn ?? (() => undefined)}
          />
        )}
        <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CircleCheckIcon className="size-4 text-primary" />
          {m['dashboard.providers.oauth.connected_account']({ account: oauth.accountLabel })}
        </p>
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.reauthorize_helper']()}</p>
      </div>
    </>
  );
};
