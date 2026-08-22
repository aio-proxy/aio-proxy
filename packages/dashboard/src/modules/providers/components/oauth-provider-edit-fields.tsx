import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { CircleCheckIcon } from 'lucide-react';

import type { OAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { OAuthAccountFields } from './oauth-account-fields';

interface OAuthProviderEditFieldsProps {
  readonly provider: OAuthProvider;
  readonly oauth: DashboardOAuthProviderEdit;
  readonly accountForm: OAuthProviderForm;
  readonly onReauthorize: () => void;
  readonly isReauthorizing: boolean;
  readonly isReauthorizeBlocked: boolean;
}

export const OAuthProviderEditFields: React.FC<OAuthProviderEditFieldsProps> = ({
  provider,
  oauth,
  accountForm,
  onReauthorize,
  isReauthorizing,
  isReauthorizeBlocked,
}) => (
  <>
    {/* One muted line, not a two-column table: the only thing the editor cannot show elsewhere is
        which service this provider is bound to. The account name is the status row's job below. */}
    <dl className="flex flex-wrap items-baseline gap-2 text-sm text-muted-foreground">
      <dt>{m['dashboard.providers.oauth.service_label']()}</dt>
      <dd className="font-medium break-all">
        {provider.plugin} / {provider.capability}
      </dd>
    </dl>
    <OAuthAccountFields fields={oauth.form} form={accountForm} />
    {/* Same shape as the create row in connection-section.tsx: the button first, at the same `sm`
        size, then the text beside it. `justify-between` used to throw the button to the far edge of
        the card, away from the copy explaining it. */}
    <div className="flex flex-wrap items-center gap-3">
      {/* Reauthorizing saves the provider on the way out, so it refuses while a section blocks the save.
          Disabled rather than silently returning: the footer already names the sections at fault. */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onReauthorize}
        disabled={isReauthorizing || isReauthorizeBlocked}
      >
        {m['dashboard.providers.oauth.reauthorize']()}
      </Button>
      {/* The section's only positive signal that this provider is connected, and the only one a
          screen reader is told about. `reauthorize_helper` beside it is about save semantics, so it
          cannot double as one. */}
      <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CircleCheckIcon className="size-4 text-primary" />
        {m['dashboard.providers.oauth.connected_account']({ account: oauth.accountLabel })}
      </p>
      <p className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.reauthorize_helper']()}</p>
    </div>
  </>
);
