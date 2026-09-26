import { AioProxyLogo } from '@aio-proxy/brand';
import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@aio-proxy/ui/components/item';
import { Clock, Fingerprint, List, Sparkles, Tag, User } from 'lucide-react';
import { Fragment, useState } from 'react';

import { useAgentAuthorization } from '../../hooks/use-agent-authorization';
import { AgentAuthorizationRequestError } from '../../services/agent-authorizations-service';
import { AgentAuthorizationCodeForm } from './agent-authorization-code-form';
import { AgentAuthorizationCodeHeader } from './agent-authorization-code-header';

const terminalMessage = (status: 'approved' | 'denied' | 'expired' | 'consumed'): string => {
  if (status === 'approved') return m['dashboard.agent_authorization.approved']();
  if (status === 'denied') return m['dashboard.agent_authorization.denied']();
  if (status === 'expired') return m['dashboard.agent_authorization.expired']();
  return m['dashboard.agent_authorization.consumed']();
};

export const AgentAuthorizationPage: React.FC = () => {
  const authorization = useAgentAuthorization();
  const [dismissed, setDismissed] = useState(false);
  const result = dismissed
    ? undefined
    : (authorization.approve.data ?? authorization.deny.data ?? authorization.resolve.data);
  const pending = result?.status === 'pending' ? result : undefined;
  const isPending = authorization.resolve.isPending || authorization.approve.isPending || authorization.deny.isPending;
  const error = authorization.resolve.error ?? authorization.approve.error ?? authorization.deny.error;
  const errorMessage =
    typeof AgentAuthorizationRequestError === 'function' &&
    error instanceof AgentAuthorizationRequestError &&
    error.code === 'authorization_unavailable'
      ? m['dashboard.agent_authorization.password_required']()
      : m['dashboard.agent_authorization.network_error']();
  const details =
    pending === undefined
      ? []
      : [
          { icon: User, label: m['dashboard.agent_authorization.target'](), value: pending.target },
          {
            icon: Fingerprint,
            label: m['dashboard.agent_authorization.installation'](),
            value: pending.installationId,
          },
          { icon: Tag, label: m['dashboard.agent_authorization.version'](), value: pending.adapterVersion },
          {
            icon: Clock,
            label: m['dashboard.agent_authorization.expires'](),
            value: new Date(pending.expiresAt).toLocaleString(),
          },
          { icon: List, label: m['dashboard.agent_authorization.permission_catalog']() },
          { icon: Sparkles, label: m['dashboard.agent_authorization.permission_inference']() },
        ];

  const codeEntry = result === undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-4 py-8">
      <Card className="w-full max-w-sm" size="sm">
        {codeEntry ? (
          <AgentAuthorizationCodeHeader />
        ) : (
          <CardHeader>
            <CardTitle>
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                {m['dashboard.agent_authorization.title']()}
                <AioProxyLogo className="text-xl" />
              </h1>
            </CardTitle>
            {pending === undefined ? null : (
              <CardDescription>{m['dashboard.agent_authorization.pending']()}</CardDescription>
            )}
          </CardHeader>
        )}

        {codeEntry ? (
          <AgentAuthorizationCodeForm
            disabled={isPending}
            errorMessage={error === null || error === undefined ? undefined : errorMessage}
            onSubmit={(userCode) => {
              setDismissed(false);
              authorization.approve.reset();
              authorization.deny.reset();
              authorization.resolve.mutate(userCode);
            }}
          />
        ) : null}

        {pending === undefined ? null : (
          <CardContent>
            <section aria-label={m['dashboard.agent_authorization.permissions_title']()}>
              <ItemGroup className="gap-0">
                {details.map((detail, index) => {
                  const Icon = detail.icon;
                  return (
                    <Fragment key={detail.label}>
                      <Item size="xs">
                        <ItemMedia variant="icon">
                          <Icon />
                        </ItemMedia>
                        <ItemContent>
                          <ItemTitle>{detail.label}</ItemTitle>
                        </ItemContent>
                        {detail.value === undefined ? null : (
                          <ItemContent>
                            <ItemDescription>{detail.value}</ItemDescription>
                          </ItemContent>
                        )}
                      </Item>
                      {index === details.length - 1 ? null : <ItemSeparator className="my-0" />}
                    </Fragment>
                  );
                })}
              </ItemGroup>
            </section>
          </CardContent>
        )}
        {pending === undefined ? null : (
          <CardFooter className="justify-end gap-2">
            <Button variant="outline" disabled={isPending} onClick={() => authorization.deny.mutate(pending.deviceId)}>
              {m['dashboard.agent_authorization.deny']()}
            </Button>
            <Button disabled={isPending} onClick={() => authorization.approve.mutate(pending.deviceId)}>
              {m['dashboard.agent_authorization.approve']()}
            </Button>
          </CardFooter>
        )}

        {result !== undefined && result.status !== 'pending' ? (
          <CardContent>
            <p role="status">{terminalMessage(result.status)}</p>
          </CardContent>
        ) : null}
        {result !== undefined && result.status !== 'pending' ? (
          <CardFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDismissed(true);
                authorization.reset();
              }}
            >
              {m['dashboard.agent_authorization.retry']()}
            </Button>
          </CardFooter>
        ) : null}
        {codeEntry || error === null || error === undefined ? null : (
          <CardContent>
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          </CardContent>
        )}
      </Card>
    </main>
  );
};
