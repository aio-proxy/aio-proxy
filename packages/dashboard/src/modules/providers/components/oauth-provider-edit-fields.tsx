import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';

import type { OAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { OAuthAccountFields } from './oauth-account-fields';

interface OAuthProviderEditFieldsProps {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly accountForm: OAuthProviderForm;
  readonly onReauthorize: () => void;
  readonly isReauthorizing: boolean;
}

export const OAuthProviderEditFields: React.FC<OAuthProviderEditFieldsProps> = ({
  provider,
  oauth,
  accountForm,
  onReauthorize,
  isReauthorizing,
}) => (
  <>
    <dl className="grid gap-4 sm:grid-cols-2">
      <div>
        <dt className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.service_label']()}</dt>
        <dd className="mt-1 text-sm font-medium break-all">
          {provider.plugin} / {provider.capability}
        </dd>
      </div>
      <div>
        <dt className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.account_label']()}</dt>
        <dd className="mt-1 text-sm font-medium break-all">{oauth.accountLabel}</dd>
      </div>
    </dl>
    <OAuthAccountFields fields={oauth.form} form={accountForm} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.reauthorize_helper']()}</p>
      <Button type="button" variant="outline" onClick={onReauthorize} disabled={isReauthorizing}>
        {m['dashboard.providers.oauth.reauthorize']()}
      </Button>
    </div>
  </>
);
