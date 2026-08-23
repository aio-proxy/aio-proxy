import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthSession } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Spinner } from '@aio-proxy/ui/components/spinner';
import { toast } from '@aio-proxy/ui/components/toast';
import { useForm } from '@tanstack/react-form';
import { useEffect, useRef } from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { OAuthAuthorizationUrlField } from './oauth-authorization-url-field';

interface OAuthAuthorizationPanelProps {
  readonly session: DashboardOAuthSession;
  readonly onSubmitCallback: (callbackUrl: string) => void;
  readonly onCancel: () => void;
  readonly isPending: boolean;
}

const authorizationUrl = (session: DashboardOAuthSession): string | undefined => {
  if (session.status === 'device_code' || session.status === 'authorize_url') return session.url;
  if (session.status === 'loopback') return session.authorizationUrl;
  return undefined;
};

export const OAuthAuthorizationPanel: React.FC<OAuthAuthorizationPanelProps> = ({
  session,
  onSubmitCallback,
  onCancel,
  isPending,
}) => {
  const callbackForm = useForm({
    defaultValues: { callbackUrl: '' },
    onSubmit: ({ value }) => {
      onSubmitCallback(value.callbackUrl);
      callbackForm.reset();
    },
  });
  let failedMessage: string | undefined;
  if (session.status === 'failed') {
    if (session.code === 'OAUTH_SESSION_UNAVAILABLE')
      failedMessage = m['dashboard.providers.oauth.session_unavailable']();
    else if (session.code === 'PROVIDER_FINGERPRINT_MISMATCH') {
      failedMessage = m['dashboard.providers.oauth.fingerprint_mismatch']();
    } else {
      failedMessage = m['dashboard.providers.oauth.failed']({ code: session.code });
    }
  }

  const presentedUrl = useRef<string | undefined>(undefined);
  const url = authorizationUrl(session);
  useEffect(() => {
    if (url === undefined || presentedUrl.current === url) return;
    presentedUrl.current = url;
    if (session.status === 'device_code') {
      void navigator.clipboard.writeText(session.userCode).then(
        () => toast.add({ type: 'success', title: m['dashboard.providers.oauth.copied_device_code']() }),
        () => undefined,
      );
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, [session, url]);

  return (
    <div className="space-y-4 rounded-2xl bg-input/50 p-4">
      {session.status === 'preparing' || session.status === 'discovering' ? (
        <div className="flex items-center gap-2">
          <Spinner /> {m['dashboard.providers.oauth.preparing']()}
        </div>
      ) : null}
      {session.status === 'device_code' ? (
        <div className="space-y-3">
          <h2 className="font-semibold">{m['dashboard.providers.oauth.device_code_title']()}</h2>
          <code className="block text-lg">{session.userCode}</code>
          <OAuthAuthorizationUrlField url={session.url} />
        </div>
      ) : null}
      {session.status === 'authorize_url' ? (
        <div className="space-y-3">
          <h2 className="font-semibold">{m['dashboard.providers.oauth.authorize_url_title']()}</h2>
          {session.instructions === undefined ? null : <p>{resolveDashboardText(session.instructions)}</p>}
          <OAuthAuthorizationUrlField url={session.url} />
        </div>
      ) : null}
      {session.status === 'loopback' ? (
        <div className="space-y-3">
          <h2 className="font-semibold">{m['dashboard.providers.oauth.loopback_title']()}</h2>
          <OAuthAuthorizationUrlField url={session.authorizationUrl} />
          {session.allowManualCallback ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void callbackForm.handleSubmit();
              }}
            >
              <callbackForm.Field name="callbackUrl">
                {(field) => (
                  <Field>
                    <Label htmlFor={field.name}>{m['dashboard.providers.oauth.manual_callback_label']()}</Label>
                    <Input
                      id={field.name}
                      value={field.state.value}
                      placeholder={m['dashboard.providers.oauth.manual_callback_placeholder']()}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </Field>
                )}
              </callbackForm.Field>
              <Button type="submit" disabled={isPending}>
                {m['dashboard.providers.oauth.submit_callback']()}
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {session.status === 'failed' ? <p className="text-destructive">{failedMessage}</p> : null}
      {session.status === 'cancelled' ? <p>{m['dashboard.providers.oauth.authorization_cancelled']()}</p> : null}
      {session.status === 'succeeded' && session.duplicate ? <p>{m['dashboard.providers.oauth.duplicate']()}</p> : null}
      {session.status === 'succeeded' && session.warning === 'catalog_unavailable' ? (
        <p>{m['dashboard.providers.oauth.catalog_warning']()}</p>
      ) : null}
      {session.status === 'preparing' ||
      session.status === 'device_code' ||
      session.status === 'authorize_url' ||
      session.status === 'loopback' ||
      session.status === 'discovering' ? (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {m['dashboard.providers.oauth.cancel']()}
        </Button>
      ) : null}
      {session.status === 'failed' || session.status === 'cancelled' ? (
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {m['dashboard.providers.oauth.start_over']()}
        </Button>
      ) : null}
    </div>
  );
};
